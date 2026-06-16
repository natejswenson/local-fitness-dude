---
ticket: "n/a"
title: "Fitness data as an MCP server for interactive Claude sessions"
date: "2026-06-16"
source: "design"
---

# Fitness data as an MCP server

## Why now (and why this, not the local-model migration)

Earlier today we tested moving the brief *off* Claude onto a local model and
it failed — small models fabricate numbers and miss the coach voice. The
lesson: don't fight Claude's strengths. This design does the inverse — it
exposes the fitness data **as an MCP server** so your *interactive* Claude
sessions (Claude Code, Claude Desktop, other local agents) can query it
directly and reason over it with full Claude capability.

It also sidesteps the credit-pool concern that started all this:
**interactive Claude Code is not metered by the Agent-SDK credit bucket** —
only automated `claude -p` / Agent-SDK jobs are. Ad-hoc data analysis through
an MCP server is interactive, so it draws on your normal subscription.

## What we verified (current code + current docs, 2026-06-16)

- The 18 tools in `agent/tools.py` are built with
  `claude_agent_sdk.create_sdk_mcp_server`, which is **in-process only** —
  it cannot be consumed by an external Claude client. But each `@tool` is an
  `SdkMcpTool` exposing `.name / .description / .input_schema / .handler`, so
  the standalone server can **register the same handler bodies** (one source
  of truth).
- The **official `mcp` SDK (v1.27.0) is already an installed dependency**
  (transitive via `claude-agent-sdk`) — **no new dependency**. Its
  `FastMCP.run(transport=...)` supports `stdio | sse | streamable-http`, and
  `FastMCP.streamable_http_app()` returns a Starlette app that mounts into
  the existing FastAPI app.
- **Auth (sourced from Claude Code + MCP docs):** Claude Code connects to a
  remote HTTP MCP server with a **static bearer token** via
  `--header "Authorization: Bearer <token>"`. **OAuth is optional**, and a
  static bearer is MCP-spec-compliant (RFC 6750) when you control both ends.
  So we **reuse the existing `LOCAL_FITNESS_API_TOKEN` gate** — no OAuth
  server. `streamable-http` is the 2026 standard; SSE is deprecated.
- **Security hazard found:** `web/server.py::_is_public_path` returns `True`
  (public) for **any path not under `/api/`**. A naively-mounted `/mcp` would
  be **unauthenticated**. The design MUST explicitly gate `/mcp`.

## Decisions locked

| Dimension | Decision | Rationale |
|---|---|---|
| Transport | **streamable-http**, mounted at `/mcp`; stdio as a free secondary entrypoint | "Stream the data," reach Claude Code + other agents; SSE deprecated |
| Auth | **Reuse `LOCAL_FITNESS_API_TOKEN`** bearer; gate `/mcp` in `_is_public_path` | Claude Code supports static bearer; no OAuth needed; reuses Traefik+middleware |
| Tools | **All 18**, reused from `agent/tools.py` handlers | Single source of truth; plan writes stay DRAFT-only (existing boundary) |
| Deployment | Same container, same Traefik route → `https://fitness.home.local/mcp` | One process, one auth, one TLS endpoint |
| Build dep | None new (`mcp` already installed) | — |

## Architecture

```
Claude Code / Desktop / local agent
        │  MCP over streamable-HTTP, Authorization: Bearer <token>
        ▼
Traefik (TLS, fitness.home.local)  ── existing
        ▼
FastAPI app (web/server.py)        ── existing middleware stack
   ├─ require_api_token  ← extended to gate /mcp
   ├─ rate_limit         ← /mcp optionally added (DB-only, defensive)
   └─ app.mount("/mcp", app=session_manager.handle_request)  ← before SPA catch-all
        ▼
low-level mcp Server + StreamableHTTPSessionManager (web/mcp_server.py) ── NEW
   └─ list_tools/call_tool over the 18 SdkMcpTool handlers from agent/tools.py
        ▼
agent/tools.py handlers → db.connect() → data/fitness.db   ── unchanged
```

**Key property — transport is a runtime choice over one definition.** The
same `build_mcp_server()` runs as:
- `streamable-http` mounted in FastAPI (the deployed, authenticated path), and
- `stdio` via a CLI entrypoint (`fitness mcp-stdio`) for zero-auth laptop-local
  use (Claude Desktop config / `claude mcp add --transport stdio`).

## Components

1. **`web/mcp_server.py` (NEW, ~25 lines — as built).** **REUSE the SDK's
   already-wired server, don't rebuild it.** `agent_tools.make_server()`
   returns a config dict whose `["instance"]` IS a fully-configured low-level
   `mcp.server.lowlevel.Server` — the SDK already ran its own
   `_build_schema()` (converting the `{name: type}` shorthand to valid JSON
   Schema) and content handling at construction. So `build_server()` just
   returns `make_server()["instance"]`, and `build_session_manager()` wraps it
   in a `StreamableHTTPSessionManager(app=server, stateless=True,
   json_response=True, security_settings=TransportSecuritySettings(
   allowed_hosts=...))`. **This dissolves the F1 (schema-serialization) and S1
   (call-tool return-shape) findings entirely** — the SDK's server already does
   both correctly; there is nothing to reimplement. Verified: a `tools/list`
   off the reused server returns all of `ALL_TOOLS` with correct per-tool
   schemas (`get_metric` → `{metric, days}`) and `model_dump_json()` succeeds.

   _(Superseded approach, kept for the record: registering handlers manually on
   a fresh low-level `Server` via `@server.list_tools()`/`@server.call_tool()`
   would have required reimplementing the schema conversion and content unwrap —
   the F1/S1 fixes below. Reuse made all of that unnecessary.)_ The manual path
   would have been:
   - `@server.list_tools()` → returns `types.Tool(name, description,
     inputSchema=<normalized schema>)` per tool. **The schema must be
     NORMALIZED, not passed through** (verified Fatal): the `{name: type}`
     shorthand tools (`get_metric`, `get_metric_trend`, `get_workout_detail`,
     `compare_periods`, `run_sql`, `save_user_note`, `update_user_note`,
     `delete_user_note` — 8 of 18) store `input_schema` as raw Python type
     objects (`{'metric': <class 'str'>}`), which `types.Tool` accepts but then
     **fails to JSON-serialize** (`PydanticSerializationError`), 500-ing
     `tools/list`. The SDK's own `create_sdk_mcp_server` converts via a PRIVATE,
     non-importable `_build_schema()`/`_python_type_to_json_schema()`, so the
     adapter must **reimplement** the str/int/float/bool → JSON-Schema mapping
     (and the empty-`{}` → `{"type":"object","properties":{}}` case for the 5
     no-arg tools). Tools already carrying a full JSON Schema (`type`+
     `properties`) pass through as-is.
   - `@server.call_tool()` → `(name, arguments) -> ...`: dispatch to the
     matching `sdk_tool.handler(arguments)`, then **return an UNWRAPPED
     `list[types.ContentBlock]`** (e.g. `[types.TextContent(type="text",
     text=item["text"])]`) — NOT the raw `{"content":[...]}` dict. (Verified
     Significant: lowlevel `call_tool` treats a returned `dict` as
     `structuredContent` and re-`json.dumps`-indents it, mangling the payload.)
     On an `is_error` payload, return `types.CallToolResult(content=[...],
     isError=True)` — `content` is required (`isError`-only raises
     `ValidationError`). Port the content loop from `create_sdk_mcp_server`'s
     `call_tool`. The low-level `call_tool` validates `arguments` against the
     declared `inputSchema` for free.

   `build_mcp_server(...)` returns the configured `Server` plus its
   `StreamableHTTPSessionManager` (see #2) — NOT a `FastMCP`. The adapter is
   ~40 lines (two handlers + the content unwrap), not a decorator one-liner.
2. **Mount in `web/server.py`.** Mount the session manager's ASGI handler.
   Three verified gotchas are handled here:
   - **(a) lifespan `run()` is mandatory** — `handle_request` raises
     `RuntimeError("Task group is not initialized")` in BOTH stateless and
     stateful modes if `run()` hasn't started, and `app.mount` does NOT start a
     sub-app's lifespan. The parent FastAPI app runs it exactly once.
   - **(b) DNS-rebinding protection** defaults ON with empty `allowed_hosts`,
     returning **421** for `Host: fitness.home.local` behind Traefik. Must pass
     an env-driven `allowed_hosts` allowlist.
   - **(c) trailing slash** — the streamable-http route is `/`; mounted at
     `/mcp` the live path is `/mcp/` (`POST /mcp` → 405/redirect depending on Starlette version). Canonical URL is
     `https://fitness.home.local/mcp/`.

   ```python
   from contextlib import asynccontextmanager
   server, session_manager = build_mcp_server(   # low-level Server + manager
       stateless_http=True, json_response=True,
       allowed_hosts=os.environ.get("LOCAL_FITNESS_MCP_ALLOWED_HOSTS",
                                    "fitness.home.local,127.0.0.1,localhost").split(","),
   )

   @asynccontextmanager
   async def lifespan(app):
       async with session_manager.run():   # REQUIRED — else /mcp 500s; run() once
           yield

   app = FastAPI(lifespan=lifespan, ...)
   # F2: there is NO `.asgi_app`; mount the bound ASGI callable directly.
   # F3: mount BEFORE the SPA catch-all GET /{full_path:path}, or it shadows
   #     GET /mcp/ (returns index.html). Alternatively exclude "mcp/" in the
   #     catch-all the same way "api/" is excluded.
   app.mount("/mcp", app=session_manager.handle_request)   # live path: /mcp/
   ```
3. **Auth gate.** Extend `_is_public_path` to return `False` for `/mcp` and
   `/mcp/*` (explicit gate, not prefix luck). App-level `@app.middleware("http")`
   runs **before** the router dispatches to a mounted sub-app (Starlette runs
   the middleware stack outside the router), so `require_api_token` *does*
   cover `/mcp` — verified. **But** `require_api_token`/`rate_limit` are
   `BaseHTTPMiddleware`, which is known to interfere with streaming responses.
   MCP streamable-http streams (SSE-style) unless `json_response=True`.
   Mitigation: build with **`json_response=True`** so POST tool calls return
   plain JSON. **Caveat (verified): `json_response` only affects POST** — a GET
   to `/mcp/` still opens a `text/event-stream`. We rely on the stateless +
   Claude-Code flow being **POST-only** (no client GET stream), and the
   integration test asserts a `tools/call` returns `content-type:
   application/json`. If any reachable client issues a GET stream, move the
   bearer check to a **pure-ASGI middleware ahead of the mount** (the clean
   long-term fix) rather than the BaseHTTPMiddleware stack.
4. **CLI entrypoint (NEW).** `fitness mcp-stdio` runs the same low-level
   `Server` over the stdio transport (`mcp.server.stdio.stdio_server()` +
   `server.run(...)`) for local, auth-free use. Stdio has no Host header / no
   HTTP, so the DNS-rebinding and trailing-slash gotchas don't apply.
5. **Docs.** `docs/deployment.md`: the `/mcp` route needs no new Traefik
   config (same host). README/`docs`: the `claude mcp add` one-liner.

## Data flow (one tool call)

1. Claude Code sends an MCP `tools/call` over streamable-HTTP to
   `fitness.home.local/mcp` with the bearer header.
2. Traefik terminates TLS → FastAPI. `require_api_token` checks the bearer
   (constant-time) → 401 if absent/wrong.
3. The mounted low-level Server dispatches to the call_tool adapter, which awaits
   the underlying `agent/tools.py` handler → `db.connect()` → SQLite read (or
   a DRAFT-only plan/note write).
4. The handler's JSON-text payload is returned as the MCP tool result; Claude
   reasons over it.

## API surface

```python
# web/mcp_server.py — built on mcp.server.lowlevel.Server (NOT FastMCP)
def build_mcp_server(*, name: str = "fitness", read_only: bool = False,
                     tools: list | None = None,
                     stateless_http: bool = True, json_response: bool = True,
                     allowed_hosts: list[str] | None = None,
                     ) -> tuple[Server, StreamableHTTPSessionManager]: ...
#   list_tools() returns types.Tool(... inputSchema=t.input_schema); call_tool()
#   dispatches to sdk_tool.handler(args) and unwraps content. Returns the Server
#   and a StreamableHTTPSessionManager(app=server, stateless=..., json_response=...,
#   security_settings=TransportSecuritySettings(allowed_hosts=...)).

READ_ONLY_TOOL_NAMES: frozenset[str]   # the 11 read tools, for future scoping

# web/server.py  (additions)
server, session_manager = build_mcp_server()           # see Components #2 snippet
# parent FastAPI lifespan runs `session_manager.run()` (REQUIRED)
# app.mount("/mcp", session_manager.asgi_app)          # live path /mcp/
def _is_public_path(path: str) -> bool: ...            # now also gates /mcp[/...]

# cli.py (addition) — stdio uses a FastMCP wrapper OR Server.run() over stdio_server()
def mcp_stdio() -> None: ...   # low-level Server over stdio_server(); run(read,write,server.create_initialization_options())
```

MCP tool surface presented to clients = the existing 18 tool names/schemas
verbatim (`get_today_status`, `get_metric`, `query_workouts`,
`training_load_status`, `propose_training_plan` [draft-only], … ).

## Invariants

**Checkable by inspection:**
- Built on `mcp.server.lowlevel.Server` (NOT FastMCP/`add_tool`) so the
  existing `input_schema`s pass through `list_tools()` unchanged.
- The parent FastAPI app's `lifespan` runs `session_manager.run()` exactly once
  — the mount is NOT relied on to start it (the Fatal red-team caught). The
  mounted sub-app's own lifespan never runs.
- The session manager is built with `json_response=True` AND a non-empty
  `allowed_hosts` allowlist including `fitness.home.local` (else 421).
- `/mcp` and `/mcp/*` are NOT public — `_is_public_path("/mcp")` is `False`;
  the canonical client URL is `/mcp/` (trailing slash).
- `web/mcp_server.py` registers tools from `agent_tools.ALL_TOOLS` — it does
  not redefine tool logic or SQL (single source of truth).
- No new third-party dependency (`mcp` already in the lock).
- No MCP tool exists for `commit_plan` / plan activation / hard delete — the
  external surface inherits the DRAFT-only write boundary from `plans.py`.
- The MCP server reads `db.DEFAULT_DB_PATH` (env-overridable) — no hardcoded
  path; a fresh clone works.

**Requires tests:**
- A real MCP `tools/list` + `tools/call` round-trip against the mounted app
  succeeds (proves lifespan/`run()` wiring + the host allowlist — guards the
  Fatal and S1), and `tools/list` returns the CORRECT per-tool `inputSchema`
  (e.g. `get_metric` → `{metric, days}`, NOT `{args}`) — guards the F1 schema
  regression.
- `tools/call` response is `content-type: application/json` (POST-only / S3).
- A request to `/mcp/` without a valid bearer returns 401 when
  `LOCAL_FITNESS_API_TOKEN` is set (add to `tests/test_security.py`).
- With `Host: fitness.home.local`, a `tools/call` returns 200, not 421 (S1).
- Every name in `agent_tools.ALL_TOOLS` appears in the Server's `tools/list`
  output AND that output JSON-serializes (no tool dropped, no schema 500 — F1).
- A representative tool (`get_today_status`) invoked through the low-level
  `call_tool` adapter against a seeded temp DB returns the same payload as
  calling the underlying handler directly.
- `build_mcp_server(read_only=True)` excludes all write tools.

## Failure modes

- **Unauthenticated `/mcp` (HIGH).** Mitigated by the explicit `_is_public_path`
  gate + a `test_security.py` regression. This is the single most important
  guardrail (the audit found one HIGH; we don't add a second).
- **Mount without session lifespan → 500s on EVERY request (was a design
  error; corrected).** `StreamableHTTPSessionManager.handle_request` raises
  `RuntimeError("Task group is not initialized")` if `run()` hasn't started —
  in BOTH stateless and stateful modes (verified in the installed `mcp` SDK).
  Mounting a sub-app does NOT auto-run its lifespan. **Mitigation (required, not
  optional): run `_MCP.session_manager.run()` in the parent FastAPI app's
  `lifespan`** (see Components #2). `stateless_http=True` only drops per-session
  state; it does not remove this requirement. A build that relies on
  `stateless_http` alone to skip lifespan wiring will 500 on the first `/mcp`
  call — this is the single most important correctness item.
- **BaseHTTPMiddleware vs streaming (Significant).** The existing auth +
  rate-limit middleware are `BaseHTTPMiddleware`, which interferes with
  long-lived streaming responses. Mitigation: `json_response=True` makes POST
  tool calls plain JSON. Caveat: GET still streams (see Components #3) — we
  depend on POST-only clients and assert JSON content-type in the test.
- **DNS-rebinding 421 on every request (Significant, verified).** The SDK's
  `StreamableHTTPSessionManager` defaults to
  `enable_dns_rebinding_protection=True` with empty `allowed_hosts`, which
  rejects the `Host: fitness.home.local` header with **421 Misdirected
  Request** before any tool runs. Mitigation: pass
  `TransportSecuritySettings(allowed_hosts=<env list>)` (Components #2); the
  `LOCAL_FITNESS_MCP_ALLOWED_HOSTS` default includes `fitness.home.local`.
  Add to `docs/deployment.md`.
- **Trailing-slash 307 (Significant, verified).** Mounted at `/mcp` with the
  sub-route at `/`, the live endpoint is `/mcp/`; bare `POST /mcp` does not reach the handler. Auth is
  NOT bypassed (the 307 is emitted by the router AFTER the middleware, so an
  unauthenticated `POST /mcp` still 401s). Canonical client URL is `/mcp/`.
- **`run_sql` resource exhaustion (Minor, widened exposure).** `run_sql` allows
  arbitrary SELECT/WITH with only `fetchmany(500)` — a recursive CTE can pin
  CPU and hold the SQLite connection against the daily cron. Existing,
  auth-gated risk, now exposed to "other local agents." Add a `sqlite3`
  interrupt/statement timeout, or exclude `run_sql` from the default external
  set, when this surface widens further.
- **Tool error leakage.** Handlers already return structured `{"error": ...}`
  payloads (not stack traces). Preserve that; never surface raw exceptions.
- **Token absent in container.** `serve()` already refuses non-loopback bind
  without `LOCAL_FITNESS_API_TOKEN`; the mounted `/mcp` inherits that — so the
  HTTP MCP endpoint is never exposed token-less.

## Testing strategy

- Unit (offline, no network): tool-registration parity, read-only subset,
  wrapper-vs-handler payload equality against a seeded temp DB (reuse existing
  tmp-DB fixtures).
- Security: `/mcp` 401-without-token case in `tests/test_security.py`.
- Manual integration: `claude mcp add --transport http fitness
  https://fitness.home.local/mcp/ --header "Authorization: Bearer $TOKEN"`,
  then exercise a few tools from a Claude Code session. Also
  `fitness mcp-stdio` wired into a local Claude Desktop config.
- Coverage gate (43%) must hold; the thin server + security test add coverage.

## Acceptance criteria

- From a Claude Code session, after `claude mcp add ... --header "Authorization:
  Bearer $TOKEN"`, all 18 fitness tools are listed and callable, returning real
  data from `data/fitness.db`.
- `/mcp/` returns 401 without the token (verified by test + by curl), and 200
  (not 421) WITH the token under `Host: fitness.home.local`.
- `fitness mcp-stdio` serves the same tools locally with no auth.
- `uv run pytest -x` green; `score_prompt.py` unaffected; container rebuilds and
  serves `/mcp` behind Traefik.
- No new dependency; no change to `agent/tools.py` tool logic.

## Out of scope (future, explicitly deferred)

- **OAuth 2.1 flow** — only needed to publish a claude.ai *web* Directory
  connector. Static bearer covers Claude Code/Desktop today. Add later if you
  want claude.ai web access; the `auth_server_provider`/`token_verifier`
  FastMCP hooks are the seam.
- **Per-client tool scoping / read-only mode by default** — the `read_only`
  flag and `READ_ONLY_TOOL_NAMES` are built now but v1 exposes all 18; flip
  later if a use case wants a restricted client.
- **MCP Resources / Prompts** (beyond Tools) — e.g. exposing the daily brief as
  an MCP Resource. Natural follow-on; not v1.
- **Rate-limiting `/mcp`** — MCP tools hit SQLite, not Claude, so the
  Claude-cost rate-limit rule doesn't strictly apply; add a defensive bucket
  only if abuse appears.

## Deployment

No new Traefik route — `/mcp/` is the same host (`fitness.home.local`). The
container already sets `LOCAL_FITNESS_API_TOKEN`; the MCP endpoint inherits it.
**New env var:** `LOCAL_FITNESS_MCP_ALLOWED_HOSTS` (comma-separated host
allowlist for the MCP transport's DNS-rebinding guard; default
`fitness.home.local,127.0.0.1,localhost`). Document it in `.env.example` and
the `docs/deployment.md` compose snippet — the container MUST set it to include
the served host or every `/mcp/` call 421s. A version bump + CHANGELOG entry
ships it (per the release policy). Rebuild the container so `/mcp/` goes live.
