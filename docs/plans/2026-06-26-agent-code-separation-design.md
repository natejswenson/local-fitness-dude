---
ticket: "#TBD"
title: "Agent/Code Separation — deterministic brief-planner + scoped LLM generator + live evals"
date: "2026-06-26"
source: "design"
---

# Agent/Code Separation for the Brief Composer

## Goal

Make local-fitness a production-grade system with a **clear separation between
the non-deterministic agent (LLM) and the deterministic code**, guided by
["Your Prompt Is Too Big"](https://chasepd.github.io/posts/your-prompt-is-too-big/):
the *reasoning pipeline* (context selection, state extraction, threshold
evaluation, planning, validation) is **deterministic code covered by tests**;
the *generation stage* (final prose from scoped instructions) is the
**non-deterministic LLM covered by evals**.

## The reframe (from investigation)

The system is **not** a many-agents monolith. There is exactly **one** in-process
LLM loop — the daily-brief composer (`briefing.py:216`, `max_turns=20`). "Chat"
is the fitness tools exposed over MCP and driven by an *external* Claude (already
a clean tools-layer + external-agent split). The deterministic core
(`status.py`, `plans.py`, `units.py`, `charts.py`, `briefs.py`, `schemas.py`) is
pure, isolated, and **92.9% tested**.

The single monolith is the **brief prompt**: 18,366 chars / 371 lines doing ~11
jobs in one call, of which **~40–50% is deterministic logic the LLM re-derives by
hand** — tool orchestration, threshold predicates, tone selection, chart-metric
selection, unit/delta math, and ~80 lines defending a JSON schema the code
already enforces and repairs. Only **3 jobs are irreducibly LLM**: pick the
signal, write the prose, maintain continuity. And the current "evals"
(`score_prompt`, `score_profiles`) are **static prompt-text checks** — zero run
the model and judge real output.

So this design does two things: **(1)** move the deterministic ~half of the brief
prompt into a tested code pre-pass, shrinking the LLM's job to select+write; and
**(2)** build **live-model evals** for that residual judgment.

## Architecture

Three deterministic layers wrap one scoped LLM call:

```
 Garmin → SQLite (data)
    │  [DETERMINISTIC, tested]
    ▼
 ① brief_planner.assemble_brief_context()
    - fetch once (reuse assemble_status / plan engine)
    - evaluate every trigger predicate (recovery/conditioning/steps/plan/load)
    - per fired trigger: build a CandidateTakeaway
      (category, fired_triggers, metrics, suggested_tone, chart_metric, salience, evidence)
    - gather continuity (last-7 brief headlines), today's prescription
    → BriefContext   (typed contract, Pydantic)
    │
    ▼  [NON-DETERMINISTIC, eval'd]
 ② brief_generator  (the only LLM call — SMALL prompt)
    - receives BriefContext
    - SELECTS 3–5 candidates, prioritizes the lead
    - WRITES headline/summary/details in the coach voice
    - maintains continuity vs the last 7
    → Brief (existing schema)
    │
    ▼  [DETERMINISTIC, tested]
 ③ grounding.validate(brief, context)  +  briefs.save_brief()
    - every numeric token in the prose must trace to a CandidateTakeaway metric
      (within tolerance) — else reject/repair (the article's "did it invent?")
    - schema validation + salvage (existing)
    → briefings/<date>.json
```

**Why not full multi-agent:** the win is moving *determinism* into code, not
adding LLM agents. A daily brief needs one scoped generation, not a fleet —
extra LLM stages add latency, cost, and failure surface for no quality gain. The
article's "specialized agents with narrow contracts" is satisfied by the code
stages (each a pure function with a typed contract) + one scoped generator.

## Components

### New: `agent/brief_planner.py` (deterministic, tested)
- `assemble_brief_context(db_path=None, *, today=None) -> BriefContext`.
- Reuses `status.assemble_status()` and the `plans` engine; adds the **trigger
  layer**: pure predicates extracted verbatim from the prompt
  (`prompts.py:401-479`), e.g. `rhr_elevated(snapshot)`,
  `ctl_sliding(load)`, `sleep_debt(snapshot)`, `steps_missed(snapshot)`,
  `plan_conflict(plan, snapshot)`. Each returns a `CandidateTakeaway` or `None`.
- **Tone assignment** (deterministic): `suggest_tone(category, metrics, profile)`
  — the data→tone rules from the prompt, composed with the existing harsh-block
  gate (`coach.includes_harsh_block`).
- **Chart-metric assignment** (deterministic): `suggest_chart(category) ->
  TakeawayMetric | None` — the prompt's category→chart map.
- **Salience**: `score_salience(candidate) -> float` — a priority prior so the
  generator has a ranking (and the eval can check the lead).

### New schemas (`agent/schemas.py`)
- `CandidateTakeaway` (Pydantic): `category, fired_triggers, metrics (dict),
  suggested_tone (Tone), chart_metric (TakeawayMetric|None), salience (float),
  evidence (str)`.
- `BriefContext` (Pydantic): `date, user_name, candidates (list), continuity
  (list[str]), plan_today (dict|None)`.

### New: `agent/grounding.py` (deterministic, tested)
- `validate_grounding(brief: Brief, context: BriefContext) -> list[GroundingError]`
  — extract numeric tokens from each takeaway's `summary`/`details`; each must
  match a value in some `candidate.metrics` within tolerance (units-aware via
  `units.py`). Returns violations; `save_brief` rejects on any (or the generator
  is re-prompted once with the violation).

### Changed: `agent/prompts.py`
- `briefing_prompt` shrinks to the **scoped generator prompt**: receives
  `BriefContext` (rendered compactly), instructs only SELECT + PRIORITIZE +
  WRITE + CONTINUITY in voice. Delete: tool-orchestration list, threshold
  predicates, tone-selection rules, chart-metric map, the ~80 lines of
  JSON/schema defense (code guarantees it). Target: **<½ current size**.

### Changed: `agent/briefing.py`
- `generate_streaming` calls `brief_planner.assemble_brief_context()` first,
  passes `BriefContext` into the (smaller) prompt, drops most tool turns
  (`max_turns` falls — the LLM no longer orchestrates fetches), runs
  `grounding.validate` before `save_brief`.

### New: eval harness (`tests/evals/`)
- `tests/evals/fixtures/` — small set (~5) of **fabricated** DB snapshots (never
  real PHI), each a known scenario (recovered, fatigued, plan-conflict,
  data-gap, all-green) with expected properties.
- `tests/evals/test_brief_evals.py` — per fixture: build context, run the real
  generator, assert **properties**: (a) validates `schemas.Brief`; (b) **factual
  grounding** (`grounding.validate` clean); (c) **lead-signal** = highest-salience
  fired category; (d) **tone** in the active profile's band.
- `tests/evals/judge.py` — an **LLM-judge** rubric (voice adherence,
  synthesize-not-summarize, jargon-translated-on-first-use) scoring 0–1.
- Cost controls (per the "quote spend + hard cap" rule): a `MAX_EVAL_GENERATIONS`
  hard cap (refuse > N), the cheaper model by default, a pre-call spend estimate
  logged. Est. **~$0.30–0.60 per full run** (5 fixtures × gen + judge).

### Changed: CI (`.github/workflows/ci.yml`)
- New **`evals` job**: runs the live per-PR evals. **Secret-gated** — guarded on
  `secrets.ANTHROPIC_API_KEY` (so **fork PRs skip cleanly**, no secret = no run,
  no failure). Cost-capped. Required check for non-fork PRs.
- Prerequisite (Phase 0): **fix `ab_brief --run` flakiness** — route the eval's
  brief parsing through the existing `briefs._salvage_takeaways` so a live gate
  isn't flaky. Until clean across 20 consecutive runs, the `evals` job is
  `continue-on-error` (non-blocking), then promoted to required.

## Data flow

`assemble_brief_context` (code) → `BriefContext` (typed) → generator (LLM) →
`Brief` (typed) → `grounding.validate` (code) → `save_brief` (code) →
`briefings/<date>.json` → web UI (view-only).

## API Surface

```python
# agent/brief_planner.py
def assemble_brief_context(db_path: Path | None = None, *, today: str | None = None) -> BriefContext: ...
def suggest_tone(category: str, metrics: dict, profile: CoachProfile) -> Tone: ...
def suggest_chart(category: str) -> TakeawayMetric | None: ...
def score_salience(candidate: CandidateTakeaway) -> float: ...

# agent/schemas.py
class CandidateTakeaway(BaseModel): category: str; fired_triggers: list[str]; metrics: dict; \
    suggested_tone: Tone; chart_metric: TakeawayMetric | None; salience: float; evidence: str
class BriefContext(BaseModel): date: str; user_name: str; candidates: list[CandidateTakeaway]; \
    continuity: list[str]; plan_today: dict | None

# agent/grounding.py
class GroundingError(BaseModel): takeaway_index: int; token: str; reason: str
def validate_grounding(brief: Brief, context: BriefContext) -> list[GroundingError]: ...

# agent/briefing.py  (unchanged signature, new internals)
async def generate_streaming(...): ...   # now: plan → generate → ground → save
```

## Invariants

**Checkable by inspection:**
- The generator prompt contains **no** threshold predicates, tone-selection
  rules, chart-metric maps, or JSON-formatting defense (those live in code).
- `brief_planner`, `grounding`, `schemas` import **no** Claude SDK (deterministic).
- The `evals` CI job is secret-gated (skips on forks).

**Requires tests:**
- `assemble_brief_context` is pure/deterministic: same DB → same `BriefContext`.
- Every trigger predicate fires exactly on its documented condition (unit tests
  with fabricated snapshots).
- `validate_grounding` flags an invented number and passes a grounded one.
- `suggest_tone` reproduces the prompt's data→tone rules + harsh-block gating.
- **Eval (live):** generated brief is schema-valid, grounded, leads with the
  top-salience category, tone in band — across all golden fixtures.

## Testing & eval strategy

- **Deterministic code → pytest**, fabricated DB fixtures (existing pattern):
  triggers, tone, chart, salience, grounding, `assemble_brief_context`. Target
  100% on the new pure modules; overall gate stays ≥85%.
- **Non-deterministic generator → live evals** (per-PR, secret-gated, cost-capped):
  property assertions + LLM-judge on golden fixtures.

## Migration plan (phased — each a `feature → dev` PR)

0. **Fix eval flakiness** — route `ab_brief`/eval parsing through the salvage
   parser; prove 20 clean live runs. *(prereq for a live gate)*
1. **Extract triggers + tone + chart + salience to `brief_planner` (code) + tests** —
   no behavior change yet (prompt still authoritative); pure functions land tested.
2. **`BriefContext` schema + `assemble_brief_context`** — wire into `briefing.py`,
   shrink the prompt to the scoped generator, drop tool-orchestration turns.
3. **`grounding.validate` layer** + delete the JSON-defense prompt block.
4. **Eval harness + `evals` CI job** (non-blocking → required once stable).

## Failure modes & edge cases

- **Empty/partial DB** — `assemble_brief_context` returns a `BriefContext` with
  whatever candidates fired (possibly few); generator still produces a valid
  (shorter) brief. (Mirror `assemble_status`'s never-raise contract.)
- **Generator invents a number** — `validate_grounding` catches it; one re-prompt
  with the violation, else drop the offending takeaway.
- **Fork PR (no API key)** — `evals` job skips; deterministic tests still gate.
- **Cost runaway** — `MAX_EVAL_GENERATIONS` hard cap refuses oversized fan-outs.

## Risks

- **Over-determination** → robotic briefs. Mitigation: planner *over-generates*
  candidates; the LLM still selects/prioritizes/authors. Grounding constrains
  numbers only, never narrative.
- **Live eval cost/latency on every PR** (user's explicit choice). Mitigation:
  small fixture set, cheap model, hard cap, secret-gate; quoted ~$0.30–0.60/run.
- **Tone rules hard to fully de-LLM** — start with the clearly-deterministic
  rules; leave genuinely ambiguous tone calls to the generator (eval checks the
  band, not the exact tone).
