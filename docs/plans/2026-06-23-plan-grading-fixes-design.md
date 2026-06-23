---
ticket: "N/A (interactive design)"
title: "Training-plan grading fixes — today-pending and walks-not-reflected"
date: "2026-06-23"
source: "design"
---

# Training-plan grading fixes

Two grading bugs, both confirmed as grading-layer issues (the activity data is
synced and present in the DB; neither is an ingest gap). All changes are in
`src/local_fitness/plans.py`. No prompt edits, so no brief A/B gate applies.

## Issue 1 — today's completed workout shows `pending`

`grade_workout` (`plans.py:197-207`) returns `pending` when
`workout["date"] >= frontier`, where `frontier = db.last_known_daily_date()` =
`MAX(daily_metrics.date)`. Once today's `daily_metrics` row exists, frontier =
today, so **today is always `pending`** even when a qualifying activity is
present. Verified: 2026-06-23 has a `treadmill_running` 3.0mi @ HR117 in
`activities`, yet the plan shows `pending`.

**Root cause:** the gate keys on the calendar date, not on whether the day has
gradeable data. Its original intent (don't report `missed` for days Garmin
hasn't delivered yet) is correct; the `>=`-only test over-applies it to a day
that already has a synced workout.

**Fix (outcome-based gate).** Grade first; keep `pending` only when there is no
credit yet AND the data window is still open:

```python
def grade_workout(workout, day_activities, frontier):
    verdict = classify_workout(workout, day_activities)
    if verdict == "missed" and (frontier is None or workout.get("date", "") >= frontier):
        return "pending"
    return verdict
```

Case table:

| Day | Activity | Old | New |
|---|---|---|---|
| Today, ran the easy 3mi | run present | pending | **done** |
| Today, nothing yet | none | pending | pending |
| Today, rest day | none | pending | **compliant** (side-fix) |
| Today, walked (easy day, walks count) | walk present | pending | **done** |
| Past day before frontier, no run | none | missed | missed |
| Future day | none | pending | pending |

This single rule fixes Issue 1, composes correctly with Issue 2's verdict
change, and resolves rest days immediately instead of holding them `pending`.

## Issue 2 — a recovery walk is not reflected

`classify_workout` (`plans.py:152-192`) grades `_DISTANCE_TYPES` (`easy`,
`long`, `race`) using `_running_distance` only (`plans.py:63-68`), and
`_is_running("walking")` is false. Verified: 2026-06-21 has a `walking` 3.86mi
@ HR94 (3959s) in `activities`, but the easy-run day grades `missed` and the
walk is invisible in `build_plan_detail`'s actuals (`_workout_actuals`, also
running-only).

**Decision (chosen): walks count fully on easy/recovery days, by distance, the
same as a run; never on `long`/`tempo`/`interval`/`race`.** Rationale: a
recovery-week prescription's intent is "active recovery, HR under 140,
conversational" — a 3.86mi walk at HR 94 fulfills that intent. Running
specificity only matters for the quality/long sessions, where walks still do
not count.

Two parts, deliberately decoupled:

**(a) Verdict — type-aware distance.** For `_DISTANCE_TYPES`:
- `easy` → `_foot_distance` (running **+** walking)
- `long`, `race` → `_running_distance` (running only)
- `tempo`/`interval` (duration-graded) and `cross` → unchanged.

New helpers:
- `_WALKING_SUBSTRINGS = ("walk", "hik")`; `_is_walking(activity_type)` mirrors
  `_is_running`.
- `_foot_distance(activities)` = sum distance where `_is_running OR _is_walking`.

The null-target "by feel" easy day → `done` if any foot activity (was: any
run).

**(b) Surfacing — always show what was done.** `_workout_actuals` becomes
foot-based (running + walking) on **every** day and additionally returns the
contributing activity type(s). So a walk is visible regardless of verdict: on an
easy day it reads "walked 3.9mi → done"; on a `long` day it reads "walked
3.9mi → missed" (honest and reflected, since walks don't satisfy a long run).
Surfacing is independent of the verdict-counting rule.

## Effect on the live data

- Today 6/23: treadmill 3.0mi → `done` (was `pending`).
- Saturday 6/21: walk 3.86mi on an easy day → `done` (was `missed`), shown as a
  walk.
- `adherence_pct` recomputes upward and propagates consistently through
  `build_plan_status` (brief) and `build_plan_detail`
  (`get_training_plan_progress` + `/api/plan` tab).

## API surface

- `_is_walking(activity_type: str | None) -> bool` — new module helper.
- `_foot_distance(activities: list[dict]) -> float` — new module helper
  (running + walking distance).
- `classify_workout(workout, day_activities) -> str` — same signature; `easy`
  now grades on foot distance, `long`/`race` unchanged.
- `grade_workout(workout, day_activities, frontier) -> str` — same signature;
  outcome-based `pending`.
- `_workout_actuals(day_activities, workout_type=None)` — extended to compute
  foot-based actuals and contributing types. (Signature may gain the workout
  type or remain positional; surfacing is foot-based for all types.)
- `build_plan_detail(...)` — per-workout entries gain
  `actual_activity_types: list[str]` alongside the existing
  `actual_distance_m` / `actual_pace_sec_per_km` (now foot-based). The brief's
  `_slim_workout` projection is unchanged — no new fields enter the brief path.

## Invariants

Checkable by inspection:
- Only `easy` counts walking toward a distance verdict; `long`, `race`,
  `tempo`, `interval` never count walking.
- No day at or after the frontier is ever reported `missed` (it is `pending`
  when it would otherwise be `missed`).
- A day with a qualifying activity is graded even when it is today / ≥ frontier.
- `_slim_workout` return shape is unchanged (brief path intact).
- No new SQL; helpers operate on already-loaded `activities_by_date` rows.

Requires tests:
- `grade_workout`: today-with-qualifying-run → `done`; today-empty → `pending`;
  today-rest → `compliant`; past-empty-before-frontier → `missed`; future →
  `pending`.
- `classify_workout`: `easy` + walk-only → `done` (and `partial` at the
  fractional boundary); `easy` by-feel + walk → `done`; `long` + walk-only →
  `missed`; `tempo` + walk-only → `missed`.
- `build_plan_detail`: an easy day with only a walk surfaces foot-based
  `actual_distance_m` > 0 and `actual_activity_types == ["walking"]`.

## Testing strategy

- `uv run pytest -x` — new `test_plans.py` cases for every invariant above;
  update existing grading tests that assumed today=`pending` or walk=`missed`
  (expected churn, not regressions).
- Coverage gate (43%) must stay green.
- No prompt change → no `score_prompt.py` / `ab_brief.py` gate.
- `docker compose up -d --build local-fitness` after, so the deployed plan tab
  and `get_training_plan_progress` serve corrected grading.

## Obligations (repo rules)

- Version bump in `pyproject.toml` + CHANGELOG entry (functionality change).
- `devlog/` entry.
- No new endpoint / no auth surface change → `test_security.py` untouched.

## Quality-gate provenance

(Filled in after the `/quality-gate` pass.)
