---
ticket: "#21"
title: "Make the fitness MCP the primary interface"
date: "2026-06-16"
source: "design"
---

# Make the fitness MCP the primary interface

## Goal

Today the MCP exposes 15 raw-data tools (the starting point — this design
adds 6, taking `ALL_TOOLS` to 21). They're good, but the *coaching
synthesis* — the curated daily brief, the coach voice, the user's saved
preferences, miles units — all lives server-side in the brief-generation
loop and **never travels to an MCP client**. Talking to the MCP gets you a
competent analyst improvising from raw rows, not your coach.

This design closes that gap so that, in **Claude Code (the chosen primary
client)**, the MCP delivers the brief *and* conversational follow-up — making
it preferable to the UI. It also adds a **write surface** so the MCP becomes a
place you *tell* things, not just query.

## Key insight

An **MCP prompt handler runs server-side and can query SQLite directly.** So a
single `/fitness:coach` slash command can assemble the full snapshot *and*
inject the coach persona + saved notes in **one round-trip — zero tool-call
latency, zero server-side Claude cost.** That is the moat-breaker: it's the
brief, live and conversational.

The MCP currently uses **only the `tools` primitive**. The two unused
primitives — `prompts` and `resources` — are exactly how persona, preferences,
and the saved brief reach a client.

## Scope (all six, per decision 2026-06-16)

| # | Item | Primitive | Surface |
|---|------|-----------|---------|
| 1 | `coach` prompt — assembled snapshot + persona + notes | prompt | standalone MCP only |
| 2 | `daily_snapshot` tool — one-call assembled status | tool | chat loop + standalone MCP (NOT brief loop) |
| 3 | Server-side miles / pace / duration formatting | — | all read tools |
| 4 | `fitness://schema` resource — columns + run_sql guide | resource | standalone MCP only |
| 5 | `fitness://brief/latest` resource — most recent brief, rendered from JSON | resource | standalone MCP only |
| 6 | Write surface — observations + manual workouts | tools | chat loop + standalone MCP (NOT brief loop) |

## Architecture

### Surface divergence (new, deliberate)

- **Tools** stay in `agent/tools.py` / `ALL_TOOLS` → registered on **every**
  surface (brief loop, chat loop, web agent, standalone MCP). Read tools and
  write tools both live here, matching the existing notes-CRUD precedent.
- **The brief generator must NOT be able to call write tools; the chat loop
  SHOULD.** Because `allowed_tool_names()` returns *all* tools and there is no
  `allowed_tools` restriction today, every tool added to `ALL_TOOLS` is
  auto-exposed to the brief-generation loop (`briefing.py:368`) as well as
  chat. We resolve this with an **explicit read-only allow-list**, not a
  denylist and not by trusting the prompt. Introduce a new helper
  `read_only_tool_names()` that returns an **explicit list of the read tools**
  (equivalently, a per-tool `read_only=True` marker that this helper collects).
  The brief-generation `ClaudeAgentOptions` sets
  `allowed_tools=read_only_tool_names()`; the chat loop keeps the **full** set
  including writes. The allow-list is deliberate so that a denylist can never
  silently re-grant write access: **the default for any newly added tool is
  NOT in the brief's allowed set unless it is explicitly listed as read-only.**
  A future write tool someone forgets about is excluded by construction, not by
  remembering to exclude it.
- **The brief loop's allowed set is held EXACTLY as today's read tools.**
  `daily_snapshot` is a new tool but is **not** added to the brief loop's
  allowed set — adding it would change which tools the brief calls, a
  brief-behavior change that per project policy would require the prompt
  scorer / A-B run, not just pytest. By keeping `read_only_tool_names()` to the
  existing read tools, brief behavior is unchanged and **no scorer run is
  required.** `daily_snapshot` is exposed to the chat loop and the standalone
  MCP only.
- **Prompts and resources** are registered **only on the standalone server**
  in `web/mcp_server.py`, directly on the low-level `Server` instance via
  `@server.list_prompts` / `@server.get_prompt` / `@server.list_resources` /
  `@server.read_resource`. The brief/chat agent loop does not get them (it
  doesn't need them). This is clean divergence: the agent loop gets data tools;
  the interactive client gets data tools **plus** coach prompt **plus**
  resources.

### Shared assembler (DRY)

New module `agent/status.py`:

- `assemble_status() -> dict` — the single source of the "daily snapshot":
  per-metric status, training-load read (CTL/ATL/TSB + plain-English
  interpretation), recent workouts in **miles**, and the active user notes.

  **Per-metric treatment is explicit and bounded by what the `baselines` table
  actually stores.** Only a handful of metrics have 60-day baseline columns;
  the rest of the ~18 `DAILY_NUMERIC_METRICS` have none, so the snapshot must
  **never emit a delta against a nonexistent baseline column.** Crucially, the
  baseline column name is **not** derivable as `f"{metric}_60day_mean"` from the
  `DAILY_NUMERIC_METRICS` key — the key `avg_stress` would resolve to the
  nonexistent `avg_stress_60day_mean`, while the real column is `stress_60day_mean`
  (derived from `AVG(avg_stress)`). The treatment is driven by this **explicit
  metric → baseline-column map**, which is the **only** source of baseline-delta
  rows:

  | metric key (in `DAILY_NUMERIC_METRICS`) | baseline column(s) |
  |---|---|
  | `rhr` | `rhr_60day_mean` (+ `rhr_60day_sd`) |
  | `sleep_seconds` | `sleep_seconds_60day_mean` (+ `sleep_seconds_60day_sd`) |
  | `avg_stress` | `stress_60day_mean` |
  | `body_battery_max` | `body_battery_max_60day_mean` |
  | `body_battery_min` | `body_battery_min_60day_mean` |

  - **Real baseline delta + ↑/↓/→ arrow** (compared to the stored 60-day
    baseline): exactly the five metrics in the map above, looked up by the
    explicit map — never by a derived column name. No other metric ever gets a
    delta.
  - **Raw value + 7-day-trend arrow** (arrow computed from recent
    `daily_metrics` rows, *not* from a 60-day baseline — no delta % shown):
    the remaining `DAILY_NUMERIC_METRICS` for which a short recent trend is
    meaningful (this includes `max_stress`, which has no baseline column).
  - **Raw value only** (no delta, no arrow): metrics where neither a baseline
    column nor a meaningful short trend exists.

  Each snapshot row carries which treatment produced it, so a consumer can tell
  a baseline-delta from a trend-arrow from a bare value.
- Consumed by the `daily_snapshot` **tool** (returns the dict) and the `coach`
  **prompt** (renders the dict to markdown + prepends persona/notes).

New module `agent/units.py`:

- `to_miles(meters)`, `format_pace_min_per_mi(sec_per_km)` → `"8:06"`,
  `format_duration(seconds)` → `"31:00"` / `"1:02:30"`.
- **Null / zero guards:** `format_pace_min_per_mi(sec_per_km)` and the miles
  helpers guard against `None` or `0` input — e.g. a manual strength workout with
  `distance_mi=None` or a 0-distance session. A null/0 pace **omits** the
  formatted field (it is simply not added to the row) and **never** divides by
  zero. This mirrors the existing `if pace_sec` guard in `server.py`.
- Read tools (`query_workouts`, `get_workout_detail`, the assembler) add
  `*_mi` / formatted fields **alongside** the raw values — raw is never
  removed, so analysis (`correlate`, `run_sql`) is unaffected.
- Default unit system from `LOCAL_FITNESS_DISPLAY_UNITS` (default `miles`),
  per the project's env-driven pattern. As a new env var it must be documented
  in `.env.example` (commented-out placeholder, default `miles`, one-line
  explanation) and in `docs/deployment.md`'s compose snippet.
- **`km` branch behavior (env var fully wired, not half):** the raw fields
  (`distance_meters`, `avg_pace_sec_per_km`) are **always present regardless** of
  the unit setting. Under `LOCAL_FITNESS_DISPLAY_UNITS=km` the convenience
  `*_mi` / min-per-mi fields are simply **suppressed** (not emitted) — chosen for
  v1 over computing `*_km` equivalents, so the env var has defined behavior on
  both branches rather than being half-wired.

### Coach prompt: embed vs. defer

The `coach` prompt **embeds** the assembled snapshot directly in the returned
prompt message (the whole latency/cost win). The data is a *bootstrap* — the
model can re-call `daily_snapshot` for fresh data later in the conversation, so
staleness is a non-issue.

## Data model (deep dive)

### New table: `observations`

**Grain:** *one row = one timestamped observation the user reported, optionally
about a specific workout.* (Single sentence — passes the grain test.)

```sql
CREATE TABLE IF NOT EXISTS observations (
    observation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_on     TEXT NOT NULL,              -- YYYY-MM-DD the obs is about
    created_at      TEXT NOT NULL,              -- ISO timestamp written
    obs_type        TEXT NOT NULL,              -- frozen whitelist (below)
    value_num       REAL,                       -- weight/rpe/score numerics
    value_text      TEXT,                       -- feeling/injury/note free text
    activity_id     INTEGER                     -- nullable SOFT ref -> activities.activity_id
                                                -- (advisory only; SQLite FK enforcement
                                                -- is OFF and there is no FOREIGN KEY clause)
);
CREATE INDEX IF NOT EXISTS idx_obs_date ON observations(observed_on);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(obs_type);
```

**Migration placement:** the `observations` `CREATE TABLE IF NOT EXISTS` and
its two indexes go **inside** the `SCHEMA` string that `init_schema()` feeds to
`conn.executescript(SCHEMA)` — they are idempotent on their own, so the call
structure is unchanged. The `activities.source` column add (below) is the *only*
piece that cannot live in `SCHEMA`.

- `obs_type` frozen whitelist (validated in code, never f-string'd into SQL):
  `{weight, rpe, soreness, energy, mood, feeling, injury, note}`. Define this
  once as a module-level constant (e.g. `OBS_TYPES`) — the same
  single-source-of-truth discipline applied to `QUERYABLE_SCHEMA` — so the
  validation set, the DDL comment, and any docs reference one definition rather
  than drifting copies. A rejected `obs_type` returns via the existing `_err()`
  error contract (tools.py:39) — a structured error result, not a raised
  exception.
- **Relationship story:** `activity_id` is a **soft/advisory reference** to
  `activities.activity_id` meaning "this observation is about that workout"
  (e.g. RPE on a run). Null = a whole-day observation. It is **not** an enforced
  foreign key: SQLite FK enforcement is OFF (`connect()` issues no
  `PRAGMA foreign_keys = ON`) and the DDL has no `FOREIGN KEY` clause, so the
  reference is maintained in application code, not by the engine. To keep the
  reference from dangling, `log_observation` validates a non-null `activity_id`
  against `activities` (existence check) and `delete_manual_workout` cleans up
  observations pointing at the deleted row (both below).
- **Durability:** survives independent of the Garmin wellness schema; simple
  types only; no application-specific encoding. The Garmin `daily_metrics`
  table is never mixed with user-entered data — provenance stays clean.

### Changed table: `activities` — add `source`

```sql
ALTER TABLE activities ADD COLUMN source TEXT DEFAULT 'garmin';
```

This is a **separate guarded Python step** that runs in `init_schema()` **after**
`conn.executescript(SCHEMA)` — it **cannot** live in the `SCHEMA` string because
SQLite has no `ADD COLUMN IF NOT EXISTS`, so re-running the script on an existing
DB would raise "duplicate column name: source". The step: read
`PRAGMA table_info(activities)`, and only if `source` is absent from the returned
columns issue `ALTER TABLE activities ADD COLUMN source TEXT DEFAULT 'garmin'`.
On a DB that already has the column the ALTER is skipped entirely.

**Named invariant — `init_schema()` is idempotent:** calling it twice on the same
DB does not raise (the guarded `ALTER` is skipped on the second call). This is the
existing-DB-vs-fresh-clone safety net: `init_schema()` runs on every server boot
and on every test's `hermetic_db`, so a non-idempotent migration would break both
paths. (No migration framework exists.)

- Manual workouts insert with `source = 'manual'` and a **negative synthetic
  `activity_id`** computed as `MIN(MIN(activity_id), 0) - 1` — i.e. floor the
  existing minimum at 0 *before* subtracting, so on an all-positive Garmin
  table the first manual workout gets `-1` (never a positive id). Garmin only
  ever upserts *positive* IDs it returns, so re-ingest can never collide with,
  overwrite, or delete a manual row. The sign alone disambiguates; `source`
  adds queryability and labeling.
- Because `baselines.recompute()` derives CTL/ATL/TSB from
  `SUM(activities.training_load)`, a manual workout with a `training_load`
  value flows into training load just by calling recompute with a lookback
  window wide enough to cover the workout's own date (see the
  `log_manual_workout` API entry). No new pipeline.
- **Expected behavior:** `baselines.recompute()` is **synchronous** and re-walks
  every date from the earliest activity to today on each manual insert/delete
  (it seeds the EWMA from the start regardless of the write window). So a
  `log_manual_workout` call over HTTP will have a noticeable pause. This is fine
  at personal scale — we intentionally do **not** add async/background scope.

## API Surface

### New tools (in `agent/tools.py`, added to `ALL_TOOLS`)

```
daily_snapshot() -> dict
    Read-only. Assembled, display-ready status: snapshot rows tagged by
    treatment — each row has `treatment` ∈ {baseline_delta, trend_arrow, raw};
    `baseline`/`delta_pct` are present ONLY on baseline_delta rows, `arrow` on
    baseline_delta and trend_arrow rows, so a row looks like
    [{metric, today, treatment, baseline?, delta_pct?, arrow?}] (matching the
    assembler's three treatments), training-load read,
    recent workouts (miles), active user notes. Collapses today's
    4-call chain (status+load+workouts+notes) into one call.

log_observation(obs_type: str, value: float | None = None,
                text: str | None = None, date: str | None = None,
                activity_id: int | None = None) -> dict
    Insert one observation. obs_type validated against the frozen
    whitelist; value_num/value_text chosen by type; date defaults to
    today. A non-null activity_id is validated to EXIST in activities
    (existence check; FK is not engine-enforced) — if it doesn't, return
    via _err() and insert nothing, so the soft reference never dangles.
    Returns the stored row.

list_observations(days: int | None = None,
                  obs_type: str | None = None) -> list[dict]
    Recent observations, most-recent first, optionally filtered.

delete_observation(observation_id: int) -> dict
    Remove one observation by id (correction path; mirrors notes CRUD).
    If no observation exists at that id (already deleted), return
    `_err("no observation at id N")` — mirrors delete_user_note — rather
    than reporting a successful no-op delete.

log_manual_workout(activity_type: str, duration_min: int,
                   date: str | None = None, distance_mi: float | None = None,
                   avg_hr: int | None = None, training_load: float | None = None,
                   name: str | None = None) -> dict
    Insert a non-Garmin workout into `activities` with source='manual'
    and a negative synthetic activity_id. Because `activity_id` is
    INTEGER PRIMARY KEY (NOT AUTOINCREMENT), the id is supplied via a
    `MIN(MIN(activity_id), 0) - 1` SELECT-then-INSERT. This is reachable over
    HTTP, so two concurrent inserts could read the same MIN and collide on the
    PK. WRAP the read-min + insert in a single `BEGIN IMMEDIATE` SQLite
    transaction (write-lock acquired up front) so the SELECT and INSERT
    serialize and concurrent manual inserts get distinct decreasing ids — the
    notes store already uses fcntl.flock for the analogous race.
    Convert miles->meters; then
    call baselines.recompute(lookback_days=max(RECOMPUTE_LOOKBACK_DAYS,
    (today - workout_date).days + 1)) so CTL/ATL/TSB are rewritten for the
    workout's OWN date and every date after it — not just the trailing
    90-day default window. (recompute() seeds the EWMA from the earliest
    activity but only WRITES baseline rows inside the lookback window, so a
    backdated workout older than 90 days would otherwise perturb forward
    EWMA without ever rewriting its own date's row.) Returns the row +
    confirmation that load was recomputed.

delete_manual_workout(activity_id: int) -> dict
    REFUSES activity_id >= 0 (never deletes Garmin data). If no manual row
    exists at that id (already deleted), return `_err("no manual workout at
    id N")` — mirrors delete_user_note — rather than recomputing baselines
    over nothing. Ordering matters:
    (1) READ the workout's date from the row FIRST (needed to compute the
    widened recompute lookback — must happen before the row is gone);
    (2) NULL OUT observations.activity_id for every observation pointing at
    this id (the activity_id is a soft ref with no engine cascade, so this is
    manual) — the observations themselves are kept, just detached;
    (3) DELETE the activities row;
    (4) recompute with the widened lookback
    (max(RECOMPUTE_LOOKBACK_DAYS, (today - workout_date).days + 1)) so the
    deleted workout's own date and everything after it are rewritten.
```

### New prompts (in `web/mcp_server.py`, standalone server only)

```
coach(focus: str | None = None)
    Returns a single user-role prompt message containing: the coach persona
    (embed `prompts.system_prompt()` — which ALREADY calls
    `notes.render_for_prompt()` internally and embeds the active user notes as
    a section, so the notes arrive transitively via the persona) and the
    rendered daily snapshot. Do NOT separately render or append
    `render_for_prompt()` on top of the persona — that would print the notes
    twice. Surfaces in Claude Code as /fitness:coach.
    Optional
    `focus` narrows the framing (e.g. "recovery", "should I train hard").
    Because `focus` is an argument, the list_prompts handler must declare
    it as PromptArgument(name="focus", required=False) so the client offers
    it without making it mandatory.
```

### New resources (in `web/mcp_server.py`, standalone server only)

```
fitness://schema        -> DB tables, queryable column whitelist, and
                           run_sql usage notes (makes run_sql reliable).
                           SINGLE SOURCE OF TRUTH: the queryable-table/column
                           list lives in ONE module-level constant (e.g.
                           QUERYABLE_SCHEMA in tools.py). The `fitness://schema`
                           resource RENDERS that constant, and `run_sql`'s
                           docstring/table-list description REFERENCES the same
                           constant — neither hand-maintains its own copy, so the
                           two cannot drift. Adding `observations` to that one
                           constant makes it queryable on the read path via both
                           run_sql and the resource at once; writes still go only
                           through the dedicated tools (run_sql's guard already
                           blocks insert/update/delete).
fitness://brief/latest  -> the most recent saved brief, rendered to markdown.
                           Briefs are persisted as JSON (`Brief` pydantic model,
                           file named for `date.today()`), and `load_today()`
                           only loads TODAY's file (returns None otherwise) —
                           there is no markdown brief on disk and no "latest"
                           loader. So the resource handler must itself: (a) glob
                           `briefings/*.json` and pick the most recent by the
                           filename date; (b) deserialize the `Brief` model and
                           RENDER it to markdown (it is structured Takeaways, not
                           markdown on disk); (c) when briefings/ is empty (fresh
                           clone — the dir is gitignored), return a graceful
                           "no brief generated yet" payload rather than erroring.
```

## Invariants

**Checkable by inspection:**

- `observations` grain holds: one row = one timestamped user observation.
- `obs_type` is validated against the frozen whitelist; no user string is
  f-string'd into SQL (values parameterized via `?`).
- Manual workouts use `activity_id < 0`; the id is `MIN(MIN(activity_id), 0) - 1`
  (existing min floored at 0 before subtracting), so the first manual workout on
  an all-positive Garmin table is `-1`, never a positive id. The Garmin
  ingest/upsert path only ever writes positive IDs (verify before relying:
  `ingest/daily.py` + `backfill.py` use INSERT OR REPLACE keyed on Garmin's
  positive `activityId`) → no collision possible.
- Synthetic-id allocation + insert is atomic under `BEGIN IMMEDIATE`; the
  SELECT `MIN(MIN(activity_id), 0) - 1` and the INSERT serialize against the
  up-front write lock, so concurrent manual inserts get distinct decreasing ids
  (no two read the same MIN and collide on the PK).
- `delete_manual_workout` refuses `activity_id >= 0`.
- `observations.activity_id` is a soft/advisory reference, not an engine-enforced
  FK (SQLite FK enforcement is OFF; the DDL has no `FOREIGN KEY` clause). It is
  kept non-dangling in application code: `log_observation` rejects a non-null
  `activity_id` that doesn't exist in `activities` (existence check → `_err()`,
  no insert).
- `delete_manual_workout` never leaves an observation pointing at a deleted
  workout: before deleting the `activities` row it NULLs out
  `observations.activity_id` for every observation referencing that id (keeping
  the observations, just detached), so no observation is silently orphaned.
- `delete_manual_workout` reads the workout's date BEFORE deleting the row, so
  the widened recompute lookback can be computed from a date that still exists.
- `log_manual_workout` always populates `activities.date` (a NOT NULL column),
  defaulting `None` → today; a manual row is never inserted with a null date.
- A manual insert writes **zero** rows to `activity_hr_zones` and
  `activity_splits` (these are keyed on `activity_id` with no FK/cascade to
  `activities`), so `delete_manual_workout` deletes only the `activities` row
  and leaves no orphans — because no child rows were ever created.
- The brief-generation loop's `allowed_tools` is exactly `read_only_tool_names()`
  — an explicit read-only allow-list, never a denylist; a newly added tool is
  absent from the brief's allowed set unless explicitly marked read-only, so it
  cannot invoke any write tool (`log_observation`, `log_manual_workout`,
  `delete_observation`, `delete_manual_workout`, note-write tools). The chat
  loop retains the full set.
- The brief loop's allowed set equals today's existing read tools; `daily_snapshot`
  is **not** in it, so brief behavior is unchanged and no prompt-scorer / A-B run
  is required.
- `daily_snapshot` and `coach` are pure read assemblers — no mutation.
- The snapshot never emits a delta against a metric without a baseline column:
  baseline-delta rows are restricted to the five metrics in the explicit
  metric → baseline-column map (`rhr`→`rhr_60day_mean`, `sleep_seconds`→
  `sleep_seconds_60day_mean`, `avg_stress`→`stress_60day_mean`, `body_battery_max`→
  `body_battery_max_60day_mean`, `body_battery_min`→`body_battery_min_60day_mean`),
  looked up by that map and never by a derived `f"{metric}_60day_mean"` name; all
  other metrics (including `max_stress`) get a 7-day-trend arrow or a raw value only.
- Read tools augment with formatted fields; they never drop raw values.
- Prompts/resources live under `/mcp`, already gated by `_is_public_path()` on
  the HTTP transport (token required); they do not introduce a new public path.
  **Verify against `server.py` before writing the security test:** confirm the
  `/mcp` mount is inside the auth-gated path and that resource reads don't bypass
  the middleware.

**Requires tests:**

- After `log_manual_workout`, `baselines.recompute()` runs and CTL/ATL/TSB
  reflect the added load (integration test).
- A **backdated** manual workout (older than `RECOMPUTE_LOOKBACK_DAYS`)
  rewrites its **own date's** CTL/ATL/TSB baseline row — not just forward
  dates. (Asserts the widened `lookback_days` covers the workout's date.)
- Brief generation cannot invoke a write tool: the brief loop's `allowed_tools`
  is `read_only_tool_names()` (explicit allow-list), so a brief run never mutates
  `observations` or `activities`. Asserts that no write tool — and no
  not-explicitly-read-only tool such as `daily_snapshot` — appears in
  `read_only_tool_names()`, so the brief's tool set is unchanged from today.
- Re-running Garmin ingest leaves manual (negative-id) rows untouched (depends
  on the Garmin upsert only ever writing positive IDs — verify before relying:
  confirm `ingest/daily.py` + `backfill.py` use INSERT OR REPLACE keyed on
  Garmin's positive `activityId`, never on a manual negative id).
- `log_observation` round-trips; `list`/`delete` work; invalid `obs_type`
  rejected.
- `daily_snapshot` miles fields + arrows match the underlying raw data.
- `coach` prompt embeds active user notes **transitively via
  `prompts.system_prompt()`** (which calls `render_for_prompt()` internally),
  and the notes appear **exactly once** (regression: a saved note appears in the
  prompt text, and the coach prompt does NOT separately render/append
  `render_for_prompt()` on top of the persona — assert no duplicate notes
  section).
- `init_schema()` is idempotent: calling it twice on the same DB does not raise
  (the guarded `ALTER TABLE activities ADD COLUMN source` is skipped on the second
  call). Covers the existing-DB-vs-fresh-clone path that runs on every server boot
  and every `hermetic_db`.
- On a brand-new/empty DB (no `daily_metrics`, `activities`, or `baselines` rows),
  `daily_snapshot` and the `coach` prompt return a sane empty payload and **never
  raise** — `assemble_status()` is the new glue where a naive
  `baseline["rhr_60day_mean"]` deref or a None-row access would otherwise throw.
- Security: a write tool invoked over HTTP without the bearer token → 401
  (new case in `tests/test_security.py`).

## Integration risks & mitigations

1. **Does registering prompts/resources on the SDK-wired Server surface them
   in the handshake?** Obtaining the low-level `Server` instance is
   **already-solved**: `web/mcp_server.py:39` already does
   `make_server()["instance"]` to get a real `mcp.server.lowlevel.Server` and
   drives a transport on it — so getting the instance is settled, not open.
   The genuine open question is narrower: after `create_sdk_mcp_server()` has
   wired its **tool** handlers onto that instance, does *additionally*
   registering `@server.list_prompts` / `@server.get_prompt` /
   `@server.list_resources` / `@server.read_resource` on the same instance
   actually compose and surface those capabilities in the `initialize`
   handshake — i.e. is capability advertisement computed **dynamically** from
   the registered handlers, or **frozen** at construction? Prior investigation
   indicates capabilities are computed dynamically at `initialize` time, so the
   primary path (register on the SDK instance) is expected to work — but this is
   **the one spike to run first.** *Fallback (last resort, only if the spike
   fails):* construct the low-level `Server` directly. Note the tension: doing
   so means **not** reusing `make_server()["instance"]`, which would break the
   single-source-of-truth-for-tools invariant the standalone server is built
   around — so the fallback must **re-register the SDK tools** alongside the new
   prompts/resources. Verify in Claude Code (`/mcp` shows prompts; `@fitness:`
   shows resources).
2. **Write tools exposed to the brief loop.** Adding writes to `ALL_TOOLS`
   would otherwise expose them to brief generation, since
   `allowed_tool_names()` returns all tools with no `allowed_tools`
   restriction. *Resolved* by an `allowed_tools` split (see Architecture →
   Surface divergence): the brief-generation `ClaudeAgentOptions` is restricted
   to `read_only_tool_names()`, so the brief generator structurally cannot invoke
   a write tool — and a future write tool is excluded by default rather than by
   remembering to add it to a denylist. The chat loop keeps the full set. Not
   waved off — enforced in config and covered by a test (brief generation cannot
   invoke a write tool).
3. **`ALTER TABLE activities`.** Guard with `PRAGMA table_info` so `init_schema`
   stays idempotent across existing and fresh DBs.
4. **Auth-free stdio + writes.** stdio is local-only by design; writes hit the
   user's own DB. HTTP writes are token-gated. No new network exposure.

## Acceptance criteria

- `/fitness:coach` in Claude Code returns the full snapshot in coach voice,
  honoring saved notes and miles, in one round-trip.
- `daily_snapshot` returns the assembled status in a single tool call.
- Workout/status outputs show miles + min/mi + h:mm alongside raw.
- Can log RPE, soreness, weight, a feeling, and a manual strength/bike session
  by talking to the MCP; a manual run with a training_load shifts CTL/ATL/TSB.
- `@fitness:schema` and `@fitness:brief/latest` resolve in Claude Code.
- `uv run pytest -x` green, including new security + integration cases.
- **Tests to update:** the six new tools take `ALL_TOOLS` from 15 to 21, so
  `tests/test_smoke.py:42`'s `assert len(agent_tools.ALL_TOOLS) == 15` must be
  bumped to `== 21`. The derived tests (`test_mcp_server.py`, `test_tools.py`)
  auto-track `ALL_TOOLS` and need no change.
- Container rebuilt; live at fitness.home.local.

## Out of scope (reactive v2)

- Editing/append to existing manual workouts (delete + re-add for now).
- HRV / extra metrics into `find_anomalies` (still rhr/sleep enum).
- A `weekly` prompt and `should-i-train` prompt (trivial follow-ons — reuse the
  assembler once `coach` proves out).
- Splitting write tools off the agent-loop surface.
