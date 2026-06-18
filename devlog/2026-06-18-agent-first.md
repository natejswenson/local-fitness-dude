# 2026-06-18 — Agent-first: an MCP in front of the data, the server out of the synthesis business

local-fitness was already a Claude-powered app — the brief and the coach ran
*inside* the web server via the Agent SDK. This change inverts that: the server
process now holds **no Claude inference at all**. It serves deterministic
compute (baselines, CTL/ATL/TSB, plan grading, today's status) over REST + MCP,
and every act of *synthesis* — the daily brief, conversational coaching, plan
drafting, dashboard insights — moves to a client agent (Claude Code / Desktop /
Mobile) pointed at the fitness MCP.

The cut line that made this tractable: **deterministic compute stays, LLM
synthesis moves.** That's not "data vs logic" — the training-load math is logic,
and it stays server-side as code. Only two modules were genuine server-side LLM
loops (`briefing.py`'s composer and `chat.py`), and only the *interactive* ones
move. The scheduled brief composer stays headless on the server side because a
brief must still be written when the laptop is closed and no MCP client is open.

## Design, gated three times

`/design` produced the architecture doc; the quality gate ran three passes plus
a data-preservation check. The red-team earned its keep:

- I'd assumed the chat was a standalone tab. It isn't — `ChatPanel` is *embedded*
  in three places, and in Training Plan it's the **only** way to create a plan.
  That turned "delete a chat tab" into a real frontend migration and drove the
  decision to fully retire both server loops (Option B) rather than half-measure
  it.
- The brief had a double-write (`generate_and_save` wrote twice). The fix: one
  Claude-free `agent/briefs.py` with `save_brief()` as the single
  validate-then-atomic-write gate, shared by the scheduled composer, the new
  `save_brief` MCP tool, and `ab_brief.py`.
- The MCP `save_brief` tool first returned a pydantic `Brief`, which would have
  broken the JSON text wrapper. Tool returns `{saved,date,path}`; in-process
  callers get the object.

## Shipped, in phases

1. **Additive:** `briefs.py` + `save_brief` tool + a `brief` MCP prompt +
   `/api/brief` `load_latest()` fallback + `GET /api/plan/draft`. 28 new tests.
2. **Frontend → viewer:** Today drops the Generate button / takeaway streaming /
   embedded chat and just renders the agent-written brief; the stale banner is
   now informational. Training Plan becomes review-the-draft + commit/delete.
   Dashboards keep every chart and range toggle, lose the per-panel insight
   chats and the model toggle. `ChatPanel` and `DashboardInsight` deleted.
3. **Backend removals:** `agent/chat.py`, the `/api/chat*` + `/api/brief/generate*`
   endpoints, the `chat`/`ask` CLI commands, `ChatRequest`/`ALLOWED_CHAT_MODELS`,
   and the `claude_agent_sdk` inference imports. The bearer middleware stays;
   `RATE_LIMITED_PREFIXES` is just empty now (re-adding a Claude-cost path is one
   line). The invariant is verifiable: no inference symbols, and no import of the
   Claude-bound composer, in `server.py` or `mcp_server.py`.

The mobile trade is real and accepted: in-app conversational coaching is gone;
on a phone you point Claude Mobile at the LAN MCP instead. One synthesis surface
(the agent) instead of two (agent + server chat).

## The brief is now a scheduled job (it always should have been)

With the server out of inference, the daily brief is a separate process:
`ops/install-launchd.sh` installs a launchd agent that runs `fitness brief` at
06:30 (catch-up at next wake if the Mac slept). The README had referenced
`ops/install-launchd.sh` for ages; the directory never existed. Now it does —
plist template with placeholders filled at install time, so nothing
host-specific is tracked. The job needs only `CLAUDE_CODE_OAUTH_TOKEN` (loaded
from `.env`); it reaches the tools in-process via `make_server()`, so no bearer
token and no allowed-host.

## A container-build yak, shaved

Rebuilding the container surfaced a pre-existing breakage unrelated to the
migration: Vite 8 bundles with **rolldown**, whose native binding is
per-platform, and the build ran on `node:22-alpine` (musl) where the binding
won't resolve. Worse, the corepack-default pnpm (11.8.0) wouldn't install the
linux binding from a macOS-generated lockfile even on Debian. Fix: build the SPA
on `node:22-bookworm-slim`, pin `pnpm@10.33.0` (the host version that resolves
it), declare `supportedArchitectures`, and harden uv/pnpm fetch retries against
a flaky build network.

## Verified

Host: ruff clean, prompt scorer 11/11, 248 tests at 64.6% coverage,
`pnpm tsc --noEmit` + `pnpm build` green. Live container at fitness.home.local:
`/api/chat` and `/api/brief/generate` now 405, `/api/plan/draft` 200,
`/api/brief` 200; all three tabs screenshot-verified as clean viewers with every
chart, takeaway, goal card, and schedule table intact.
