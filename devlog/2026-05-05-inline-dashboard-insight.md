# 2026-05-05 — inline dashboard insight (UX redo)

The chip-seeds-textarea-at-the-bottom UX from earlier today was bad —
click chip, scroll past two charts, find the textarea, wait for the
answer, scroll back to look at the chart while reading. The chart and
the insight lived in different parts of the page. Felt clunky for a
product whose entire reason to exist is "ask the smart AI about your
data."

Replaced it with `<DashboardInsight />`: an embedded conversation that
streams the agent's answer **directly under the chart that prompted
the question**. Single shared session across all three panels so
context carries.

## What changed

- **No textarea-edit step.** Click a chip → the prompt fires
  immediately. The previous flow's "click chip, then click the
  textarea, then click send" was three steps where one would do.
- **Answer streams next to the data.** Tool-call pills surface every
  query the agent runs (ToolSearch, run_sql, training_load_status
  etc.) so you can see what's being fetched. Then the markdown answer
  streams in below, with the chart still visible above.
- **Follow-up composer appears after the first answer.** Same card,
  no scrolling — type "drill into M3-W4" and it goes to the same
  agent session.
- **Chips stay clickable** while a conversation is live. Pivot to a
  different angle without clearing first; the agent treats it as the
  next message.
- **Active chip is highlighted** so you can see which prompt fired.
- **Single shared session** across all three panels (heatmap, pace
  efficiency, strength) so the agent has continuity when you move
  between views. Cleaned up on page unmount.
- **Page-level Sonnet/Opus toggle** in the header, applies to all
  three insights.

## Removed

- The page-bottom `<ChatPanel />`. Insight is now per-card; the global
  panel was the source of the friction.
- The `AskBar` component. Replaced by `DashboardInsight` which owns
  both the chip row AND the streaming conversation.

## Verified

- `pnpm build` + `pnpm tsc --noEmit` clean.
- Container rebuilt healthy on first probe.
- Playwright drove the full flow: clicked "Spot overload weeks" → the
  prompt auto-fired, tool pills appeared (~15 run_sql calls visible),
  then a richly-formatted markdown answer streamed in with a Current
  Snapshot table comparing this week vs 60-day baseline, an "Overload
  Weeks — Your Three Worst Offenses" deep-dive section, and a
  "Well-Balanced Blocks" section calling out specific date ranges.
  Follow-up composer appeared below; chart stayed visible above the
  whole time.

## What's still rough

- The agent's planning narration ("Let me pull a year of data..."
  "Odd — the comment blocks are triggering the read-only guard...")
  shows up in the answer body. It's transparent but verbose. Future:
  hide planning text behind a collapsible "thinking" disclosure
  similar to the Anthropic console.
- A query for the heatmap currently runs ~15 `run_sql` calls. That's
  workable but the cost-per-question adds up. Future: build
  higher-level dashboard-aware tools that the agent can call with
  fewer round trips.

Both are deferred — the v1 UX shipped is dramatically better than
the chip-seeds-textarea-at-bottom flow it replaced, and that's the
shot we wanted today.
