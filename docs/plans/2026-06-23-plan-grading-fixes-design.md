---
ticket: "N/A (interactive design)"
title: "Training-plan grading fixes — today-pending and walks-not-reflected"
date: "2026-06-23"
source: "design"
---

# Training-plan grading fixes

Two grading bugs, both confirmed as grading-layer issues (the activity data is
synced and present in the DB; neither is an ingest gap). The core grading
changes are in `src/local_fitness/plans.py`, but the change must also be
threaded through downstream consumers. **All changes span three files plus an
optional fourth touch:** `src/local_fitness/plans.py` (grading + surfacing),
`src/local_fitness/agent/tools.py` (re-projection allowlist), and
`web/src/components/TrainingPlan.tsx` (REQUIRED — verdict-aware Actual-cell
coloring; see Frontend below). Optionally, `actual_activity_types` is surfaced
as a walk badge (`TrainingPlan.tsx` + `web/src/lib/types.ts`). `web/server.py`
needs no edit (`/api/plan` has no `response_model`, so the new field passes
through). No prompt edits, so no brief A/B gate applies. The brief's
`_slim_workout` projection path remains genuinely untouched.

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

**Fix (outcome-based gate).** Grade first; keep `pending` only when the verdict
is a *negative* one (`missed` **or** `partial`) AND the data window is still
open. Both must be held: a mid-day half-done easy run grades `partial` at
`0.40 <= frac < 0.80` and would otherwise count 0.5 in adherence then self-heal
later in the day — the same premature-judgment bug as the `missed` case. We hold
*both* until the day is closed (strictly before frontier), and grade
`done`/`compliant` immediately.

```python
def grade_workout(workout, day_activities, frontier):
    verdict = classify_workout(workout, day_activities)
    if verdict in ("missed", "partial") and (frontier is None or workout.get("date", "") >= frontier):
        return "pending"
    return verdict
```

Case table:

| Day | Activity | Old | New |
|---|---|---|---|
| Today, ran the easy 3mi | run present | pending | **done** |
| Today, nothing yet | none | pending | pending |
| Today, half-done easy run (0.40 ≤ frac < 0.80) | partial run | pending | **pending** (held, not 0.5) |
| Today, rest day | none | pending | **compliant** (side-fix) |
| Today, walked (easy day, walks count) | walk present | pending | **done** |
| Past day before frontier, no run | none | missed | missed |
| Past day before frontier, half-done easy run | partial run | partial | **partial** |
| Future day | none | pending | pending |
| **`frontier is None` (no daily data yet), missed/partial** | none/partial | pending | pending |
| **`frontier is None`, done/compliant** | run / rest | pending | **graded** (done/compliant) |

This single rule fixes Issue 1, composes correctly with Issue 2's verdict
change, and resolves rest days immediately instead of holding them `pending`.

**Benign behavior change on the no-data-frontier path.** When `frontier is None`
(a fresh DB with no `daily_metrics` rows), the old rule held *every* day
`pending`. The new rule still holds `missed`/`partial` days `pending` (correct —
no frontier means we can't claim a miss) but now grades `done`/`compliant` days
immediately. This is a strictly better, intentional change: a day that already
has a qualifying activity is credited even before any daily-metrics row lands.

## Issue 2 — a recovery walk is not reflected

`classify_workout` (`plans.py:152-192`) grades `_DISTANCE_TYPES` (`easy`,
`long`, `race`) using `_running_distance` only (`plans.py:63-68`), and
`_is_running("walking")` is false. Verified: 2026-06-21 has a `walking` 3.86mi
@ HR94 (3959s) in `activities`, but the easy-run day grades `missed` and the
walk is invisible in `build_plan_detail`'s actuals (`_workout_actuals`,
`plans.py:514-519`, also running-only).

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
- `tempo`/`interval` (duration-graded) and `cross` → unchanged. Duration-type
  grading stays running-only (`_running_duration`); walks never satisfy a
  duration day.

New helpers:
- `_WALKING_SUBSTRINGS = ("walk", "hik")`; `_is_walking(activity_type)` mirrors
  `_is_running`. **Recommended safety design:** normalize each raw
  `activity_type` through an explicit raw→class mapping so unknown types fall
  through to `"other"` rather than being misclassified — `_is_running` and
  `_is_walking` match known substrings, anything else is `"other"` and counts
  toward no verdict. (This is also why `actual_activity_types` carries
  *normalized* labels, not raw types.) The substring check is then fail-safe: an
  unanticipated type can never silently satisfy an easy day.
  - **Pre-ship MANUAL verification (not an automatable invariant):** before
    shipping, run `SELECT DISTINCT activity_type FROM activities` against the
    (gitignored) DB once, by hand, to confirm no spurious `walk`/`hik`
    substring collision. This is a one-time manual check against personal data,
    not something the test suite can assert. Observed types today are
    `running`, `treadmill_running`, `walking` — none collide beyond the
    intended `walking`.
- `_foot_distance(activities)` = sum distance where `_is_running OR _is_walking`.

The null-target "by feel" easy day → `done` if any foot activity (was: any
run).

**(b) Surfacing — always show what was done.** `_workout_actuals` becomes
foot-based (running + walking) on **every** day and additionally returns the
contributing activity type(s). So a walk is visible regardless of verdict: on an
easy day it reads "walked 3.9mi → done"; on a `long` day it reads "walked
3.9mi → missed" (honest and reflected, since walks don't satisfy a long run).
Surfacing is independent of the verdict-counting rule. (This also broadens a
`cross` day's Actual cell from running-only to foot-based — harmless: the
`cross` verdict is unchanged and a walk already counts for `cross` via the
non-running check.)

**Pace semantics (stated explicitly).** Current pace is running-only:
`dur / (dist/1000)` over running activities only (`plans.py:518`). After this
change, surfaced **distance is foot-based** (running + walking) and **pace is
computed over the SAME foot activities that contributed the distance** — i.e.
the honest actual pace of what was actually done. On a walk-only day,
`actual_pace_sec_per_km` is therefore *walking* pace. The field
`actual_pace_sec_per_km` represents **"actual pace of the surfaced activity"**
(walk or run), NOT specifically running pace. Duration-type grading
(`tempo`/`interval`) is a separate code path and stays running-only — it is
untouched by the surfacing change (walks never satisfy duration days).

## Effect on the live data

- Today 6/23: treadmill 3.0mi → `done` (was `pending`).
- Saturday 6/21: walk 3.86mi on an easy day → `done` (was `missed`), shown as a
  walk.
- `adherence_pct` recomputes upward and propagates consistently through
  `build_plan_status` (brief) and `build_plan_detail`
  (`get_training_plan_progress` + `/api/plan` tab).
- **Brief content shift (intended, benign):** `build_plan_status`
  (`plans.py:569`) derives `today` and `last_graded` (`plans.py:584-601`) from
  `grade_workout`. Now that today can grade `done` (was always `pending`), the
  brief's `last_graded` focal workout can be **TODAY's** session rather than
  yesterday's. This is correct and desirable, but the brief-tone reviewer
  should know the focal-workout selection can now land on the current day.

## Weekly mileage stays running-only (intentional)

`weekly_mileage` (`plans.py:223-243`) sums `_running_distance` into `actual_km`,
which feeds the `WeeklyMileageChart` **Actual** bars
(`web/src/components/TrainingPlan.tsx:257-292`, the rollup is converted km→mi at
the render edge). After this design's walk-counting change, a walk-counted easy
week shows `done` verdicts and foot-based per-row Actual cells, but the weekly
Actual **bar** still excludes the walk. That looks like a same-tab contradiction
("counted, done" in the schedule vs. "no actual mileage" in the bar) — it is
**not** a bug.

**Decision (chosen): keep `weekly_mileage` running-only, by design.** "Weekly
mileage" is a **running-volume** metric — the thing a runner tracks, and what
training load / CTL-ATL-TSB derive from. That is a *different metric* from
recovery-day adherence. A walk legitimately counts toward an **easy-day
verdict** (you did the active recovery) but does **not** count toward **running
mileage**. So the bar correctly does not move for a walk-only week — that is
accurate, not a defect. The two surfaces answer two different questions
(run-volume vs. recovery-adherence) and are intentionally allowed to disagree.

**Visible effect, stated honestly.** A walk-counted `done` easy week will show
flat / low weekly **Actual** bars even though the schedule rows for that week
read `done`. This is intended: walks aren't running mileage.

**Optional clarifying label (deferred, YAGNI).** A small label on the chart
(e.g. "run mi" on the Actual legend / Y-axis) would pre-empt any user confusion
about why a `done` week shows a low Actual bar. Mark this **optional and
deferred** — do not add it now; revisit only if the disagreement actually
confuses in practice.

## API surface

Changes span **`plans.py` + `agent/tools.py`** (+ an optional one-line frontend
update). The brief's `_slim_workout` path is the only assembly path that stays
unchanged.

### `plans.py`

- `_is_walking(activity_type: str | None) -> bool` — new module helper.
- `_foot_distance(activities: list[dict]) -> float` — new module helper
  (running + walking distance).
- `classify_workout(workout, day_activities) -> str` — same signature; `easy`
  now grades on foot distance, `long`/`race` unchanged. Type-awareness of the
  verdict lives here, not in `_workout_actuals`.
- `grade_workout(workout, day_activities, frontier) -> str` — same signature;
  outcome-based `pending` holding `missed` **and** `partial`.
- `_workout_actuals(day_activities) -> tuple[float, float | None, list[str]]` —
  **stays positional** (concrete, committed signature; no workout-type
  parameter). It computes **foot-based** distance + pace on every day regardless
  of workout type, and returns the contributing **`actual_activity_types`**.
  Surfacing is foot-based unconditionally; the verdict's type-awareness lives in
  `classify_workout`, not here.
  - **`actual_activity_types` shape (pinned contract):** a list of
    **NORMALIZED** activity labels — `"running"` | `"walking"` | other — where
    each raw `activity_type` (e.g. `"treadmill_running"`) is mapped to its
    normalized class (`_is_running → "running"`, `_is_walking → "walking"`,
    else the raw lowercased type), then **DEDUPED and SORTED** for deterministic
    output. This grounds the test assertion `== ["walking"]`.
  - **Required call-site edit (only caller):** `build_plan_detail` unpacks the
    single call site at `plans.py:532`:
    `actual_dist, actual_pace = _workout_actuals(day)` must become
    `actual_dist, actual_pace, actual_types = _workout_actuals(day)`, and
    `actual_types` is attached to the per-workout entry as
    `actual_activity_types`. This is the only caller; no other unpack sites
    exist.
- `build_plan_detail(...)` — per-workout entries gain
  `actual_activity_types: list[str]` alongside the existing
  `actual_distance_m` / `actual_pace_sec_per_km` (now foot-based). The brief's
  `_slim_workout` projection is unchanged — no new fields enter the brief path.

### `agent/tools.py` — `get_training_plan_progress` (~`tools.py:1231-1245`)

This tool re-projects each workout through a **hardcoded key allowlist** that
currently names `actual_distance_m` / `actual_pace_sec_per_km` but **NOT**
`actual_activity_types`. Without an edit here the new field is silently dropped
from the agent-facing tool, defeating the surfacing goal. **Add
`"actual_activity_types": w.get("actual_activity_types")` to that projection
dict.**

### `web/server.py` — `/api/plan` (~`server.py:412`)

`/api/plan` returns `_assemble_plan_detail(build_plan_detail(...))` directly
with **no Pydantic `response_model`**, so `actual_activity_types` reaches the
React frontend as additive JSON automatically — no server-side schema edit
needed.

- **Frontend (REQUIRED — not optional).** `TrainingPlan.tsx` has a
  verdict-independent `missedTargets(w)` helper
  (`web/src/components/TrainingPlan.tsx:22-31`) that recomputes a miss from
  pace/distance:
  `paceMiss = actual_pace_sec_per_km > target_pace_sec_per_km * 1.05` and a
  distance check, ignoring the backend `verdict`. The Actual-cell color is then
  driven by that local `missed` flag
  (`TrainingPlan.tsx:221`, render at `:232-235`:
  `missed ? 'text-bad' : 'text-good'`). After the surfacing change an
  easy-day **walk** surfaces *walking* pace (far slower than the easy-run target
  pace), so `paceMiss` becomes true and the Actual cell renders **red** —
  while the backend verdict for that same row is now `done`. The plan tab would
  then show a **contradictory row** (verdict `done`, red "missed" Actual cell)
  on exactly the live rows this design highlights: Sat 6/21 (walk → `done`) and
  a shorter easy run today (`partial`/`done`). This is NOT harmlessly ignored —
  walk-counted and partial rows are mis-painted.

  **Required change (verdict-driven, recommended):** make the Actual-cell
  coloring **verdict-aware**. Each workout already carries `verdict`
  (`done|partial|missed|compliant|pending`); the cell's red/green state should
  be derived from `verdict` — **red only when `verdict === 'missed'`**, green
  otherwise — instead of recomputing the miss from pace/distance. Concretely,
  replace the `missedTargets(w)` call at `TrainingPlan.tsx:221` and the
  `missed ? 'text-bad' : 'text-good'` branch at `:232-235` with a
  `verdict === 'missed'` test (and delete or repurpose `missedTargets`,
  `DIST_HIT`, `PACE_HIT` at `:19-31`). The fallback option — keep
  `missedTargets` but suppress `paceMiss`/`distMiss` when
  `verdict` is `done`/`compliant` — is inferior because it keeps two sources of
  truth; prefer the single verdict-driven path.
  - **Accepted limitation:** under "red iff `verdict === 'missed'`, green
    otherwise," a PAST `partial` row renders **green** — binary red/green can't
    express "partially missed." An amber/partial cell state is a possible future
    enhancement; **deferred (do NOT add it now).**
- **Optional walk badge.** The TS `PlanWorkout` type
  (`web/src/lib/types.ts:251-265`) and the renderer may *additionally* gain a
  one-line addition to surface `actual_activity_types` as a "walk" badge. If
  not added, the extra JSON field is harmlessly ignored. This part is optional;
  the verdict-aware coloring above is not.

## Invariants

Checkable by inspection:
- Only `easy` counts walking toward a distance verdict; `long`, `race`,
  `tempo`, `interval` never count walking.
- No day at or after the frontier is ever reported `missed` **or** `partial`
  (it is `pending` when it would otherwise be either).
- A day with a `done`/`compliant` outcome is graded even when it is today /
  ≥ frontier (including the `frontier is None` path).
- `_slim_workout` return shape is unchanged (brief path intact).
- `actual_activity_types` is a deduped, sorted list of normalized labels.
- No new SQL; helpers operate on already-loaded `activities_by_date` rows.
- The plan-tab Actual cell is colored from `verdict` (red iff
  `verdict === 'missed'`), not from a locally recomputed pace/distance miss —
  so a `done` row can never render a red Actual cell.
- `weekly_mileage` remains running-only: the verdict / adherence layer counts
  walks (on easy days), but the weekly mileage rollup does not.

Requires tests:
- `grade_workout`: today-with-qualifying-run → `done`; today-empty → `pending`;
  today-half-done-easy-run (partial) → `pending` (held, not `partial`);
  today-rest → `compliant`; past-empty-before-frontier → `missed`;
  past-half-done-easy-run-before-frontier → `partial`; future → `pending`.
- `classify_workout`: `easy` + walk-only → `done` (and `partial` at the
  fractional boundary); `easy` by-feel + walk → `done`; `long` + walk-only →
  `missed`; `tempo` + walk-only → `missed`.
- `build_plan_detail`: an easy day with only a walk surfaces foot-based
  `actual_distance_m` > 0 and `actual_activity_types == ["walking"]`.
- `build_plan_detail` (surfacing-on-non-qualifying-day): a **`long`** day with
  only a walk → verdict `missed` BUT `actual_distance_m` > 0 and
  `actual_activity_types == ["walking"]` (walk surfaced even though it does not
  satisfy the long run).

## Testing strategy

- `uv run pytest -x` — these are **NEW** `test_plans.py` cases for every
  invariant above (today=`done`, walk-counts-on-easy, etc.). The current suite
  does **not** assert today=`pending` or walk=`missed`, so there is no existing
  churn to "update" — those are new cases, not edits. Verify the existing tests
  in `test_plans.py` / `test_plans_db.py` still pass; most survive unchanged.
- Coverage gate (43%) must stay green.
- No prompt change → no `score_prompt.py` / `ab_brief.py` gate.
- `docker compose up -d --build local-fitness` after, so the deployed plan tab
  and `get_training_plan_progress` serve corrected grading.
- **SCREENSHOT (PNG) of the plan tab after the frontend change is REQUIRED.**
  Project rule: never claim a UI change looks right without the PNG. The
  screenshot must confirm a walk-counted easy day (Sat 6/21) renders its Actual
  cell **green / done**, not red — i.e. the verdict-aware coloring eliminated
  the contradictory `done`-verdict-with-red-cell row.

## Obligations (repo rules)

- Version bump in `pyproject.toml` + CHANGELOG entry (functionality change).
- `devlog/` entry.
- No new endpoint / no auth surface change → `test_security.py` untouched.

## Quality-gate provenance

Reviewed via `/quality-gate` (artifact type: design) on `general-purpose`
agents (the `crucible-*` agent types / receipt-cairn infra are not installed
here, so the Opus recall guarantee was not enforced; findings were still
code-grounded). Four red-team rounds + a tightened look-harder pass. Terminal
verdict **PASS (clean-pass)**: 0 Fatal / 0 Significant on a fresh round, with
the consumer map verified exhaustive (no untouched fourth surfacing site;
`daily_snapshot`/`training_load_status`/`baselines` derive from raw
`activities.training_load`, not plan grading). Score trajectory 4 → 1 → 1 → 0.

The loop materially improved the design. Round 1 caught the **`partial`-at-
frontier gap** (the outcome-based gate must hold `partial` as well as `missed`)
and that the surfacing field would be **silently dropped by `tools.py`'s
hardcoded projection allowlist**. The look-harder pass caught the **frontend
regression** the standard pass had cleared: `TrainingPlan.tsx`'s
`missedTargets()` colors the Actual cell independently of the backend verdict,
so a walk-counted `done` row (walking pace) would render red — making the
frontend a required scope item with a verdict-aware coloring fix and a
screenshot gate. Round 3 caught the **weekly-mileage** consumer (kept
running-only, now documented as intentional).
