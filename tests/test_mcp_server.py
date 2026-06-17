"""Tests for the standalone MCP server (web/mcp_server.py).

Each test pins one of the SDK-level gotchas the design's red-team verified:
F1 (schema serialization), S1 (tool-call content shape), F3 (SPA catch-all
must not shadow /mcp/), the auth gate, and the DNS-rebinding Host allowlist.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from mcp import types

from local_fitness import db
from local_fitness.agent import tools as agent_tools
from local_fitness.web import mcp_server


def _seed_db() -> Path:
    p = Path(tempfile.mkdtemp()) / "fitness.db"
    db.DEFAULT_DB_PATH = p
    db.init_schema(p)
    with db.connect(p) as conn:
        conn.execute(
            "INSERT INTO daily_metrics (date, steps, rhr, sleep_seconds) VALUES (?,?,?,?)",
            ("2026-06-15", 11000, 50, 27000),
        )
    return p


# --- F1: every tool is exposed and tools/list JSON-serializes -------------

def test_all_tools_exposed_and_list_serializes():
    server = mcp_server.build_server()
    handler = server.request_handlers[types.ListToolsRequest]
    res = asyncio.run(handler(types.ListToolsRequest(method="tools/list")))
    served = {t.name for t in res.root.tools}
    assert served == {t.name for t in agent_tools.ALL_TOOLS}
    # The F1 regression: raw-Python-type shorthand schemas must serialize.
    dumped = res.root.model_dump_json()
    assert '"inputSchema"' in dumped
    gm = next(t for t in res.root.tools if t.name == "get_metric")
    assert gm.inputSchema["properties"]["metric"] == {"type": "string"}
    assert gm.inputSchema["properties"]["days"] == {"type": "integer"}


# --- S1: tools/call returns correct unwrapped text content ----------------

def test_tool_call_returns_unwrapped_content():
    _seed_db()
    server = mcp_server.build_server()
    handler = server.request_handlers[types.CallToolRequest]
    req = types.CallToolRequest(
        method="tools/call",
        params=types.CallToolRequestParams(name="get_today_status", arguments={}),
    )
    res = asyncio.run(handler(req))
    result = res.root  # CallToolResult
    assert result.isError is not True
    assert result.content and result.content[0].type == "text"
    payload = json.loads(result.content[0].text)
    assert "recent_days" in payload  # the real handler's shape, not re-wrapped


# --- allowed_hosts env parsing --------------------------------------------

def test_allowed_hosts_default_includes_served_host(monkeypatch):
    monkeypatch.delenv("LOCAL_FITNESS_MCP_ALLOWED_HOSTS", raising=False)
    assert "fitness.home.local" in mcp_server.allowed_hosts()
    monkeypatch.setenv("LOCAL_FITNESS_MCP_ALLOWED_HOSTS", "a.local, b.local")
    assert mcp_server.allowed_hosts() == ["a.local", "b.local"]


# --- Integration: mount + lifespan + auth + Host (F3, auth, 421) ----------

def _make_app(token: str | None, hosts: list[str]):
    from contextlib import asynccontextmanager

    import secrets

    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, PlainTextResponse

    _server, manager = mcp_server.build_session_manager(hosts=hosts)

    @asynccontextmanager
    async def lifespan(app):
        async with manager.run():  # REQUIRED — else /mcp 500s
            yield

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        path = request.url.path
        gated = path == "/mcp" or path.startswith("/mcp/")
        if token and gated:
            if not secrets.compare_digest(
                request.headers.get("authorization", ""), f"Bearer {token}"
            ):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

    # F3: mount BEFORE the SPA catch-all so it isn't shadowed.
    app.mount("/mcp", app=manager.handle_request)

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        return PlainTextResponse("SPA-SHELL", media_type="text/html")

    return app


def _init_body() -> str:
    return json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "test", "version": "1"}},
    })


_HDRS = {"Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "Host": "fitness.home.local"}


def test_mcp_requires_token():
    from starlette.testclient import TestClient
    app = _make_app(token="secret", hosts=["fitness.home.local", "testserver"])
    with TestClient(app) as client:
        r = client.post("/mcp/", content=_init_body(), headers=_HDRS)
        assert r.status_code == 401


def test_mcp_initialize_succeeds_with_token_and_host():
    from starlette.testclient import TestClient
    app = _make_app(token="secret", hosts=["fitness.home.local", "testserver"])
    auth = {**_HDRS, "Authorization": "Bearer secret"}
    with TestClient(app) as client:
        r = client.post("/mcp/", content=_init_body(), headers=auth)
        assert r.status_code == 200, r.text          # not 421 (Host ok), not 500 (lifespan ok)
        assert "application/json" in r.headers.get("content-type", "")  # POST-only JSON (S3)


def test_bad_host_is_rejected():
    from starlette.testclient import TestClient
    app = _make_app(token="secret", hosts=["fitness.home.local"])  # testserver NOT allowed
    auth = {**_HDRS, "Authorization": "Bearer secret", "Host": "evil.example.com"}
    with TestClient(app) as client:
        r = client.post("/mcp/", content=_init_body(), headers=auth)
        assert r.status_code == 421  # DNS-rebinding guard fires on disallowed Host


def test_spa_catchall_does_not_shadow_mcp():
    # F3: the /mcp Mount MUST be registered BEFORE the SPA catch-all
    # GET /{full_path:path}, or the catch-all wins for GET /mcp/ and returns
    # the HTML shell. Tested statically (route order) — a live GET to /mcp/
    # would open a non-terminating SSE stream and hang the client.
    from starlette.routing import Mount, Route
    app = _make_app(token=None, hosts=["fitness.home.local"])
    routes = app.router.routes
    mcp_idx = next(i for i, r in enumerate(routes)
                   if isinstance(r, Mount) and r.path == "/mcp")
    catchall_idx = next(i for i, r in enumerate(routes)
                        if isinstance(r, Route) and "{full_path" in r.path)
    assert mcp_idx < catchall_idx, "MCP mount must precede the SPA catch-all"
