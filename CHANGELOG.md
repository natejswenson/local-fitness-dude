# Changelog

All notable changes to local-fitness are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-16

### Added
- **`coach` MCP prompt** — `/fitness:coach` in an MCP client assembles the full
  daily snapshot (per-metric vs-baseline read, training load, recent workouts in
  miles) *and* the coach persona + your saved notes server-side, in one
  round-trip with no tool-call latency or server-side Claude cost. The coaching
  synthesis that previously lived only in the brief loop now travels to the MCP.
- **`daily_snapshot` tool** — one call returns the assembled status (collapses
  the get_today_status + training_load_status + query_workouts + notes chain).
- **`fitness://schema` and `fitness://brief/latest` MCP resources** — the
  queryable-column reference (single-sourced from `QUERYABLE_SCHEMA`, so it can't
  drift from `run_sql`) and the most recent saved brief rendered to markdown.
- **Write surface** — `log_observation` / `list_observations` /
  `delete_observation` (RPE, soreness, weight, mood, feeling, injury, free
  notes; validated against `OBS_TYPES`, soft-referenced to a workout) and
  `log_manual_workout` / `delete_manual_workout` (non-Garmin workouts stored in
  `activities` with a negative synthetic id under `BEGIN IMMEDIATE` and
  `source='manual'`, feeding CTL/ATL/TSB via `baselines.recompute()` with a
  widened lookback so backdated workouts rewrite their own date's row).
- **Server-side miles** — `query_workouts` / `get_workout_detail` / the snapshot
  add `distance_mi`, `pace_min_per_mi`, and formatted duration alongside the raw
  values (`agent/units.py`). `LOCAL_FITNESS_DISPLAY_UNITS` (default `miles`).

### Changed
- Brief generation is now restricted to a read-only tool allow-list
  (`read_only_tool_names()`), so it structurally cannot invoke a write tool; its
  tool set is otherwise unchanged. Chat and the web agent keep the full set.

### Database
- New `observations` table (idempotent DDL; `activity_id` is a soft reference,
  no enforced FK) and a guarded `activities.source` column; `init_schema()`
  stays idempotent across calls.

## [0.2.0] - 2026-06-16

### Added
- **MCP server** — the fitness tools are now reachable from interactive Claude
  sessions (Claude Code / Desktop / other local agents) over the Model Context
  Protocol. Deployed endpoint at `/mcp/` (streamable-HTTP, behind the existing
  `LOCAL_FITNESS_API_TOKEN` bearer gate); local `fitness mcp-stdio` for
  auth-free laptop use. Connect: `claude mcp add --transport http fitness
  https://fitness.home.local/mcp/ --header "Authorization: Bearer $TOKEN"`.
  Implemented by reusing the SDK's already-built tool `Server`
  (`web/mcp_server.py`) over a new transport — one source of truth, no schema
  or handler duplication, so it auto-tracks `agent/tools.py::ALL_TOOLS`.
- **`LOCAL_FITNESS_MCP_ALLOWED_HOSTS`** env var — host allowlist for the MCP
  transport's DNS-rebinding guard (must include the served host or `/mcp/`
  returns 421). Defaults to `fitness.home.local,127.0.0.1,localhost`.

### Security
- `/mcp` and `/mcp/*` are explicitly auth-gated in `_is_public_path` (they live
  outside `/api/`, which defaults to public) — regression-tested in
  `tests/test_security.py`.

## [0.1.0] - 2026-06-06

First documented release. The version was already `0.1.0` in `pyproject.toml`;
this entry inaugurates the changelog and adds the "treat the agent as code"
quality infra. No runtime/app behaviour changed — these are dev-side guardrails,
so the version is documented rather than bumped.

### Added
- `scripts/score_prompt.py` — an eval that scores `agent/prompts.py` against
  grounded pass/fail checks (never-fabricate rule, CTL/ATL/TSB translation,
  roast-when-slipping tone, MCP-tool references, user-notes injection, the
  briefing schema-lock) and exits non-zero on failure so CI can gate on it.
  Its highest-value check cross-validates that every metric/tone the briefing
  prompt advertises is a member of the `Tone`/`MetricName` enums in
  `agent/schemas.py` — catching prompt↔schema drift that would otherwise break
  briefs silently.
- `tests/` — pytest suite covering the deterministic, network-free core
  (`db`, `notes`, `agent/schemas`, `agent/prompts`, `ingest/baselines`, the
  `agent/tools` handlers, and the scorer). `pyproject.toml` enforces a
  whole-repo coverage gate via `--cov-fail-under` (floor 43%; actual ~46%).
  The Garmin-ingest, Claude chat/briefing, and FastAPI-route layers are
  largely excluded from exercise by design (network/SDK).
- Made `tests/test_security.py` hermetic: the auth/route cases were silently
  depending on a developer's real `data/fitness.db` and only failed once CI
  ran them on a fresh clone (`no such table: daily_metrics`). They now run
  against a schema-initialized temp DB.
- `.github/workflows/ci.yml` — runs ruff, the test suite with the coverage
  gate, and the prompt scorer on every push and PR to `master` (uv toolchain).
- `.github/workflows/release.yml` — after CI is green on `master`, cuts a
  GitHub Release + tag for the `pyproject.toml` version if it isn't already
  released (idempotent, notes pulled from this changelog). Bumping the version
  is what ships a release; a normal merge is a no-op.
- `requirements`/dev deps: `pytest-cov` and `coverage` added to the dev group.
- This `CHANGELOG.md`.
