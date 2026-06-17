---
ticket: "#21"
title: "Make the fitness MCP the primary interface — implementation plan"
date: "2026-06-16"
source: "build"
---

# Implementation Plan — Make the fitness MCP the primary interface (#21)

## Grounding notes (verified against the code)

- `init_schema()` runs `conn.executescript(SCHEMA)` only (db.py:177). The
  `observations` table is idempotent DDL → goes inside `SCHEMA`. The
  `activities.source` ALTER must be a separate guarded Python step after the
  executescript (no `ADD COLUMN IF NOT EXISTS` in SQLite).
- `prompts.system_prompt()` already calls `notes.render_for_prompt()`
  internally (prompts.py:17) and emits the notes section — the `coach` prompt
  must NOT append notes again.
- The brief loop (briefing.py:369-384), chat loop (chat.py:33-40), and web
  agent (server.py:114-123) all set `allowed_tools=allowed_tool_names()`,
  which returns ALL tools. Adding writes to `ALL_TOOLS` auto-exposes them to
  the brief loop unless we split the allow-list.
- `baselines.recompute(through, lookback_days)` seeds EWMA from the earliest
  activity but only WRITES baseline rows in `[today-lookback_days, today]`
  (baselines.py:39,67-69). `RECOMPUTE_LOOKBACK_DAYS = 90`.
- Garmin upsert (`ingest/daily.py:163`, `backfill.py:311`) keys on positive
  `activityId` with `if not activity_id: continue` — negative synthetic ids
  can never collide. **Invariant verified.**
- The lowlevel `Server` exposes `list_prompts` / `get_prompt` /
  `list_resources` / `read_resource` decorators, and `get_capabilities()`
  computes capabilities **dynamically** from `self.request_handlers` at
  initialize time. **Wave-3 spike resolves to: register handlers on
  `make_server()["instance"]`; primary path works; fallback not needed.**
- `/mcp` is gated by `_is_public_path()` (server.py) → token required.
- The metric→baseline-column map is NOT derivable as `f"{metric}_60day_mean"`:
  `avg_stress` → `stress_60day_mean`. Map must be explicit.

## Wave structure (16 tasks + 1 spike gate)

Tasks within a wave are independent. Execution groups by FILE OWNER to avoid
conflicts (tools.py is touched by six tasks → one owner).

### Wave 0 — Foundations
- **W0-T1** — `observations` table inside SCHEMA + guarded `activities.source`
  ALTER after executescript + init_schema-twice idempotency. Files: db.py.
  Tier 3.
- **W0-T2** — `agent/units.py`: `to_miles`, `format_pace_min_per_mi`,
  `format_duration`, `display_units()`; null/0 guards mandatory. Tier 2.
- **W0-T3** — `OBS_TYPES` frozenset + `QUERYABLE_SCHEMA` constant in tools.py;
  run_sql description renders its table list from QUERYABLE_SCHEMA (+observations).
  Tier 2.

### Wave 1 — Read layer
- **W1-T1** — `agent/status.py` `assemble_status()`: per-metric rows tagged
  `treatment ∈ {baseline_delta,trend_arrow,raw}`; baseline deltas ONLY via the
  explicit 5-metric map (rhr, sleep_seconds, avg_stress→stress_60day_mean,
  body_battery_max/min); recent workouts in miles; notes; never raises on empty
  DB. Tier 3. Deps: W0-T1, W0-T2.
- **W1-T2** — `daily_snapshot` tool → `_text(assemble_status())`; append to
  ALL_TOOLS. Tier 2. Deps: W1-T1.
- **W1-T3** — miles fields on query_workouts + get_workout_detail alongside raw;
  km suppresses *_mi. Tier 2. Deps: W0-T2.
- **W1-T4** — `read_only_tool_names()` explicit allow-list (11 existing read
  tools; excludes note-writes, write tools, daily_snapshot, list_observations).
  Tier 3.

### Wave 2 — Write surface
- **W2-T1** — observation tools: log_observation (obs_type validation→_err,
  value_num/value_text by type, default date today, non-null activity_id
  existence check→_err, params via ?), list_observations, delete_observation
  (_err on absent). Append to ALL_TOOLS. Tier 3. Deps: W0-T1, W0-T3.
- **W2-T2** — manual-workout tools: log_manual_workout (synthetic id
  MIN(MIN(activity_id),0)-1 + INSERT under BEGIN IMMEDIATE; source='manual';
  NOT NULL date default today; miles→meters; recompute widened
  lookback=max(RECOMPUTE_LOOKBACK_DAYS,(today-date).days+1));
  delete_manual_workout (refuse id>=0→_err, absent→_err; read date→null
  observation refs→delete row→recompute). Append both to ALL_TOOLS. Tier 3.
  Deps: W0-T1, W0-T2, W2-T1.
- **W2-T3** — briefing.py allowed_tools → read_only_tool_names(); chat/web keep
  full set. Tier 3. Deps: W1-T4, W2-T1, W2-T2.

### Wave 3 — MCP prompts + resources (mcp_server.py)
- **W3-SPIKE** — confirm initialize advertises prompts+resources after
  registering handlers on make_server()["instance"]. Primary path only.
- **W3-T1** — `coach` prompt: list_prompts declares coach w/
  PromptArgument(focus, required=False); get_prompt returns one user message
  embedding system_prompt() (notes once) + rendered assemble_status(). Tier 3.
  Deps: W1-T1, spike.
- **W3-T2** — `fitness://schema` (renders QUERYABLE_SCHEMA) +
  `fitness://brief/latest` (glob briefings/*.json, deserialize Brief, render
  markdown, graceful empty). Tier 3. Deps: W0-T3, spike.

### Wave 4 — Tests + docs
- **W4-T1** — test_smoke.py len(ALL_TOOLS) 15→21. Tier 1.
- **W4-T2** — obs + manual round-trip tests. Tier 2.
- **W4-T3** — recompute integration + backdated rewrite + Garmin-re-ingest-
  leaves-manual tests. Tier 3.
- **W4-T4** — empty-DB snapshot + coach-notes-once tests (test_status.py). Tier 2.
- **W4-T5** — migration idempotency test (test_db.py). Tier 2.
- **W4-T6** — write-tool-over-HTTP → 401 security test. Tier 3.
- **W4-T7** — LOCAL_FITNESS_DISPLAY_UNITS in .env.example + docs/deployment.md.
  Tier 1.

## Invariant → task coverage

| Invariant | Task |
|---|---|
| observations grain; obs_type whitelist+_err; OBS_TYPES once | W0-T1, W0-T3, W2-T1 |
| manual id MIN(MIN,0)-1, first=-1, no collision; BEGIN IMMEDIATE | W2-T2 |
| delete_manual_workout refuses id>=0; nulls obs refs; ordering | W2-T2 |
| activity_id soft ref; log_observation existence check | W2-T1 |
| NOT NULL date populated; zero hr_zones/splits → no orphans | W2-T2 |
| brief allowed_tools = read_only_tool_names(); daily_snapshot excluded | W1-T4, W2-T3 |
| baseline deltas only via explicit 5-metric map | W1-T1 |
| read tools add formatted alongside raw; km suppresses *_mi | W1-T1, W1-T3, W0-T2 |
| coach embeds system_prompt(); notes once | W3-T1, W4-T4 |
| prompts/resources under /mcp gated; capabilities dynamic | W3-SPIKE, W3-T1, W3-T2, W4-T6 |
| QUERYABLE_SCHEMA single source; observations queryable | W0-T3, W3-T2 |
| recompute reflects load; backdated rewrites own row; re-ingest safe | W4-T3 |
| obs round-trip; invalid type; absent→_err | W4-T2 |
| daily_snapshot miles+tags match raw; empty DB never raises | W1-T1, W4-T4 |
| init_schema idempotent | W0-T1, W4-T5 |
| write tool over HTTP w/o token → 401 | W4-T6 |
| test_smoke 15→21 | W4-T1 |
| LOCAL_FITNESS_DISPLAY_UNITS env | W0-T2, W1-T3, W4-T7 |

## Verification
- Per wave: targeted `uv run pytest -x tests/<file>`.
- Final: `uv run pytest -x` fully green + `docker compose up -d --build local-fitness`.
- Release policy: feature requires a pyproject version bump + CHANGELOG entry once it lands.
