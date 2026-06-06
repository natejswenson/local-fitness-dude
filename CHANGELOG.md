# Changelog

All notable changes to local-fitness are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
