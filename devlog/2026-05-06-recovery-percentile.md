# 2026-05-06 — recovery percentile in tooltip + heatmap restructure

The load rank ("3rd hardest day this year") needed a recovery
counterpart — "RHR top 4%", "stress bottom 7%". Now every recovery
marker carries a percentile chip when the value is genuinely
remarkable.

## Backend restructure

`/api/activity-heatmap` previously joined from the `activities` spine
(active days only) and the frontend lazy-loaded rest-day wellness via
a sidecar endpoint `/api/activity-heatmap-day/{date}`. To compute
recovery percentiles across the *full* visible window — not just the
training-day subset — the spine had to flip to `daily_metrics`.

New structure:

- Spine: `daily_metrics LEFT JOIN baselines LEFT JOIN (activity day-aggregate)`
- Returns one row per day the watch was worn, regardless of whether
  there was a workout. Active days carry the activity aggregate +
  per-activity list; rest days carry zeros for those fields.
- New `recovery_pct` block per row — percentile rank within the visible
  window for RHR, sleep duration, body battery max, and avg stress. 0%
  is the BEST value for each metric (lowest RHR, longest sleep, highest
  BB peak, lowest stress) so "top X%" reads naturally regardless of
  which direction is "good".
- Population for each percentile excludes NULLs for that specific
  metric so a missing sleep value doesn't shift the percentile of days
  that DO have sleep recorded.
- Computed in Python with a small `_percentile_ranks` helper rather
  than pushing it through SQLite's `PERCENT_RANK()` — easier to handle
  the per-metric NULL exclusion correctly.

Response is ≈250 KB at 2y (was ≈150 KB) — within budget. The lazy-load
endpoint `/api/activity-heatmap-day/{date}` is removed entirely; rest
days now hover synchronously with no fetch flash.

## Frontend

- Types: `ActivityHeatmapDay` gains a `recovery_pct: { rhr, sleep_seconds, body_battery_max, avg_stress }` block.
  `ActivityHeatmapDayResponse` and `api.activityHeatmapDay()` deleted.
- `HoverTarget` simplified: `kind: 'rest'` now carries `day:
  ActivityHeatmapDay | null` (null only when the watch wasn't worn at
  all that date), so the tooltip renders synchronously from inline data.
- `HeatmapDayTooltip`: drops the `useEffect` lazy-load + `cacheRef`. The
  `RecoverySection` accepts `recovery_pct` and renders a small chip
  next to each marker label when the value is remarkable.
- `Row` gained an optional `pct` prop. Pill is colored by tier:
  - top ≤25% → green chip
  - bottom ≤25% → red chip
  - mid-pack (25-75%) → no chip (suppressed to keep the tooltip
    readable; the delta-vs-baseline already says "average")
- `HeatmapGrid`: cells where `activity_count===0` are now rendered as
  rest cells (intensity = null, surface-2 fill) so visual stays
  identical to before, even though those entries now exist in the data.
- `HeatmapTotals`: filtered to active days for the count + load sum
  (otherwise "183 active days" became "366 active days" — bug caught
  in the screenshot review).

## Verified

- `pnpm build` + `pnpm tsc --noEmit` clean.
- `uv run pytest -x` 11/11 (auth-regression updated to drop the
  deleted endpoint).
- Container rebuilt healthy on first probe.
- Playwright hover screenshots:
  - **Hot day** (Thu May 15, 2025, load 541): "🔥 Hardest day this year"
    rank line plus *"bottom 22%"* sleep chip and *"bottom 4%"* stress
    chip in red — the chips actually highlight that this 541-load day
    was *also* a genuinely poor recovery day (-16m sleep, +6.6 stress).
  - **Rest day** (Wed Dec 24, 2025, no activities): wellness rendered
    inline — no fetch flash. Avg stress 37 carried a *"bottom 7%"*
    chip; everything else was mid-pack so no other chips fired.

The chip-only-when-remarkable rule keeps the tooltip readable while
still surfacing the days that genuinely warrant attention. About a
third of cells get any chip; the rest stay clean.
