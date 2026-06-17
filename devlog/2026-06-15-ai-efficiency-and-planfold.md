# 2026-06-15 — AI-efficiency pass (with a negative result) + plan-fold fix

Two threads today after the training-plans feature landed: a latency-focused
pass on the Claude Agent SDK loop, and a bug the pass incidentally surfaced.

The headline lesson: **a measurement gate killed a plausible-sounding
optimization before it shipped.** That's the system working, not a failure.

## The AI-efficiency pass

Five ideas, all framed around latency (the app runs on the Max subscription —
round-trips, not dollars, are the cost). Designed with `/design`, then put
through `/red-team` + `/quality-gate` + `/siege` before any code. The
adversarial pass reshaped the design hard: it caught that the riskiest item
(#1) was over-scoped, under-measured, and had a real SQL-safety contradiction,
and it forced a resequence into two phases.

### Phase A — shipped (the real, safe wins)

- **Compact tool JSON** — `agent/tools._text` drops `indent=2`. Fewer
  whitespace tokens on every tool result across the multi-turn loop; the model
  parses either format.
- **3-way chat model tier** — the chat composer toggle is now Haiku | Sonnet |
  Opus. Default **Sonnet** (quality-first on the coaching path; the siege pass
  flagged that silently defaulting to Haiku could degrade advice the user can't
  tell is from the cheap model). The server whitelists the model so the toggle
  can't pass an arbitrary string to the SDK.
- **Caching guard** — a regression test pins `system_prompt()` cache-stable
  (no `datetime`/`uuid`/`random` in its source, byte-identical across calls) so
  a future edit can't silently bust the SDK's cached system prefix. Turns out
  the prefix was already clean — this just keeps it that way.

### Phase B — reverted (the brief pre-fetch)

The big idea: the daily brief makes ~8 *sequential model round-trips* to gather
the same data every time, so pre-compute that data in-process and inject it,
collapsing the gather phase to one pass. The red-team's safer framing (which I
adopted) was to **call the existing audited tool handlers and unwrap their
JSON** rather than extract a new query layer — so the frozen-set SQL validation
never moves and the bundle is byte-identical to what the model fetches today.

It implemented cleanly (12 tests, both prompt branches schema-locked). Then the
design's own §4 gate — a **live before/after latency measurement**, which the
red-team's SC-1 ("the goal is unproven, you have no measurement") had insisted
on — said no:

| brief wall-clock (median, N=3, Sonnet) | tool-driven | pre-fetched |
|---|---|---|
| total | **211 s** | **255 s** |
| first card | 200 s | 247 s |

No measurable win — if anything slightly worse, though the per-run spread
(206–292 s) means the honest read is "no improvement." **Why:** the brief is
*output-token-bound* — ~200 s of that is the model *writing* 4–5 detailed
takeaways; the tool round-trips are a small slice, so removing them barely
moves the total and the injected bundle adds a little back. Per the gate's own
rule ("ships only if it measurably beats baseline"), #1 was reverted
(`0754a86` → `d4fc389`). Phase A stands. Six briefs well spent to avoid
carrying dead complexity.

## The plan-fold fix (chased from the A/B)

The latency A/B incidentally exposed that the brief folded in the **active
training plan only ~1/3 of the time**. Root cause: the brief's plan-fold
instruction assumed there's a session *today* and adherence to report — but the
live plan starts tomorrow, so `get_training_plan_status` returns `active: true`
with `today=None` and `last_graded=None`. That null case was undefined, so the
model improvised, usually by dropping the plan entirely.

Same class of bug as the Today's-Goal UI card (which already handles
"no session today → show next"). Fixed the prompt: the workout takeaway is now
**plan-aware and must reference an active plan** (goal + days-to-race), with
explicit null handling — skip adherence when `last_graded` is null; when
`today` is null, say so plainly and give the recovery-driven call while still
naming the goal + countdown.

Verified live (not eyeballed): **2/2 briefs surfaced the plan** — lead headline
e.g. *"Rest day on the plan — sub-1:47 half is 89 days out"*, exactly the null
case that was being dropped — vs ~1/3 before. Scorer 11/11.

## State

`design/training-plans` net delta from today's AI work: Phase A + the plan-fold
fix. Suite 184 passing, scorer 11/11, ruff clean, container rebuilt + healthy
on the tool-driven brief. Commits: `8bf583b` (Phase A), `d4fc389` (Phase B
revert), `0ef435f` (plan-fold fix).
