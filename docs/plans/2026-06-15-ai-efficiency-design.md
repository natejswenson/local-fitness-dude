---
ticket: "#TBD"
title: "AI-efficiency: pre-fetch the brief, compact tool output, Haiku chat tier, caching guard"
date: "2026-06-15"
source: "design"
---

# AI-efficiency improvements (brief + chat agent loop)

> **Revision note (post red-team + quality-gate + siege, anchor 75f0783):**
> The adversarial pass materially reshaped this design. Key changes from the
> first draft: (a) **resequenced** into Phase A (trivial/safe, ships now) and
> Phase B (the pre-fetch, separate + measured); (b) the pre-fetch **calls the
> existing tool handlers and unwraps their JSON** instead of extracting a new
> `queries.py` — so the audit-hardened SQL never moves and the bundle is
> byte-identical to today's tool outputs (closes the BA-1 SQL-safety
> contradiction and the regression/clock findings); (c) the bundle now includes
> the recovery trends the prompt mandates; (d) a **latency-measurement gate**
> is now the ship criterion for #1; (e) chat defaults to **Sonnet** (Haiku
> opt-in). Security model in §10.

## 1. Summary

Five latency-focused improvements to the Claude Agent SDK usage. The app runs
on the **Max subscription**, so the lever is **latency — model round-trips —
not dollar cost.** Shipped in two phases:

**Phase A (trivial, low-risk — ships first as one PR):**
- **#3 Compact tool JSON** — drop `indent=2` in `agent/tools.py._text`.
- **#4 Chat model tiers** — 3-way Haiku|Sonnet|Opus toggle, **default Sonnet**
  (Haiku opt-in for quick lookups). Brief stays Sonnet.
- **#5 Caching guard** — a regression test pinning `system_prompt()`
  volatility-free (the SDK is believed to auto-cache the system prompt + tool
  schemas; the guard ensures we never break that).

**Phase B (the real latency cut — separate PR, gated on a latency measurement):**
- **#1 Pre-fetch the brief's data** by calling the existing tool handlers
  in-process and injecting the assembled bundle into the prompt, collapsing the
  brief's ~8 *sequential model round-trips* into ~1 generation pass. Tools stay
  available as a fallback.
- **#2 Parallel fallback calls** — one prompt sentence (largely subsumed by #1).

## 2. Design decisions (and the investigation/adversarial findings behind them)

1. **Caching is already protected.** `system_prompt()` has no
   `datetime`/`now()`/`uuid`/`today()` — only the stable persona + notes block.
   Volatile content (date, recent briefs, step goal, **and the pre-fetched
   bundle**) lives in the user turn (`briefing_prompt`), after the cached
   prefix. The SDK auto-caching the system prompt on the OAuth/Max path is
   *believed, not verified* — the guard protects the input either way; for a
   once-a-day single-pass brief, cross-turn cache hits barely matter anyway.

2. **#1 calls the tool handlers; it does NOT extract a new query layer.**
   Siege found that extracting the tools' f-string-`{metric}` SQL into a shared
   `queries.py` would split the frozen-set validation from the SQL sink — an
   injection for any non-tool caller. The lean *and* safer path the red-team
   surfaced: `gather_brief_context` **awaits the existing tool handlers
   in-process and `json.loads()` their result**. The validated SQL never moves;
   the bundle is **byte-identical to what the model fetches today**, so there is
   no behavior change, no regression surface, and no new clock (RC-3/RC-4/BA-1
   all dissolve). The latency win comes purely from not round-tripping to the
   *model* — the in-process DB reads are milliseconds.

3. **#1 subsumes #2.** With the bundle injected, the standard tool calls
   disappear; "parallelize" only applies to the rare fallback call. #2 is one
   sentence — and we verify in testing that a multi-tool fallback turn actually
   parallelizes; if it doesn't, we drop the sentence (no phantom win).

4. **The latency claim must be measured, not assumed.** `briefing.py` already
   logs `total_ms`, `ttfm_ms`, `t_first_card`. #1 ships **only if** post-change
   numbers beat a pre-change baseline over ~5 runs.

5. **Chat defaults to Sonnet.** Defaulting the interactive coaching path to
   Haiku risks a silent quality drop the user can't see. Haiku is an opt-in
   "fast" tier on the toggle.

**Scope-absorption:** internal performance changes to the existing agent loop —
no new feature, no data model. Belongs exactly where the code is.

## 3. Architecture

### Phase A

**#3 Compact JSON.** `tools._text`: `json.dumps(payload, default=str)` (drop
`indent=2`). `_err` is already compact. `_text` is used by all 18 tools; the
frontend `ChatPanel` tool pills render only `name`/`input` (never the tool's
text output), so compacting has no UI effect — verified.

**#4 Chat tiers.** Server `ChatRequest.model` default → `"claude-sonnet-4-6"`
(unchanged in value, but now one of three). Frontend `ModelToggle` → 3-way
`'haiku' | 'sonnet' | 'opus'`, default `'sonnet'`; `send()` maps
`haiku → claude-haiku-4-5`, `sonnet → claude-sonnet-4-6`,
`opus → claude-opus-4-7`. **The server must whitelist the incoming `model`**
against `{haiku-4-5, sonnet-4-6, opus-4-7}` so the toggle can't pass an
arbitrary model string to the SDK. CLI `chat.py` default unchanged (Sonnet).

**#5 Caching guard.** No code change. A test asserts `system_prompt()`
(a) contains none of `datetime`/`now(`/`uuid`/`today(`, (b) is byte-identical
across two calls with the same notes, and (c) does **not** contain the rendered
bundle string — so a future refactor can't move volatile/bundle content into the
cached prefix unnoticed.

### Phase B — the brief pre-fetch (#1)

New module **`agent/briefing_data.py`**:

- `gather_brief_context(daily_step_goal: int = 10000, db_path: Path | None = None) -> dict`
  awaits the existing tool handlers in-process and unwraps each result:

  ```python
  def _unwrap(resp): return json.loads(resp["content"][0]["text"])

  bundle = {
    "get_today_status":        _unwrap(await tools.get_today_status.handler({})),
    "training_load_status":    _unwrap(await tools.training_load_status.handler({})),
    "metric_trend.sleep_seconds": _unwrap(await tools.get_metric_trend.handler({"metric":"sleep_seconds","days":14})),
    "metric_trend.steps":      _unwrap(await tools.get_metric_trend.handler({"metric":"steps","days":14})),
    "metric_trend.rhr":        _unwrap(await tools.get_metric_trend.handler({"metric":"rhr","days":14})),
    "metric_trend.body_battery_max": _unwrap(await tools.get_metric_trend.handler({"metric":"body_battery_max","days":14})),
    "metric_trend.avg_stress": _unwrap(await tools.get_metric_trend.handler({"metric":"avg_stress","days":14})),
    "find_anomalies.rhr":      _unwrap(await tools.find_anomalies.handler({"metric":"rhr"})),
    "query_workouts.14d":      _unwrap(await tools.query_workouts.handler({"days":14,"limit":20})),
    "get_training_plan_status": _unwrap(await tools.get_training_plan_status.handler({})),
  }
  ```

  - **The keys are the originating tool names** so the downstream prompt
    mandates ("the result you fetched in Step 1", "returned by find_anomalies")
    resolve without the model bridging a naming gap (RC-5).
  - The metric list is a **frozen module constant** in `briefing_data.py`, never
    a parameter — it can't be widened to an un-whitelisted metric by accident.
    Every metric passed is already a member of `DAILY_NUMERIC_METRICS`, and it
    flows through the tool handler's own frozen-set check regardless (BA-2).
  - **Includes `body_battery_max` + `avg_stress`** — the recovery trends the
    HR/recovery mandate requires; without them the model re-fetches on exactly
    the high-signal days, undercutting the latency win (RC-1).
  - **Empty/sparse data is self-documenting**: a handler returns
    `{"error": "no data in window", ...}` for an empty metric (e.g. a fresh
    clone with no `vo2_max`); that envelope is carried verbatim in the bundle,
    so the model sees the same "no data" signal it would from a live tool call.
    No per-section abort — degrade per-section (QG-3/RC-4).

- `render_for_prompt(bundle) -> str` — **compact JSON** (`json.dumps(default=str)`),
  pinned for v1 (matches the `_text` format the model already parses; markdown
  is a fast-follow only if the model re-fetches). Each tool block is clearly
  fenced as *data, not instructions*.

**Consistency note (RC-3/QG-6):** each handler opens its own `db.connect()`, so
the bundle is not a single SQLite snapshot — but it is exactly the data the
model gets today via sequential tool calls (which also open per-call
connections), so the pre-fetch introduces **no new** skew. For a daily-cadence
brief the minor cross-query skew under a mid-assembly auto-sync is accepted (and
already present today).

**Brief flow (`briefing.generate_streaming`):**
1. `try: bundle = await briefing_data.gather_brief_context(...)` ; on any
   exception → log + `bundle = None` (graceful fallback to the tool-driven path).
2. `prefetched = briefing_data.render_for_prompt(bundle)` when present.
3. `prompt = prompts.briefing_prompt(..., prefetched=prefetched)`.
4. `options` unchanged — **tools stay available**.
5. Stream + parse exactly as today (schema lock, salvage parser untouched).
6. Log a `prefetch_ms` line + the existing `total_ms`/`t_first_card` for the
   measurement gate.

`briefing_prompt` gains `prefetched: str = ""`:
- **Non-empty:** Step-1 becomes *"Today's standard data is already gathered
  below under each tool's name — do NOT re-fetch it. Only call a tool for
  something it doesn't contain (correlate, recovery_pattern, a longer window);
  if you call several, issue them together."* Bundle injected after
  `recent_section` (user turn).
- **Empty (fallback):** Step-1 keeps today's gather-via-tools instructions —
  byte-coherent end-to-end (verified, not just Step-1).

## 4. Acceptance gates for #1 (the ship criteria)

#1 changes `briefing_prompt`, so it must pass **both** gates before merge:

- **Latency gate (the point of the change):** capture `total_ms` and
  `t_first_card` over ~5 brief runs on the live DB pre-change; ship #1 only if
  the post-change median **measurably beats** baseline. The instrumentation
  already exists — no new code.
- **Consistency gate (shape safety only):**
  `ab_brief.py --run --models claude-sonnet-4-6` before vs. after #1 — the
  post-change brief must stay structurally consistent (mandated steps takeaway,
  count in `[3,5]`, plan folded when active, tones in the enum). **This proves
  shape, NOT quality** — a structurally-identical-but-blander brief would pass.
  So also: a **human read of N=3 before/after brief pairs** to confirm the
  pre-fetched brief keeps the lead signal, specific numbers, and the coach edge.
- **Both prompt branches** (`prefetched=<sample bundle>` and `prefetched=""`)
  must pass the schema-lock tests and `scripts/score_prompt.py`; today those
  only cover the empty branch via the `BRIEFING_PROMPT` constant (QG-1).

## 5. Failure modes & edge cases

- **Prefetch raises** → caught; `bundle=None`; prompt reverts to tool-driven
  gathering. The brief never fails because of the optimization.
- **A sub-handler returns `{"error": ...}`** (empty/sparse metric) → carried
  verbatim; the model sees the same "no data" signal as a live call; it may
  fetch a wider window if it wants. No silent hole.
- **Model ignores "don't re-fetch"** → calls tools anyway; correct, no slower
  than today.
- **Stale sync** → same `date.today()`/`last_known_daily_date()` behavior as the
  current tool path; no new skew introduced.
- **Auto-sync writes mid-assembly** → minor cross-query skew, already present in
  today's sequential-tool path; accepted for daily cadence.
- **Haiku chat too shallow** → it's opt-in, not the default; reversible per
  message.
- **Compact JSON** → model parses either format; no behavior change.

## 6. Testing strategy

- **Unit (`tests/`):** `briefing_data.gather_brief_context` returns a bundle
  whose values **equal the corresponding tool-handler outputs** (true by
  construction — call-and-unwrap — but pinned on both a **populated and an
  empty/sparse** seeded DB so the `{"error":...}` branch is covered);
  `render_for_prompt` emits compact JSON and survives non-JSON-native values
  (`default=str`); `_text` emits compact JSON; the `system_prompt()` caching
  guard (no volatile tokens, byte-identical, no bundle substring).
- **Security (`tests/test_security.py`/`test_tools.py`):** unchanged tool
  SQL-safety tests still pass (no SQL moved); chat `model` is whitelisted to
  the three allowed IDs (reject an arbitrary string).
- **Prompt/A/B:** the §4 latency + consistency gates; schema-lock + score on
  both prompt branches.
- **Frontend:** `pnpm tsc --noEmit` + `pnpm build`; 3-way toggle renders with
  Sonnet default; screenshot.
- **Container:** rebuild; generate a brief and confirm it lands (and, per the
  latency gate, faster).

## 7. API Surface

**New — `agent/briefing_data.py`:**
- `gather_brief_context(daily_step_goal: int = 10000, db_path: Path | None = None) -> dict`
  (awaits existing tool handlers; keys = tool names; metric list a frozen const)
- `render_for_prompt(bundle: dict) -> str` (compact JSON)

**Changed:**
- `prompts.briefing_prompt(user_name, daily_step_goal, recent_briefs_summary, prefetched: str = "") -> str`
- `tools._text(payload) -> dict` — compact JSON (drop `indent=2`)
- `ChatRequest.model` default `"claude-sonnet-4-6"`; server whitelists `model` ∈ {haiku-4-5, sonnet-4-6, opus-4-7}
- `ChatPanel` `ModelToggle` → `'haiku' | 'sonnet' | 'opus'`, default `'sonnet'`

**Explicitly NOT changed:** no `queries.py`; the tool handlers' SQL bodies and
frozen-set validation are untouched; `Brief`/`Takeaway` schema + salvage parser;
`allowed_tools`; brief `DEFAULT_MODEL` (Sonnet); all `/api/*` routes;
`RATE_LIMITED_PREFIXES`.

## 8. Invariants

**Checkable by inspection:**
- `_text` emits compact JSON (no `indent=`).
- `system_prompt()` contains no `datetime`/`now(`/`uuid`/`today(`.
- The pre-fetched bundle is injected only in the user turn (`briefing_prompt`),
  never in `system_prompt()`.
- No new query module; the tool handlers' SQL + frozen-set validation are
  unmodified (the bundle calls the handlers, not raw SQL).
- Brief keeps `allowed_tools` = all fitness tools.
- `briefing_data`'s metric list is a frozen module constant (not a parameter).
- `Brief`/`Takeaway` schema and the salvage parser are unchanged.
- Chat `model` is server-side whitelisted to the three allowed IDs.
- No new Claude-cost endpoint; `RATE_LIMITED_PREFIXES` unchanged.
- Brief `DEFAULT_MODEL` stays Sonnet (Haiku brief switch is a gated follow-up).

**Requires tests:**
- `gather_brief_context` values equal the tool-handler outputs on both populated
  and empty/sparse seeded DBs (incl. the `{"error":...}` branch).
- The bundle includes the recovery trends (`body_battery_max`, `avg_stress`).
- Brief generation succeeds with a bundle **and** when prefetch returns `None`.
- `system_prompt()` is byte-identical across two calls with identical notes and
  does not contain the rendered bundle.
- The chat endpoint rejects a non-whitelisted `model`.
- §4 latency gate: post-#1 median `total_ms`/`t_first_card` beats baseline.
- §4 consistency gate: `ab_brief.py --run` (Sonnet) post-#1 stays structurally
  consistent; schema-lock + score pass on both prompt branches.

## 9. Open questions (deferred, non-blocking)

- **Flip brief to Haiku?** Decided by an A/B follow-up, not this design.
- **Markdown bundle render?** Compact JSON v1; revisit only if the model
  re-fetches despite the bundle.
- **Does the SDK actually cache on the OAuth path?** Verify empirically from
  response usage if exposed; doesn't block — the guard protects the input and
  the brief is single-pass.

## 10. Security model

Performance-only; must not regress the 2026-05-04 audit guardrails:
- **No SQL moves.** #1 calls the existing, already-hardened tool handlers and
  unwraps their JSON — the frozen-set column validation and `?`-parameterization
  stay exactly where they are. This deliberately avoids the injection
  contradiction a `queries.py` extraction would create.
- **Injected bundle = same data source as today**, rendered unconditionally
  every brief. Garmin free-text (`activity_name`) could carry prompt-injection
  text, but it's the user's own single-user data, the brief output is
  schema-locked + salvage-parsed, and the system prompt already instructs the
  model to report DB values, not execute them. Net: same source, higher
  frequency, bounded blast radius — **not** "no new surface." `render_for_prompt`
  fences the data block as data.
- **Chat `model` whitelisted** so the toggle can't inject an arbitrary model id.
- Compact JSON and the Haiku tier have no auth/SQL/rate-limit impact.
- No new endpoints, no auth/rate-limit/schema changes.
