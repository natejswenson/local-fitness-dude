---
ticket: "N/A (interactive design)"
title: "Coach profile carries into tool-driven Claude Code fitness chat (MCP server instructions)"
date: "2026-06-23"
source: "design"
---

# Coach profile in tool-driven Claude Code chat

The 0.10.0 coach tone profiles already reach the two fitness MCP **prompts**
(`/mcp__fitness__coach`, `/mcp__fitness__brief` — verified: `_coach_prompt`
renders the live `hardass` voice). They do **not** reach the **tool-driven**
path: when Claude Code answers a fitness question by calling the MCP tools
(`get_today_status`, `daily_snapshot`, …) rather than the slash command, no
coach persona is in CC's context, so the reply uses CC's default voice.

This closes that gap by advertising the coach persona as the MCP server's
top-level `instructions`, which Claude Code surfaces as persistent context for
the whole connection — so every fitness interaction (tools included) adopts the
profile's tone.

## The change

In `build_server()` (`web/mcp_server.py:335`), after the instance is assembled,
set its `instructions`:

```python
instance.instructions = prompts.system_prompt(_user_name(), coach.resolve_coach_profile())
```

Verified the mechanism exists: `mcp.server.lowlevel.Server` has an
`instructions` constructor param **and** a settable `.instructions` attribute,
and `create_initialization_options()` carries it — so it is advertised in the
MCP initialize handshake (`InitializeResult.instructions`). `build_server()`
already owns the instance (`agent_tools.make_server()["instance"]`), which is
built by `create_sdk_mcp_server` **without** instructions, so setting the
attribute post-construction is the natural seam.

**One source of truth:** the value is the same `prompts.system_prompt(...)` the
brief and the `/coach` prompt already use — automatically profile-aware (the
profile's voice + dials), and carrying the jargon translation, the chat-reply
formatting rules, and the user's saved notes. No new persona text.

## The staleness tradeoff (accepted for v1)

MCP `instructions` resolve **once, at server-build time**. The deployed
streamable-HTTP server is long-lived (built at container start), so after a live
`fitness config set coach_profile …` the **tool-driven** path keeps the old
voice until the MCP server restarts — whereas the **slash-command prompts
re-resolve live** every call. Accepted for v1 because:
- the container is rebuilt on every change (the project's standard workflow), so
  a restart already happens;
- the profile changes rarely;
- reconnecting the MCP in Claude Code also refreshes the advertised instructions.

Documented, not engineered around. Per-session dynamic instructions (re-resolving
on each client connect) is a possible follow-up if the staleness ever bites, but
it requires hooking the session manager and is out of scope (YAGNI).

## API surface

- `web/mcp_server.build_server() -> Server` — unchanged signature; now sets
  `instance.instructions` before returning.
- No new tool, prompt, resource, endpoint, or argument. The MCP initialize
  payload gains the `instructions` string.

## Invariants

Checkable by inspection:
- `build_server()` sets `instance.instructions` to a non-empty string.
- The instructions value is exactly `system_prompt(_user_name(), resolve_coach_profile())`
  — no separate persona text to drift from the brief/slash-command voice.
- No prompt-function edit (`system_prompt`/`briefing_prompt` bodies unchanged) →
  `score_prompt.py` and the brief A/B are unaffected.

Requires tests:
- After `build_server()`, `instance.instructions` is non-empty and contains the
  coaching-voice markers + the CTL/ATL/TSB jargon translation + the
  `mcp__fitness__` tool reference.
- With `coach_profile=hardass` set in the DB, `build_server().instructions`
  contains hardass voice markers (proves the persona reflects the live profile at
  build time); with `supportive`, it does not.
- `instance.create_initialization_options().instructions` is non-empty (the value
  is actually advertised, not just stored).

## Testing strategy

- `uv run pytest -x` — new assertions in `tests/test_mcp_server.py` (or
  `test_coach.py`) for the three cases above; existing MCP-server tests stay green.
- No prompt A/B gate (no prompt edit — `score_prompt.py` unchanged).
- Rebuild the container so the deployed `/mcp/` endpoint advertises the persona;
  optionally confirm via the initialize handshake.

## Obligations

- Version bump (`0.10.0 → 0.11.0`) + CHANGELOG + devlog (functionality change to
  the MCP surface).
- No `.env.example` change (no new env var). No auth/SQL surface → `test_security.py`
  untouched.

## Quality-gate provenance

(Filled in after the `/quality-gate` pass.)
