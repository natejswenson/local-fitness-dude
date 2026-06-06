# 2026-06-06 — Treat the agent as code: eval + tests + CI + changelog

Ported the "treat the skill as code" pattern from the `linkein-helper` repo
(its PR #3) onto local-fitness. The insight: the agent's prompt is the part of
this app you can't compile, so you score it, test the deterministic core behind
a coverage gate, and version the whole thing.

## What landed

- **Eval — `scripts/score_prompt.py`.** Grounded pass/fail checks on
  `agent/prompts.py`: never-fabricate rule, CTL/ATL/TSB translation,
  roast-when-slipping tone, MCP-tool references, user-notes injection, and the
  briefing schema-lock. The high-value check cross-validates that every
  metric/tone the briefing prompt advertises is a member of the
  `MetricName`/`Tone` enums in `agent/schemas.py` — so prompt↔schema drift
  (which breaks briefs silently, since the frontend drops unknown keys) fails
  loudly in CI instead. Stdlib-only; exits non-zero on any failure.

- **Tests — 90 new cases.** Cover the deterministic, network-free core:
  `db`, `notes`, `agent/schemas`, `agent/prompts`, `ingest/baselines`, the
  `agent/tools` handlers (called directly against a seeded tmp SQLite DB, no
  SDK), and the scorer itself (incl. tamper tests proving the schema
  cross-check has teeth). Whole-repo coverage went 28% → ~46%; gate set at
  `--cov-fail-under=45` in `pyproject.toml`. The Garmin-ingest / Claude
  chat+briefing / FastAPI-route layers are excluded from exercise by design.

- **CI — `.github/workflows/ci.yml`.** ruff → pytest (coverage gate) → prompt
  scorer, on push/PR to `master`, using the repo's `uv` toolchain.

- **Versioning — `CHANGELOG.md`.** Keep a Changelog + SemVer, anchored to the
  existing `version = "0.1.0"`. No bump: this is dev-side infra, not an
  app-behaviour change.

## Notes / decisions

- Coverage is a *realistic* whole-repo floor, not 100%-of-a-narrow-subset.
  100% across the app is infeasible (network/SDK/HTTP). Chasing it would mean
  mocking Garmin and Claude — deliberately out of scope for v1.
- Added a narrow ruff per-file-ignore for `cli.py`'s deliberate
  `load_dotenv()`-before-imports E402, so CI lint reflects intent.
- No runtime code changed → no container rebuild required.
