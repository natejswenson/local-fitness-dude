"""Security regression tests — path traversal, auth gate, rate limit.

These are the issues found in the 2026-05-04 audit. Each test pins down
the specific failure mode so a future refactor can't quietly reintroduce
the bug.
"""
from __future__ import annotations

import importlib
import sqlite3

import httpx
import pytest

from local_fitness import db


@pytest.fixture
def anyio_backend() -> str:
    """anyio's pytest plugin needs this to know which backend to drive."""
    return "asyncio"


@pytest.fixture
def hermetic_db(tmp_path, monkeypatch):
    """Point the server at a schema-initialized temp DB.

    The routes call `db.connect()` (no path) → `db.DEFAULT_DB_PATH`, resolved
    live per request. Without this, the auth/route tests silently depended on
    a developer's real `data/fitness.db` and exploded in CI with
    `no such table: daily_metrics` (the failing path raises straight through
    httpx.ASGITransport rather than becoming a 500).
    """
    db_path = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", db_path)
    db.init_schema(db_path)
    return db_path


@pytest.fixture
def app_with_token(monkeypatch, hermetic_db):
    """Load the server with a fixed API token so the auth middleware is on.

    Reload after env mutation because module import already captured
    `API_TOKEN` from os.environ at import time.
    """
    monkeypatch.setenv("LOCAL_FITNESS_API_TOKEN", "test-token-fixed")
    from local_fitness.web import server as srv
    importlib.reload(srv)
    yield srv
    monkeypatch.delenv("LOCAL_FITNESS_API_TOKEN", raising=False)
    importlib.reload(srv)


@pytest.fixture
def app_no_token(monkeypatch, hermetic_db):
    """Server without auth (covers the loopback-only / dev path)."""
    monkeypatch.delenv("LOCAL_FITNESS_API_TOKEN", raising=False)
    from local_fitness.web import server as srv
    importlib.reload(srv)
    return srv


@pytest.mark.anyio
async def test_spa_fallback_blocks_path_traversal(app_no_token, monkeypatch):
    """Confirmed exploit from the 2026-05-04 audit: GET /../../pyproject.toml
    used to return 200 with the file. The fix resolves the candidate path
    and rejects any escape from WEB_DIST. We probe via raw ASGI with `..`
    segments preserved (httpx's outer client normalizes; the ASGI scope
    skips that and reaches the route handler with the raw path).
    """
    if not app_no_token.WEB_DIST.exists():
        pytest.skip("web/dist not built — run `cd web && pnpm build` first")

    async def asgi_get(path: str) -> tuple[int, bytes]:
        body_chunks: list[bytes] = []
        status_code = {"v": 0}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(msg):
            if msg["type"] == "http.response.start":
                status_code["v"] = msg["status"]
            elif msg["type"] == "http.response.body":
                body_chunks.append(msg.get("body", b""))

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("utf-8"),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
        }
        await app_no_token.app(scope, receive, send)
        return status_code["v"], b"".join(body_chunks)

    # Each of these would have served arbitrary disk content pre-fix.
    for traversal in [
        "/../../pyproject.toml",
        "/../../../README.md",
        "/foo/../../../README.md",
        "/../../data/fitness.db",
        "/../../.env",
    ]:
        status, body = await asgi_get(traversal)
        # The handler now returns the SPA index.html (HTML) on traversal
        # rather than the requested file. Confirm: 200, but body is the
        # SPA shell (small) rather than e.g. pyproject.toml (~700 bytes
        # of TOML) or README.md (~6 KB of markdown starting with `#`).
        assert status == 200, f"{traversal} returned {status}"
        assert b"[project]" not in body, f"{traversal} leaked pyproject.toml"
        assert b"# local-fitness" not in body, f"{traversal} leaked README.md"
        assert body.lstrip().startswith(b"<!"), (
            f"{traversal} returned non-HTML body — possible regression"
        )


@pytest.mark.anyio
async def test_api_requires_bearer_when_token_set(app_with_token):
    transport = httpx.ASGITransport(app=app_with_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        # No token → 401 on /api/* (except /health and /api/auth/verify)
        r = await c.get("/api/today")
        assert r.status_code == 401
        # Wrong token → 401
        r = await c.get("/api/today", headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401
        # Correct token → not 401 (may be 500 on empty DB but auth passed)
        r = await c.get("/api/status", headers={"Authorization": "Bearer test-token-fixed"})
        assert r.status_code != 401, f"correct token still got {r.status_code}: {r.text}"


@pytest.mark.anyio
async def test_mcp_endpoint_requires_bearer(app_with_token):
    """The MCP server at /mcp/ lives OUTSIDE /api/ but must be auth-gated —
    _is_public_path defaults non-/api/ paths to public, so a regression that
    drops the explicit /mcp gate would silently expose the whole tool surface.
    The 401 short-circuits in the bearer middleware before the mount, so no
    session-manager lifespan is needed here."""
    transport = httpx.ASGITransport(app=app_with_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        assert r.status_code == 401, f"/mcp/ not gated: {r.status_code}"
        r = await c.post("/mcp/", headers={"Authorization": "Bearer wrong"},
                         json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        assert r.status_code == 401
        # bare /mcp (no slash) is also gated
        r = await c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        assert r.status_code == 401


@pytest.mark.anyio
async def test_mcp_write_tool_requires_bearer(app_with_token):
    """A WRITE tool call (log_observation) over /mcp without the bearer token
    must 401 in the middleware BEFORE the MCP mount dispatches it — so an
    unauthenticated client can never mutate the DB. The middleware short-circuits
    before the session manager, so no lifespan is needed."""
    transport = httpx.ASGITransport(app=app_with_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "log_observation",
                "arguments": {"obs_type": "weight", "value": 165},
            },
        }
        r = await c.post("/mcp/", json=body)
        assert r.status_code == 401, f"unauthed write tool not gated: {r.status_code}"
        r = await c.post("/mcp/", headers={"Authorization": "Bearer wrong"}, json=body)
        assert r.status_code == 401


@pytest.mark.anyio
async def test_health_is_public(app_with_token):
    transport = httpx.ASGITransport(app=app_with_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_auth_verify_path_is_public(app_with_token):
    """The login screen needs to probe with whatever token the user typed,
    so the verify endpoint must reach the auth middleware as a normal
    request (it returns 401 on bad tokens, 200 on good ones)."""
    transport = httpx.ASGITransport(app=app_with_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/api/auth/verify")
        assert r.status_code == 401
        r = await c.get(
            "/api/auth/verify",
            headers={"Authorization": "Bearer test-token-fixed"},
        )
        assert r.status_code == 200
        assert r.json() == {"ok": True, "auth_required": True}


@pytest.mark.anyio
async def test_dashboards_require_auth(app_with_token):
    """All three dashboard endpoints land under /api/, so the bearer
    middleware should gate them automatically. Pinning the contract so
    a future endpoint move can't quietly drop auth."""
    transport = httpx.ASGITransport(app=app_with_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        for path in (
            "/api/activity-heatmap",
            "/api/strength-volume",
            "/api/pace-efficiency",
        ):
            r = await c.get(path)
            assert r.status_code == 401, f"{path} returned {r.status_code}"
            r = await c.get(
                path, headers={"Authorization": "Bearer test-token-fixed"}
            )
            assert r.status_code == 200, f"{path} with token returned {r.status_code}: {r.text}"
            body = r.json()
            assert "values" in body, f"{path} response missing `values`: {body}"


@pytest.mark.anyio
async def test_security_headers_present(app_no_token):
    transport = httpx.ASGITransport(app=app_no_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/health")
        assert r.headers.get("x-content-type-options") == "nosniff"
        assert r.headers.get("x-frame-options") == "DENY"
        assert r.headers.get("referrer-policy") == "no-referrer"
        # Hardening: no stack disclosure, and HSTS present.
        assert r.headers.get("server") == "fitness"
        assert "max-age=" in r.headers.get("strict-transport-security", "")


@pytest.mark.anyio
async def test_csp_blocks_inline_scripts(app_no_token):
    """AI-authored plan strings render in the SPA; a strict script-src is the
    defense-in-depth against a stored-XSS / token-theft sink."""
    transport = httpx.ASGITransport(app=app_no_token.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/health")
        csp = r.headers.get("content-security-policy", "")
        assert "script-src 'self'" in csp
        assert "'unsafe-inline'" not in csp.split("style-src")[0]  # not on script-src


@pytest.mark.anyio
async def test_plan_endpoints_require_auth(app_with_token):
    """GET/commit/delete on /api/plan must be bearer-gated by the middleware,
    and the int path param must reject non-int (no injection surface)."""
    transport = httpx.ASGITransport(app=app_with_token.app)
    tok = {"Authorization": "Bearer test-token-fixed"}
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        # GET
        assert (await c.get("/api/plan")).status_code == 401
        assert (await c.get("/api/plan", headers=tok)).status_code == 200
        # commit
        assert (await c.post("/api/plan/1/commit")).status_code == 401
        # with token: 404 (no such plan) — auth passed, not 401
        assert (await c.post("/api/plan/1/commit", headers=tok)).status_code == 404
        # delete
        assert (await c.delete("/api/plan/1")).status_code == 401
        # non-int path param rejected (422) once authed
        assert (await c.post("/api/plan/abc/commit", headers=tok)).status_code == 422


def test_plan_components_have_no_raw_html_sink():
    """AI-authored plan strings (title/description/ability_snapshot) must never
    reach dangerouslySetInnerHTML — escaped JSX text only (design H1)."""
    from pathlib import Path

    web_src = Path(__file__).resolve().parent.parent / "web" / "src"
    plan_file = web_src / "components" / "TrainingPlan.tsx"
    assert plan_file.exists(), "TrainingPlan.tsx not found"
    assert "dangerouslySetInnerHTML" not in plan_file.read_text()


def test_serve_refuses_non_loopback_without_token(monkeypatch):
    """Startup safety: binding to 0.0.0.0 without a token must hard-fail
    (the whole point of the audit)."""
    monkeypatch.delenv("LOCAL_FITNESS_API_TOKEN", raising=False)
    from local_fitness.web import server as srv
    importlib.reload(srv)
    with pytest.raises(SystemExit):
        srv.serve(host="0.0.0.0", port=18999)


# --- run_sql read-only enforcement (FATAL from the 2026-06 audit) -------------
#
# The old guard scanned for space-padded keywords (`" delete "`) after a
# startswith("with"|"select") gate. A `WITH ... \ndelete\nfrom ...` payload
# slipped both checks and committed on a read-WRITE connection. The fix opens
# run_sql on an engine-level read-only connection so ANY write fails regardless
# of phrasing. These tests pin that down so a refactor can't reintroduce it.


@pytest.fixture
def run_sql_db(tmp_path, monkeypatch):
    """A schema-initialized temp DB with one observation row, wired so that
    db.connect() / db.connect_readonly() (no path) both resolve to it."""
    from local_fitness import db as dbmod

    db_path = tmp_path / "fitness.db"
    monkeypatch.setattr(dbmod, "DEFAULT_DB_PATH", db_path)
    dbmod.init_schema(db_path)
    with dbmod.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO observations "
            "(observed_on, created_at, obs_type, value_num, value_text, activity_id) "
            "VALUES ('2026-01-01', '2026-01-01T00:00:00', 'weight', 165, NULL, NULL)"
        )
    return db_path


def _obs_count(db_path) -> int:
    from local_fitness import db as dbmod

    with dbmod.connect(db_path) as conn:
        return conn.execute("SELECT COUNT(*) AS c FROM observations").fetchone()["c"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    [
        # WITH-prefixed write with newline/tab after the keyword — the exact
        # denylist bypass from the audit. Must NOT mutate the DB.
        "WITH a AS (SELECT 1)\ndelete\nfrom observations",
        "WITH a AS (SELECT 1)\tinsert into observations (observed_on, created_at, "
        "obs_type, value_num) values ('2026-02-02','2026-02-02T00:00:00','weight',1)",
        "WITH a AS (SELECT 1)\nupdate observations set value_num = 999",
    ],
)
async def test_run_sql_write_attempts_do_not_mutate(run_sql_db, payload):
    from local_fitness.agent import tools

    before = _obs_count(run_sql_db)
    result = await tools.run_sql.handler({"query": payload})
    # Either the denylist rejects it up front, or the read-only connection does.
    # Both surface as is_error; what matters is the row count is unchanged.
    assert result.get("is_error") is True, f"write payload not rejected: {result}"
    assert _obs_count(run_sql_db) == before, f"DB mutated by: {payload!r}"


@pytest.mark.anyio
async def test_run_sql_readonly_blocks_write_that_slips_denylist(run_sql_db):
    """Defense-in-depth check: the read-only connection itself (db.connect_readonly)
    rejects a write that the keyword denylist never sees, raising rather than
    committing. We exercise the engine gate directly so the test can't pass just
    because the denylist happened to catch the phrasing."""
    from local_fitness import db as dbmod

    before = _obs_count(run_sql_db)
    with pytest.raises(sqlite3.OperationalError) as exc:
        with dbmod.connect_readonly(run_sql_db) as conn:
            conn.execute("DELETE FROM observations")
    assert "readonly" in str(exc.value).lower()
    assert _obs_count(run_sql_db) == before


@pytest.mark.anyio
async def test_run_sql_bounds_long_query_by_deadline(run_sql_db, monkeypatch):
    """A heavy recursive CTE must return the time-budget error rather than hang
    the event loop. We force a tiny deadline so the test needs no real sleep:
    the progress handler trips on the first check and SQLite raises
    OperationalError('interrupted'), mapped to a clean budget message."""
    from local_fitness.agent import tools

    # Negative budget => the deadline is already in the past => the progress
    # handler aborts on its first invocation.
    monkeypatch.setattr(tools, "_RUN_SQL_TIME_BUDGET_S", -1.0)
    monkeypatch.setattr(tools, "_RUN_SQL_PROGRESS_OPS", 1)
    heavy = (
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) "
        "SELECT x FROM c"
    )
    result = await tools.run_sql.handler({"query": heavy})
    assert result.get("is_error") is True
    assert "time budget" in result["content"][0]["text"]


def test_is_public_path_uppercase_api_not_public():
    """Case-insensitivity regression: GET /API/TODAY matches no real API route
    and would fall to the SPA catch-all — but the auth gate must still treat it
    as NON-public so router and gate agree on case."""
    from local_fitness.web import server as srv

    assert srv._is_public_path("/API/TODAY") is False
    assert srv._is_public_path("/Api/Plan") is False
    assert srv._is_public_path("/MCP/") is False
    # Legitimate public paths still public.
    assert srv._is_public_path("/health") is True
    assert srv._is_public_path("/") is True
    assert srv._is_public_path("/assets/index.js") is True
