# 2026-06-16 — Fitness data as an MCP server for interactive Claude

Exposed the fitness tools as a standalone MCP server so my *interactive*
Claude sessions (Claude Code / Desktop, other local agents) can query the
Garmin data directly. This is the inverse of the local-model experiment from
earlier today: instead of moving the brief *off* Claude (which failed — small
models fabricate numbers and miss the coach voice), give interactive Claude
direct data access. It also sidesteps the Agent-SDK credit-pool change, since
interactive Claude Code isn't metered by that bucket.

## What landed

- **`web/mcp_server.py`.** The key move: the brief/chat loop already builds a
  fully-wired low-level `mcp` `Server` via `create_sdk_mcp_server` (in-process
  only — an external client can't reach it). That config dict exposes the
  `Server` instance under `["instance"]`, with the SDK's own schema conversion
  and content handling already correct. So I **reuse that exact server** over a
  new transport (streamable-HTTP for the deployed endpoint, stdio for local) —
  one source of truth, zero schema/handler duplication. It auto-tracks
  `ALL_TOOLS`, so the 3 training-plan tools light up for free once that branch
  merges (on `master` there are 15 tools today).
- **Mounted at `/mcp/`** in the existing FastAPI app, behind the existing
  Traefik route + `LOCAL_FITNESS_API_TOKEN` bearer gate. `fitness mcp-stdio`
  serves the same tools locally with no auth.
- **`LOCAL_FITNESS_MCP_ALLOWED_HOSTS`** env var for the transport's
  DNS-rebinding guard.

## What the quality gate caught (and cost)

I ran `/design` → `/quality-gate` before building, and the gate earned its
keep — three fresh-eyes rounds, all findings empirically verified against the
installed SDK, score trajectory 5 → 6 → 10 (sustained-regression exit). Every
"obvious" integration claim was wrong on first writing and only catchable by
*executing* against the SDK, not by reading:

- `stateless_http=True` does NOT skip the session-manager lifespan — `run()`
  must be entered in the parent app's lifespan or every request 500s
  ("Task group is not initialized"). Mounting alone doesn't start it.
- DNS-rebinding protection is ON by default with an empty host allowlist →
  **every** request 421s behind Traefik until you allowlist the host.
- The SPA catch-all `GET /{full_path:path}` shadows `GET /mcp/` unless the
  mount is registered first (Starlette matches in registration order).
- `json_response=True` only affects POST; GET still opens an SSE stream.

The lesson the gate's own exit encoded: this design couldn't be validated by
inspection, so it was the right call to stop red-teaming the doc and prove
each gotcha with a test instead. Each one is now a passing case in
`tests/test_mcp_server.py` (F1 schema serialization, the tool-call content
shape, the 401 gate, the `initialize` 200 round-trip, the 421 bad-host
rejection, the route-order invariant) plus a `/mcp` auth regression in
`tests/test_security.py`. Full suite green at 46% coverage.

## Wiring it up

```
claude mcp add --transport http fitness \
  https://fitness.home.local/mcp/ --header "Authorization: Bearer $TOKEN"
```
