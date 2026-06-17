---
ticket: "#TBD"
title: "Training Plans — goal-driven plan generation, tracking, and daily-brief integration"
date: "2026-06-15"
source: "design"
---

# Training Plans

> **Revision note (post siege + red-team, anchor 8b35e2c):** this doc was
> hardened after a 5-agent adversarial pass. Material changes from the first
> draft: the brief integration *merges* into the existing workout takeaway
> rather than adding a parallel card (§4c); the agent-write trust boundary is
> enforced in code, not by convention (§4a, §8); adherence is type-aware and
> computed off the data frontier, not calendar-today (§3); the trajectory
> chart drops the undefined "target CTL ramp" and adds a computed Riegel
> predicted-finish (§4d). Security model is §10.

## 1. Summary

Add a **Training Plan** feature: the user picks a goal (5K / 10K / Half /
Full / Custom), a race date, and a target finish time. The AI drafts a
periodized plan grounded in the user's current ability (read from their own
Garmin history), the user riffs with the AI in chat until the plan is good,
then **commits** it. A committed plan becomes the single *active* plan and is
tracked in two places:

- a dedicated **Training Plan tab** (calendar/table, planned-vs-actual
  mileage, fitness-trajectory chart, goal header + adherence %), and
- the **daily brief**, where the existing "today's workout" takeaway absorbs
  the plan — yesterday's adherence + today's prescribed session, reconciled
  against recovery — but only when a plan is active.

The user can create a new plan (which archives the old one, with confirmation)
or delete a plan at any time. With no active plan, the brief reverts to its
recovery-driven workout takeaway and no plan content appears.

## 2. Design decisions (and the investigation behind them)

Findings from the codebase recon + adversarial pass that shaped the design:

1. **The brief schema is locked AND the takeaway budget is already full.**
   `Brief` is exactly `{takeaways: [...]}` (1–5 items), the prompt declares it
   *"FIXED and NON-NEGOTIABLE,"* and a salvage parser assumes `takeaways` is
   the only top-level list. Critically, the brief prompt **already** mandates a
   "today's workout" takeaway (from CTL/ATL/TSB), a steps takeaway, and
   conditional conditioning/recovery takeaways — inside a hard cap of 5.
   **Decision:** do NOT add a parallel "training card." The plan is folded into
   the *existing* workout takeaway: when a plan is active, that takeaway
   prescribes the plan's session for today (reconciled against recovery, with
   recovery taking precedence on red-flag days) and reports yesterday's
   adherence. "No plan → no plan content" is then structural: with no active
   plan the workout takeaway is exactly what it is today. This also removes the
   contradictory-instructions / slot-starvation failure of two competing
   workout mandates.

2. **No migration system** — schema is idempotent `CREATE TABLE IF NOT
   EXISTS`; `ALTER` on an existing populated table silently no-ops on the live
   `fitness.db`. **Decision:** training plans live in **new tables only**, and
   every column the feature needs on day one (incl. intra-day `seq`) must be in
   the initial `CREATE TABLE` — a missed column means a table rebuild later.

3. **Every agent tool is read-only today** — the only AI-writable state is the
   markdown notes file. This design introduces the **first agent→SQLite write
   path**. **Decision:** the AI writes **only `draft` rows**, enforced *in
   code* (hardcoded status, status-excluding field whitelist, status guard on
   revise — §4a), not by convention. Activation and deletion are human actions
   via REST buttons with confirmation. See the threat model in §10.

4. **The multi-turn chat session machinery is reusable** (`/api/chat`,
   per-session `ClaudeSDKClient`, `ChatPanel` with `seedRequest`). **Decision:**
   the "riff" is the existing chat, seeded with plan context; the AI mutates
   the draft through tool calls; the tab re-fetches `/api/plan` when a chat
   turn completes so the draft visibly evolves (§4d).

**Scope-absorption check:** training plans share local-fitness's data model
(Garmin activities), the same user, the same workflow, and would not survive
the app being replaced — 4/4. It belongs in this app.

## 3. Data model

Two new tables, appended to the `SCHEMA` string in `db.py`. No foreign-key
*constraints* (consistent with the rest of the schema), but `plan_id` is the
documented parent reference.

```sql
CREATE TABLE IF NOT EXISTS training_plans (
    plan_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    status               TEXT NOT NULL,          -- 'draft' | 'active' | 'archived'
    goal_type            TEXT NOT NULL,          -- '5k'|'10k'|'half'|'full'|'custom'
    goal_distance_m      REAL,                   -- nullable: 'custom' may have no canonical distance
    race_date            TEXT NOT NULL,          -- ISO YYYY-MM-DD
    target_time_seconds  INTEGER,                -- nullable for 'just finish'
    title                TEXT,                   -- e.g. "Sub-50 Fall 10K"
    ability_snapshot     TEXT,                   -- JSON: AI's current-ability estimate at creation (supplementary)
    created_at           TEXT NOT NULL,          -- ISO timestamp
    committed_at         TEXT                    -- ISO timestamp when draft→active
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON training_plans(status);
-- DB-enforced single-active invariant (turns a commit race into a hard error, not silent dup):
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_plan
    ON training_plans(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS plan_workouts (
    workout_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id              INTEGER NOT NULL,       -- → training_plans.plan_id
    date                 TEXT NOT NULL,          -- ISO YYYY-MM-DD
    seq                  INTEGER NOT NULL DEFAULT 1, -- intra-day order (AM/PM double-days)
    week_index           INTEGER NOT NULL,       -- 1-based week within the plan
    type                 TEXT NOT NULL,          -- 'easy'|'long'|'tempo'|'interval'|'rest'|'race'|'cross'
    target_distance_m    REAL,                   -- null for rest / by-feel
    target_pace_sec_per_km REAL,                 -- null for rest/easy-by-feel
    target_duration_sec  INTEGER,                -- used for interval/tempo/cross adherence
    description          TEXT NOT NULL           -- prose prescription, e.g. "6km easy + 4 strides"
);
CREATE INDEX IF NOT EXISTS idx_plan_workouts_plan ON plan_workouts(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_workouts_date ON plan_workouts(date);
```

**Grain:**
- `training_plans` — *one row = one athlete's plan toward one race.*
- `plan_workouts` — *one row = one prescribed session on one (date, seq) in one
  plan.* `seq` distinguishes double-days.

**Durability:** simple types, ISO date strings (matching every other table).
`ability_snapshot` is opaque JSON the UI renders as **escaped text only**
(never markdown / `dangerouslySetInnerHTML` — see §10); it is supplementary
color, never parsed for correctness and never the source of the on-track stat.

### 3a. Adherence (computed, never stored — and type-aware)

For any past `plan_workouts` row, join to `activities` on `date` and classify
**by workout type** — distance-only grading is wrong for the sessions where
distance isn't the target:

| Type | Match against | Verdict rule |
|------|---------------|--------------|
| `easy`, `long`, `race` | running activities, summed `distance_meters` for the date | ≥80% target → done; ≥40% → partial; else missed. Null target → any qualifying run → done. |
| `interval`, `tempo` | running activities, `duration_seconds` (or training_load) | A quality running session present that day → done; shorter than ~40% target duration → partial; none → missed. Distance is *not* used. |
| `cross` | **non-running** activities, `duration_seconds` | Any matching cross-training session → done; else missed. (Does not use the running join.) |
| `rest` | — | Always **compliant**; a run on a rest day is noted, not penalized. |

Multiple same-type activities on one date are summed (matches how
`baselines.py` already aggregates per-day load). Tolerances are constants in
code, tunable later.

### 3b. Time semantics (the data frontier, not calendar-today)

Garmin data lags (MacBook not always on; export turnaround 2–7 days), so
`db.last_known_daily_date()` is frequently behind calendar today. **All
"yesterday / today / missed" logic is relative to the data frontier, defined
once:**

- `frontier = db.last_known_daily_date()`.
- Prescribed days **at or after `frontier`** are **`pending`/`scheduled`**,
  never `missed` — we have no data yet, so we don't know.
- A prescribed day is only graded (`done`/`partial`/`missed`) once
  `date < frontier` (data has arrived).
- "Yesterday's adherence" in the brief = the most recent **graded** day
  (≤ `frontier - 1`); "today's session" = today's prescription regardless of
  data.
- `plan_workouts.date` and `activities.date` are both normalized to the same
  declared timezone before the join (a late-night run must not land on the
  adjacent calendar day's prescription). A DST/lag fixture test pins this.

### 3c. Single-active invariant

Enforced by the **partial unique index** above (DB-level) *and* a `BEGIN
IMMEDIATE` commit transaction (§4b). A racing second commit fails loudly
instead of silently creating two `active` rows.

## 4. Components & data flow

### 4a. Agent tools (`agent/tools.py`, added to `ALL_TOOLS`)

All follow the existing `@tool` + `_text`/`_err` pattern. **Write-boundary
enforcement is in code (the headline safety property):**

- `status` is **never** an input. `propose` hardcodes `'draft'`; `revise`
  never touches `status`/`committed_at`/`plan_id`/`created_at`.
- `revise_training_plan` takes **explicit named goal params**
  (`goal_type`, `race_date`, `target_time_seconds`, `goal_distance_m`,
  `title`) — *not* an open `fields` dict. Each maps to a column in a frozen
  `_EDITABLE_PLAN_COLS` set; unknown keys are impossible by construction.
- `revise` first does `SELECT status FROM training_plans WHERE plan_id=?` and
  `_err`s unless it is `'draft'`.
- `goal_type` and every workout `type` are validated against frozen sets
  **before any SQL**. Every numeric (`*_distance_m`, `*_pace_*`,
  `target_duration_sec`, `week_index`, `seq`) is coerced and bounded
  (`math.isfinite`, non-negative, sane ceilings); every date is validated via
  `date.fromisoformat()`. `len(workouts)` is capped (≤ ~200) and an empty
  array is rejected. Duplicate `(date, seq)` and dates outside
  `[created_at_date, race_date]` are rejected.
- Workout replacement (delete-old + insert-new) runs in **one transaction** so
  a mid-write failure or restart can't leave a half-empty draft.

Tools:

- **`get_training_plan_status()`** *(read-only)* — returns the active plan
  goal, days-to-race, the most-recent-graded day's prescription + actual +
  verdict, today's prescribed session, and overall adherence %. Returns
  `{active: false}` when no active plan. **For the brief it returns the
  structured fields only** (type, targets, verdict) — free-form `description`
  is length-capped and fenced as data, never passed as raw instruction text
  (anti-injection, §10).
- **`propose_training_plan(goal_type, race_date, target_time_seconds?,
  goal_distance_m?, title?, ability_snapshot?, workouts[])`** *(write, draft
  only)* — archives any existing `draft`, inserts a new `draft` plan + workout
  rows (validated + atomic as above).
- **`revise_training_plan(plan_id, goal_type?, race_date?,
  target_time_seconds?, goal_distance_m?, title?, workouts?)`** *(write, draft
  only)* — updates whitelisted goal fields and/or wholesale-replaces the
  workout set. Refuses if `plan_id` is not `draft`.

The AI **cannot** commit, activate, or delete — those tools don't exist.
(`get_training_plan` was cut as gold-plating: the model already has the draft
it just authored in-session; `get_training_plan_status` covers the rest.)

**Plan-quality grounding (the heart of the feature).** A new
`prompts.training_plan_prompt()` section instructs the planning model to, before
calling `propose_training_plan`: call the existing read tools
(`training_load_status`, `get_today_status`, `query_workouts` for recent best
efforts and weekly volume) to ground ability; apply periodization (base → build
→ peak → taper), a safe weekly-mileage ramp (~10%/week ceiling), hard/easy
alternation, and a race-week taper; and set `ability_snapshot` from the data it
read, not a guess. A small plan-quality eval (à la the existing prompt scorer)
checks generated plans for ramp-rate sanity, taper presence, and goal/date
fit — we score it, we don't eyeball it.

### 4b. REST endpoints (`web/server.py`, all under `/api/` → auto auth-gated)

None call Claude, so **none are added to `RATE_LIMITED_PREFIXES`**.

- **`GET /api/plan`** → `{ active: PlanDetail | null, draft: PlanDetail | null }`
  where `PlanDetail` bundles the plan, its workouts with computed adherence
  verdicts, the weekly planned-vs-actual mileage series, the actual-CTL series
  + race-day marker, and the **computed Riegel predicted-finish** (§4d). One
  fat read powers the whole tab.
- **`POST /api/plan/{plan_id:int}/commit`** → inside `BEGIN IMMEDIATE`:
  `SELECT status` (404 if missing, **409 if not `draft`**), archive any prior
  `active`, flip this row to `active`, stamp `committed_at`. The partial unique
  index is the backstop.
- **`DELETE /api/plan/{plan_id:int}`** → archives (soft-delete) the plan so
  history survives; 404 if missing.

### 4c. Brief integration (`agent/prompts.py`) — merged, not parallel

`briefing_prompt`'s existing **workout takeaway mandate** is extended: *"Call
`get_training_plan_status` first. If a plan is active, this takeaway IS the
plan's prescribed session for today — but reconcile it against recovery: when
RHR/TSB/sleep flag a red day, defer or swap the session and say so (recovery
takes precedence over the schedule). Open with yesterday's adherence
(done/partial/missed) from the tool. If no plan is active, produce the workout
takeaway exactly as today."* No change to `Brief` / `Takeaway` / the salvage
parser; no new top-level field; no separate card to suppress. Because the plan
rides inside an *already-required* takeaway, the 5-slot budget is unchanged and
steps/conditioning/recovery cards are not starved.

### 4d. Frontend (`web/src/`)

- **Route + nav:** add `<Route path="plan" element={<TrainingPlan />} />`
  (`main.tsx`) and one `items` entry (`Sidebar.tsx`, covers desktop + mobile).
- **`TrainingPlan.tsx`** composes:
  - `GoalHeader` — race type, countdown, target time, **computed Riegel
    predicted-finish vs target** (recomputed on every `/api/plan` read from the
    best recent effort in `activities`: `t2 = t1·(d2/d1)^1.06`), adherence %
    stat; `ability_snapshot` shown as supplementary text. Create-new and Delete
    controls (see confirmations below).
  - `PlanCalendarTable` — schedule table (reuses `Today.tsx` table idiom),
    `seq`-ordered within a day, past rows tagged ✓ done / ⚠ partial / ✗ missed /
    ·pending vs actual.
  - `WeeklyMileageChart` — recharts `BarChart`, planned vs actual km/week.
  - `FitnessTrajectoryChart` — **actual CTL** (from `/api/training-load`) with a
    race-day `ReferenceLine`. The undefined "target CTL ramp" is **cut from v1**
    (CTL has no published per-race-time target; a made-up ramp would imply false
    precision). Themed like `TrainingLoadChart`.
  - **Empty state** — when `active` and `draft` are both null, a prominent
    "Create a training plan" CTA that seeds the chat with a starter prompt.
  - Embedded `<ChatPanel seedRequest={...}>` — seeded with current plan/goal
    context; **`TrainingPlan.tsx` re-fetches `/api/plan` when a chat turn
    completes**, so the draft calendar/charts visibly update as the user riffs.
    A "Commit Plan" button appears when a draft exists.
- **Destructive-action confirmations** (never silently nuke load-bearing
  state): committing a draft *while an active plan exists* prompts "This will
  replace your current active plan"; deleting the active plan prompts to
  confirm. Archived plans remain in history.
- **`api.ts`:** `plan()`, `commitPlan(id)`, `deletePlan(id)`.
- **`types.ts`:** `TrainingPlan`, `PlanWorkout` (+ adherence verdict),
  `PlanDetail`, `PlanResponse`.
- **Rendering safety:** all plan-derived strings (`title`, `description`,
  `ability_snapshot`) render as escaped React text nodes — never markdown or
  `dangerouslySetInnerHTML` (§10).

### Data flow (create → track)

```
User (chat): "sub-50 10K, race Sept 14"
  → ChatPanel → POST /api/chat
  → AI grounds on read tools, then propose_training_plan(draft) ──► SQLite (status=draft, validated, atomic)
Tab re-fetches GET /api/plan on turn-complete → renders draft live
User (chat): "drop week-2 mileage"
  → AI revise_training_plan(draft) ──► SQLite updated (draft-only guard)
User clicks [Commit] → confirm-if-active → POST /api/plan/{id}/commit ──► BEGIN IMMEDIATE → status=active
Daily brief: get_training_plan_status → workout takeaway = today's session (recovery-reconciled) + yesterday's adherence
Tab: GET /api/plan → active plan + computed adherence + predicted finish
```

## 5. Failure modes & edge cases

- **Garmin lag** — prescribed days ≥ data frontier show `pending`, never
  `missed` (§3b). The brief grades only days with data.
- **Timezone / late-night runs** — both dates normalized before the join (§3b).
- **Two activities one day** — summed within type (§3a).
- **Quality session (interval/tempo)** — graded on duration/presence, not
  distance (§3a).
- **Cross-training day** — matched against non-running activities (§3a).
- **Race date passed** — tab still renders history; brief stops prescribing
  "today's session" past `race_date`; manual archive (no auto-archive in v1).
- **Draft abandoned** — a new `propose` archives the stale draft; one draft at
  a time.
- **Replace/delete the active plan** — confirmation required; archive is
  soft (history survives; reactivation is a fast-follow, §9).
- **Commit race / double-click** — partial unique index + `BEGIN IMMEDIATE`
  make the loser fail loudly (§3c).
- **Mid-write failure / restart during riff** — atomic delete+insert means the
  draft is never half-replaced (§4a). The in-memory chat transcript is lost
  (consistent with existing chat); the draft survives in SQLite.
- **Empty / oversized / malformed plan** — rejected at the tool boundary
  (empty, >~200 rows, NaN/Inf, bad dates, dup `(date,seq)`, out-of-range) (§4a).
- **`custom` goal with no distance** — `goal_distance_m` nullable (§3).
- **Model emits a non-takeaway brief field** — unchanged guardrails + salvage
  parser; we added no top-level field.

## 6. Testing strategy

- **Unit (`tests/`):** type-aware adherence classifier across all verdict
  boundaries incl. rest-compliant, interval-by-duration, cross-vs-non-running,
  null-target; data-frontier slicing (`pending` not `missed` for unsynced
  days); timezone/DST + Garmin-lag fixture; weekly mileage rollup; Riegel
  projection; commit transaction (exactly one active, prior archived);
  **draft-only write guards** (`revise` on an `active`/`archived` plan is a
  no-op error; `status` can never be set via any tool); validation rejects
  (empty, oversized, NaN/Inf, bad date, dup `(date,seq)`, out-of-range);
  adherence can't be whitewashed by editing/deleting plan rows (verdict comes
  from the activities join).
- **Security (`tests/test_security.py`):** `GET /api/plan`, commit, delete all
  401 without a bearer token; `plan_id` rejects non-int; commit-of-nonexistent
  → 404, commit-of-archived → 409; concurrent-commit yields exactly one active
  (index enforcement); plan strings are escaped in rendered output (no raw-HTML
  sink).
- **Schema regression:** brief with no active plan emits the normal workout
  takeaway and zero plan content; with an active plan the workout takeaway
  carries the plan; salvage parser still passes.
- **Prompt eval:** plan-quality scorer (ramp-rate sanity, taper presence,
  goal/date fit) per the existing scorer pattern.
- **Frontend:** `pnpm build` + `pnpm tsc --noEmit`; screenshots of the tab
  (empty state + populated state) per the UI-verification rule.
- **Container:** `docker compose up -d --build local-fitness` after changes.

## 7. API Surface

**Agent tools (MCP, `mcp__fitness__*`):**
- `get_training_plan_status() -> {active: bool, ...}` — read-only; brief gets structured fields only
- `propose_training_plan(goal_type: str, race_date: str, target_time_seconds?: int, goal_distance_m?: float, title?: str, ability_snapshot?: object, workouts: object[]) -> {plan_id, status:"draft"}`
- `revise_training_plan(plan_id: int, goal_type?: str, race_date?: str, target_time_seconds?: int, goal_distance_m?: float, title?: str, workouts?: object[]) -> {plan_id, status:"draft"}` — draft-only; never accepts `status`

**REST (`web/server.py`):**
- `GET /api/plan -> {active: PlanDetail|null, draft: PlanDetail|null}`
- `POST /api/plan/{plan_id:int}/commit -> {plan_id, status:"active"}` (404 missing, 409 not-draft)
- `DELETE /api/plan/{plan_id:int} -> {plan_id, status:"archived"}` (404 missing)

**Frontend API client (`web/src/lib/api.ts`):**
- `api.plan(): Promise<PlanResponse>`
- `api.commitPlan(planId: number): Promise<{plan_id:number; status:string}>`
- `api.deletePlan(planId: number): Promise<{plan_id:number; status:string}>`

## 8. Invariants

**Checkable by inspection:**
- Only new tables (`training_plans`, `plan_workouts`); no `ALTER` to any
  existing table; every needed column (incl. `seq`) is in the initial CREATE.
- All new REST paths start with `/api/` (auth-gated by existing middleware).
- No new path added to `RATE_LIMITED_PREFIXES` (no new endpoint calls Claude).
- `status` is never a tool input; `propose` hardcodes `'draft'`; `revise`'s
  editable-column whitelist excludes `status`/`committed_at`/`plan_id`/`created_at`.
- `revise` guards on the target row being `status='draft'` before writing.
- `goal_type` and workout `type` validated against frozen sets, numerics
  bounded (`isfinite`/non-negative/ceiling), dates `fromisoformat`-validated,
  `len(workouts)` capped — all before SQL; workout replacement is one
  transaction.
- `commit`/`delete` use integer path params and parameterized SQL.
- Partial unique index `idx_one_active_plan` exists on `status='active'`.
- All plan-derived strings render as escaped text (no `dangerouslySetInnerHTML`).
- No change to `Brief` / `Takeaway` schema or the salvage parser; no parallel
  brief card.

**Requires tests:**
- At most one `training_plans` row has `status='active'` at any time, including
  under concurrent commits.
- Commit archives the prior active plan atomically; re-commit of a
  non-draft is rejected.
- Type-aware adherence is correct across all boundaries; days ≥ data frontier
  are `pending`, not `missed`; adherence is immune to plan-row edits.
- The brief emits no plan content with no active plan, and folds the plan into
  the workout takeaway with one active.
- `get_training_plan_status` returns correct most-recent-graded / today slices
  relative to `db.last_known_daily_date()`.
- Riegel predicted-finish matches the expected value for a known best effort.

## 9. Open questions (deferred, non-blocking)

- **Reactivation / un-archive** of a soft-deleted plan: v1 ships archive only
  (history survives but isn't reachable in the UI); add a restore action if the
  need shows up.
- **Auto-archive** once `race_date` passes: deferred — manual archive for v1 to
  avoid surprising deletions.
- **Trajectory target ramp:** cut from v1 (no defensible data source). If a
  credible "safe build" model emerges (e.g. capped 10%/week CTL ramp framed as
  guidance, not a requirement), add it as a fast-follow.
- **Plan-generation model default:** reuses the chat Sonnet/Opus toggle;
  revisit if Sonnet plans score consistently weak on the plan-quality eval and
  we want to force Opus for the first generation.

## 10. Security model

This feature adds the **first agent→SQLite write path**, so the trust boundary
is explicit:

- **Threat:** AI tool calls are steerable by chat input and by `user_notes.md`
  content injected into every system prompt. **Mitigation:** the AI can only
  ever write `draft` rows (status hardcoded; status-excluding whitelist; revise
  status-guard — §4a). Activation/deletion require a human click with
  confirmation. An injected note therefore cannot reach `active` state or the
  daily brief without the user committing.
- **Adherence integrity:** verdicts are computed from the `activities` join,
  never from AI-authored plan fields — so an injected note that asks the AI to
  "never show missed workouts" cannot whitewash adherence (the brief still
  grades real Garmin data).
- **Second-order prompt injection:** AI-authored `description`/`title` are
  length-capped and passed to the brief model as fenced *data*, not
  instructions; `get_training_plan_status` returns structured fields to the
  brief and keeps free-form prose to the tab REST path.
- **Stored XSS / token theft:** the bearer token lives in `localStorage`; all
  AI-authored strings render as escaped React text (no markdown /
  `dangerouslySetInnerHTML`). A `Content-Security-Policy: script-src 'self'`
  header is added to the existing `security_headers` middleware as
  defense-in-depth.
- **Input validation / DoS:** all tool inputs validated/bounded; `len(workouts)`
  capped; writes atomic. No new Claude-cost REST endpoint, so no new rate-limit
  surface.
- **Concurrency:** single-active enforced at the DB (partial unique index) plus
  `BEGIN IMMEDIATE`; a racing commit fails loudly.
