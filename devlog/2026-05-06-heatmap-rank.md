# 2026-05-06 — heatmap rank in tooltip

The cell color tells you the day's training load is high; the rank
tells you whether it's *historically* high. Now both surface in the
tooltip header.

## What's there

When hovering an active day, the load summary now carries a rank line:

- **#1**: `🔥 Hardest day this year` (red, bold)
- **#2 / #3**: `2nd hardest in 2 years` (warn-orange)
- **Top 5%**: `12th of 192 · top 4%` (warn)
- **Top 25%**: `38th of 192 · top 19%` (default text)
- **Below median**: `94th of 192 · 49th percentile` (muted)

Window label adapts to the active range toggle: `this year`, `in 6 months`,
`in 2 years`, etc — so the rank reads naturally without contradicting
the chart's own time scope.

## Implementation

Pure frontend computation off the existing heatmap response. When data
loads, build a `Map<date, rank>` by sorting the active-day array DESC
on `total_load`; pass the map + total + window label down to the
tooltip via a `LoadRanking` prop. No backend change, no extra fetch.

Ordinal helper handles the `1st / 2nd / 3rd / Nth` pluralisation
correctly (including the `11th / 12th / 13th` exceptions). The rank
line is `null`-safe — rest days and zero-active-day windows render
the load header without it.

## Verified

- `pnpm tsc --noEmit` + `pnpm build` clean.
- `pytest -x` 11/11.
- Container rebuilt healthy on first probe.
- Playwright hover shots:
  - **Hottest cell** (Thu May 15, 2025, load 541): "🔥 Hardest day
    this year" in red.
  - **4th-hottest** (Sat May 17, 2025, load 278): "4th of 183 ·
    top 2%" in warn.

## Skipped

Recovery-percentile per marker. Considered showing "RHR · top 12%"
etc. on each recovery line, but: (a) the existing delta-vs-baseline
already answers "how good was this", (b) computing percentile across
the full window requires wellness for ALL days incl. rest, which
isn't in the current payload, and (c) the load rank is the headline
ask. If the rest-day wellness percentile turns out to be useful
later, it's a separate enrichment of the heatmap response.
