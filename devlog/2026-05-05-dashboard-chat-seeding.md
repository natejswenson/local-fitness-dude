# 2026-05-05 — chat-seeding on each dashboard

The dashboards shipped earlier today display data. The point of this
project is to *interrogate* data through the agent — so each dashboard
now has an "Ask the agent" row underneath the chart with 3-4
context-aware question chips. Clicking one seeds the page-level chat
with a prompt that mentions the active time window so the agent
queries the right slice without a follow-up.

## Pattern

Reused the existing `seedRequest = { text, nonce }` mechanism that
`Today.tsx` already uses for the `TakeawayCard` "Ask about this"
button. Lifted seed state to the `Dashboards` page, passed an
`onAsk(text)` callback into each panel, and mounted a single
`<ChatPanel />` at the bottom of the page. The nonce bump re-fires
the seed even when two chips have identical text — so re-clicking
the same chip after editing still re-seeds.

New shared component: `<AskBar prompts={...} onAsk={...} />`. Renders
the "ASK THE AGENT" header + a row of pill chips. Each chip is just
a button that calls `onAsk(seed)` with its prepared prompt.

## Prompts (range-substituted at click time)

**Activity heatmap** — *Spot overload weeks · Consistency vs spikes ·
Days I should have rested*. All include `the last {range}` so the
agent knows whether the user is looking at the 90d, 6mo, 1y, or 2y
window.

**Pace efficiency & fatigue** — *Read the trend · Fatigue signals ·
Detraining vs fitness · Best efficiency runs*. The fatigue prompt
explicitly cross-references TSB so the agent uses the existing
training-load tool alongside the per-run query.

**Strength volume** — *Why so little strength? · Complement my running
· Restart plan*. The first chip interpolates the actual
`last_session_date` from the response, so when the user is staring at
"last logged 2022-02-17" the agent gets that exact date in the seed.

## Verification

- `pnpm build` + `pnpm tsc --noEmit` clean.
- Container rebuilt, healthy on first probe.
- Playwright headless drove the page:
  - 3 AskBar sections render (one per panel).
  - 10 chips total (3 + 4 + 3).
  - Clicking the "Read the trend" chip set the textarea to:
    *"Walk me through my pace efficiency (HR per km/h) trend over the
    last 6 months. Is it improving or worsening? Cite the specific
    runs and the rolling-average shape."*
  - All three panels visually contain their AskBar; the bottom
    `<ChatPanel />` mounts and accepts the seed.

## Why not always-streaming

Considered injecting the dashboard's data into the prompt directly
(e.g. dumping the heatmap JSON), but the agent already has tools
(`get_training_load`, `get_metric`, `compare_metrics`, `recovery_after_workout`,
`run_sql`) that fetch the same data on demand. Letting the agent
choose which tool to call keeps the brief small and the answers
grounded in fresh queries rather than stale snapshots. The seed
just tells the agent *what to look at* and *over what window*.
