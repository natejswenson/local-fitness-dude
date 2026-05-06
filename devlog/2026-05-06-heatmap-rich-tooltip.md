# 2026-05-06 — heatmap day tooltip

The heatmap is the favorite view; making it nerdier. Hover any day and a
floating popover surfaces every factor that informed the cell color:
the activities themselves, the recovery markers with delta-vs-60d
baseline color cues, and the day's Banister CTL/ATL/TSB state.

## Backend

`/api/activity-heatmap` is now a single enriched call. Spine is the
activity day-aggregate; LEFT JOINs to `daily_metrics` and `baselines`
attach RHR, sleep, body battery, stress, steps + the 60-day means and
CTL/ATL/TSB. A second query attaches per-activity detail (5/day cap so
a freak day can't bloat the response). For 2y of data the payload runs
≈150 KB — well within budget.

New companion endpoint `/api/activity-heatmap-day/{date}` lazy-loads
wellness + baseline + load-state for **rest days** (those aren't in
the main payload because the spine joins from `activities`). Cached
per-date by the frontend so re-hovering the same rest cell never
re-fetches.

Auth + security headers + path-traversal regression — all unchanged.
`tests/test_security.py` grows the new endpoint into the auth-gating
sweep so a future move can't quietly drop the bearer check.

## Frontend

New component: `<HeatmapDayTooltip />`. Renders into a portal anchored
to `document.body` (so SVG `overflow` can't clip it), positions to the
right of the hovered cell with a viewport-edge clamp that flips it
left near the right edge.

What it shows:

- **Header** — day of week + full date.
- **Active day**: training-load value (color-coded by tone — red ≥150,
  warn ≥80, accent ≥30), `N activities · Xh Ym` summary line.
- **Activities list** — Lucide icon by type, capitalised type, `km · time
  · pace · HR`, with `+load` contribution on the right.
- **Recovery markers** — Resting HR / Sleep / Body Battery / Avg stress
  / Steps. Each has the raw value PLUS a delta-vs-60d-baseline tag,
  colored by tone (lower-is-better for RHR + stress; higher-is-better
  for sleep + body battery). When the baseline is missing, the delta
  is omitted gracefully.
- **Training-load state** — CTL · fitness, ATL · fatigue, TSB · form.
  TSB carries an inline "overreaching / productive / fresh /
  detraining" tag and goes red when ≤ −15.
- **Rest day**: header gets a "REST" pill, body says "No activities —
  recovery day," then the same recovery + load-state sections via the
  lazy-load endpoint. If the watch wasn't worn, surfaces "No watch
  data recorded for {date}".

Cell hover wiring captures `e.target.getBoundingClientRect()` so the
tooltip anchors to the actual rendered cell position, not estimated
mouse coords. The native `<title>` was removed — the floating popover
replaces it.

The bottom totals strip stayed (cumulative active days + load); the
hover-info text that used to live there moved into the tooltip. The
strip now reads `… · hover any day for full stats` to nudge first-time
visitors toward the new affordance.

## Verification

- `pnpm build` + `pnpm tsc --noEmit` clean.
- `uv run pytest -x` 11/11 (auth regression now includes the new
  rest-day endpoint).
- Container rebuilt healthy on first probe.
- Playwright hover screenshots:
  - **Active day** (Thu May 15, 2025): training load 541 in red, lone
    Treadmill Running 12.92 km / 1h 31m / 7:05/km / HR 169 / +541, RHR
    52 bpm (-0.8 ✓), Sleep 8h 6m (-16m ✗), Avg stress 39 (+6.6 ✗),
    CTL 56.7 / ATL 92.1 / TSB -35.4 tagged "overreaching" in red.
  - **Rest day** (Wed May 7, 2025): REST pill top-right, "No activities
    — recovery day," RHR 54 (+1.4 ✗), Sleep 7h 20m (-64m ✗), Avg stress
    29 (-3.5 ✓), CTL 48.7 / ATL 25.7 / TSB +23.0 tagged "fresh".

Both tooltips position cleanly inside the viewport and re-anchor when
the user moves between cells.
