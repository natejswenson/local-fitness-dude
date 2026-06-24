---
ticket: "N/A (interactive design)"
title: "Coach tone profiles — Supportive / Neutral / Hardass (+ Adaptive default)"
date: "2026-06-23"
source: "design"
---

# Coach tone profiles

The daily brief's coaching voice is hardcoded to one runner's preference (a
"supportive when trending well, roast when slipping" blend). This makes the
voice a **selectable profile** with tunable numeric characteristics and a
fully-fleshed `.md` per profile, so a user can pick how their coach talks —
without changing the default for a fresh clone.

Builds on the 0.9.0 config system (settings DB > env var > default).

## Profiles and their numeric characteristics

Four profiles. Each is a `src/local_fitness/agent/coach_profiles/<name>.md` file
with YAML frontmatter (the dials) and a fleshed prose body (the voice).

| Profile | harshness | warmth | push | roast_threshold | praise_threshold |
|---|---|---|---|---|---|
| `adaptive` (default) | 6 | 6 | 7 | 0.85 | 0.95 |
| `supportive` | 1 | 9 | 3 | 0.00 | 0.60 |
| `neutral` | 5 | 5 | 5 | 0.85 | 0.95 |
| `hardass` | 9 | 1 | 10 | 1.00 | 1.05 |

**Dial semantics.** Two tiers, deliberately separated by how falsifiable they
are — this is the honest core of the design (SIG-2):

- **`harshness` / `warmth` / `push` (0–10) — PROSE CALIBRATION, not falsifiable.**
  These are interpolated into the profile block as directional, LLM-judged
  calibration hints for the prose ("Coaching dials: harshness 9/10 …"). They are
  *not* finely controllable: harshness 7 vs 9 is a nudge the model interprets,
  not a precisely measurable behavior. We keep them because the user asked for
  numeric characteristics, but we frame them honestly as calibration. The
  deterministic, testable behavior lives in the thresholds below — not here.
- **`roast_threshold` — DETERMINISTIC gate (goal-based mandates only).** Fraction
  of goal. For mandates where a concrete number exists — the **steps** mandate
  (`briefing.py:151` reads a real `daily_step_goal`) and the **plan-adherence**
  mandate (an `adherence_pct` exists) — this threshold *deterministically gates
  which harsh-tone imperative blocks are assembled into the `briefing_prompt`
  string* (see "Threading"). When `roast_threshold <= 0.0` (e.g. `supportive`),
  the "Be sharp. Be harsh. Override the usual voice" imperative blocks are
  **omitted from the prompt entirely** — not "hoped suppressed by the LLM". When
  high (`hardass` 1.00), they're included and amplified. `supportive` 0.00 = never
  roasts; `hardass` 1.00 = anything short of 100% gets the harsh block.
- **`praise_threshold` — celebration gate (goal-based mandates only).** Fraction
  of goal above which the brief celebrates. `hardass` 1.05 = only praises
  overachievement; `supportive` 0.60 = praises effort readily. `praise_threshold
  > 1.0` (hardass 1.05) is only meaningful for **goal-based** domains (steps,
  plan adherence) where >100% attainment is a real thing — it does **NOT** apply
  to RHR or sleep, which have no notion of "overachievement". Threshold semantics
  are scoped to goal-based mandates only.

**`adaptive`** reproduces today's behavior; its dials describe the existing
blend, and its `.md` persona **body** is the current persona prose verbatim
(lines `42-73`). Note the overall rendered `system_prompt(ADAPTIVE)` legitimately
*gains* the new "Coaching dials" line (uniform across all profiles), so it is
**SCORER-EQUIVALENT, not byte-identical** to today — see "The load-bearing
constraint (A/B gate)".

## The `.md` profile structure (fully fleshed)

Each profile file mirrors the ghostwriter `voice-profile.md` skeleton, adapted
for a fitness coach:

```markdown
---
name: hardass
harshness: 9
warmth: 1
push: 10
roast_threshold: 1.00
praise_threshold: 1.05
---
# Hardass coach profile

## Voice & tone
<adjective cluster + 2-3 exemplar coach lines in this voice>

## When you're crushing it
<how this profile praises — gated by praise_threshold>

## When you're slipping
<how it pushes/criticizes — gated by roast_threshold; the harshest profiles
 "rip you apart", the supportive one reframes positively>

## Vocabulary & phrasing
<diction, signature constructions, what to say / avoid>

## Tone-enum bias
<which of positive|caution|critical|neutral this profile leans toward; e.g.
 supportive avoids critical, hardass leans into it — guidance, not a schema change>

## Never do
<hard prohibitions specific to this profile>
```

Bodies are prose/bullets with verbatim example lines, like the voice profile.

## Components

- **`src/local_fitness/agent/coach.py`** (new):
  - `@dataclass(frozen=True) class CoachProfile`: `name`, `harshness`, `warmth`,
    `push` (int), `roast_threshold`, `praise_threshold` (float), `persona` (str,
    the `.md` body).
  - `load_profile(name) -> CoachProfile` — reads
    `coach_profiles/<name>.md` (resolved `Path(__file__).resolve().parent /
    "coach_profiles"`), parses YAML frontmatter (dials) + body (persona). Unknown
    name → load `adaptive`. **Import-time-safe fallbacks (required):**
    - Missing file, OR unparseable/empty frontmatter, OR empty body → return an
      **in-code hardcoded `CoachProfile` constant** (`_FALLBACK_ADAPTIVE`, the
      adaptive dials + persona baked into `coach.py`). Never raise.
    - A single missing dial in otherwise-valid frontmatter → that dial's
      hardcoded default (the adaptive value), other dials honored.
    This matters because `prompts.py:554-555` builds `SYSTEM_PROMPT` /
    `BRIEFING_PROMPT` at **module import** with `profile=ADAPTIVE`, which loads
    `adaptive.md` from disk at import time. A broken/missing `adaptive.md` would
    otherwise brick every import of `prompts` (and `score_prompt.py`, and the web
    server). The in-code fallback guarantees import always succeeds.
  - `PROFILE_NAMES` frozenset = the whitelist (`adaptive`, `supportive`,
    `neutral`, `hardass`) — derived from the shipped files.
  - `resolve_coach_profile(db_path=None) -> CoachProfile` — pick the profile name
    from `config.coach_profile()`; load it; apply per-dial config overrides
    (default = the profile's own frontmatter value); validate/clamp; return.
- **`src/local_fitness/config.py`**:
  - `coach_profile(db_path=None) -> str` — new string accessor with a
    whitelist cast (`_as_coach_profile`: lowercase, must be in `PROFILE_NAMES`,
    else raise → falls back to default `"adaptive"`).
  - The per-dial overrides are resolved inside `resolve_coach_profile` (batched,
    like `resolve_grading_config`), each defaulting to the loaded profile's
    frontmatter value: `coach_harshness`, `coach_warmth`, `coach_push` (int,
    clamp 0–10), `coach_roast_threshold`, `coach_praise_threshold` (float, clamp
    0.0–1.20).
  - **Per-dial overrides are GLOBAL, not per-profile (documented footgun).** They
    are flat settings key/value pairs, so `coach_harshness=7` overrides the
    harshness of **whichever** profile is currently selected — it is not scoped to
    one profile. Switching `coach_profile` does *not* clear a previously-set dial
    override. Documented behavior: "`coach_harshness=7` overrides every profile's
    native harshness; unset it (`fitness config unset coach_harshness`) when
    switching profiles if you want the new profile's native value." We do **not**
    add per-profile override scoping (YAGNI) — just document the global semantics.
- **`src/local_fitness/agent/prompts.py`**:
  - `system_prompt(user_name, profile: CoachProfile = ADAPTIVE)` — only the
    **tone/voice** bullets of the persona block become `{profile.persona}`: the
    "Frame depends on what the data shows" / roast-when-slipping / "keep the edge"
    / "never paper a bad day" rules. The **universal grounding bullets stay FIXED
    across all profiles, outside `{profile.persona}`** — specifically the CTL/ATL/
    TSB → fitness/fatigue/freshness jargon translation (`prompts.py:50-53`) and
    "pair every number with its meaning". This is load-bearing: the jargon
    translation is what `score_prompt.py:86-89` checks, and a non-adaptive profile
    must NOT be able to drop it (the scorer only renders adaptive, so an omission
    in a supportive `.md` would silently strip the grounding contract from
    supportive briefs). Then a one-line "Coaching dials" interpolation
    (`harshness {h}/10 · warmth {w}/10 · push {p}/10 · harden below
    {roast_threshold:.2f} of goal · celebrate above {praise_threshold:.2f}`, fixed
    2-decimal float format for stable rendering) is appended for all profiles.
  - `briefing_prompt(..., profile: CoachProfile = ADAPTIVE)` — the per-mandate
    **tone→enum mapping stays factual** (which of positive|caution|critical|
    neutral by data state — needed for the schema + card color). The scattered
    prose **harshness imperatives** consolidate into the injected profile block.
    But the load-bearing change is **deterministic prompt assembly** for the
    goal-based mandates: the harsh-tone imperative blocks in the **steps mandate**
    (`prompts.py:351-373` — "Yesterday MISSED goal → tone: critical. Be sharp. Be
    harsh. Override the usual …") and the **plan-adherence mandate**
    (`prompts.py:315-318` — the "roast when slipping" adherence open) are
    *conditionally included in the returned string* based on
    `profile.roast_threshold`. When `roast_threshold <= 0.0`, those blocks are
    **not concatenated into `briefing_prompt`'s return value at all**; when high,
    they're included (and the dial line amplifies them). This is plain string
    assembly — falsifiable by a unit test (see "Requires tests"), not LLM hope.
  - `ADAPTIVE` is a module-level `CoachProfile` loaded from `adaptive.md`, used as
    the default arg so back-compat callers (tests, the `BRIEFING_PROMPT` const)
    get today's behavior.
- **`src/local_fitness/agent/briefing.py`** + **`web/mcp_server.py`**: resolve
  the profile via **`coach.resolve_coach_profile()`** (which uses
  `config.coach_profile()`'s DB > env > default resolver **plus** the per-dial
  overrides) and pass the resulting `CoachProfile` into both `system_prompt` and
  `briefing_prompt`, alongside the existing `user_name` / `daily_step_goal` reads
  at `briefing.py:149-153`. Do NOT copy the raw `db.get_setting` + inline `int()`
  pattern those lines use for `daily_step_goal` — that path has no env layer; the
  profile must go through the config resolver so `LOCAL_FITNESS_COACH_PROFILE`
  works.

## The load-bearing constraint (A/B gate)

The adaptive default must keep today's brief behavior. The gate is
**SCORER-EQUIVALENT + A/B-CONSISTENT**, *not* byte-equality — the actual
`score_prompt.py` gate is whitespace-insensitive substring/membership checks, so
byte-identity was never required (and isn't achievable anyway, since every
profile — adaptive included — gains the uniform "Coaching dials" line).

Concretely, the adaptive (default) rendering must satisfy:

- **`score_prompt.py` passes unchanged.** It scores only the *default* rendering
  (`system_prompt("TestRunner")` and `briefing_prompt()` with default args).
  Adaptive's persona body is today's prose verbatim, so:
  - check at `score_prompt.py:90-92` — `"roast" in sys_low` — stays green: the
    literal `"roast"` substring is present in `system_prompt(ADAPTIVE)`.
  - checks at `score_prompt.py:72-74` — all four `Tone` words
    (`positive|caution|critical|neutral`) appear in `briefing_prompt` — stay green:
    the refactor keeps all four tone words and the schema-FIXED / one-key language
    intact.
- **A/B-consistent.** The adaptive brief is validated equivalent to today's by the
  cross-model A/B reporting `consistent: true` (structure preserved) — *not* by
  byte-equality.

Resolving the dials-line contradiction explicitly: the "Coaching dials" line is
part of the injected profile block for **ALL** profiles **including adaptive**
(uniform). Adaptive's *persona body* is the current persona prose verbatim, but
the *overall* prompt legitimately gains the dials line — that's fine, because the
scorer is substring/membership-based, not byte-based. Adaptive is validated
scorer-equivalent, not byte-equal.

## Profile vs. user-notes precedence

Today a saved note ("be nicer") competes with the baked-in roast rules with no
coded arbitration. The injected profile block declares the precedence
explicitly: **the profile sets the base tone; a saved note refines or overrides
a specific point.** So `hardass` + a "go easy on sleep this week" note yields a
hardass brief that is soft on sleep. (This is LLM-applied, but the precedence is
now stated rather than left to chance.)

## API surface

- `coach.CoachProfile(name, harshness, warmth, push, roast_threshold, praise_threshold, persona)` — frozen dataclass.
- `coach.load_profile(name: str) -> CoachProfile` — unknown name → `adaptive`.
- `coach.resolve_coach_profile(db_path=None) -> CoachProfile` — config-selected + overridden + validated.
- `coach.PROFILE_NAMES: frozenset[str]` — `{adaptive, supportive, neutral, hardass}`.
- `config.coach_profile(db_path=None) -> str` — whitelist string accessor, default `"adaptive"`.
- `prompts.system_prompt(user_name=DEFAULT_USER_NAME, profile=ADAPTIVE) -> str`.
- `prompts.briefing_prompt(user_name=DEFAULT_USER_NAME, daily_step_goal=10000, recent_briefs_summary="", profile=ADAPTIVE) -> str`.
- `fitness config set coach_profile hardass` / `coach_harshness 7` (no CLI change — generic key/value).
- Env mirrors: `LOCAL_FITNESS_COACH_PROFILE`, `LOCAL_FITNESS_COACH_HARSHNESS`, etc.

## Invariants

Checkable by inspection:
- All four `coach_profiles/*.md` exist and parse (frontmatter dials + body).
- **A/B-gate invariant (replaces the old golden byte-test):**
  (a) `score_prompt.py` passes on the adaptive (default) rendering **unchanged**;
  (b) the `"roast"` substring is present in `system_prompt(ADAPTIVE)`;
  (c) all four `Tone` words are present in `briefing_prompt(profile)` for **every**
      profile;
  (d) the cross-model A/B reports `consistent: true` for adaptive.
  (Adaptive is validated **scorer-equivalent**, not byte-equal.)
- **Import never bricks:** `import local_fitness.agent.prompts` succeeds even if
  `adaptive.md` is missing or malformed — `coach.load_profile` falls back to the
  in-code `CoachProfile` constant. (A missing/unparseable `adaptive.md` degrades
  gracefully; it never raises at import.)
- Unknown `coach_profile` resolves to `adaptive` (fail-safe); the prompts never
  receive an unloadable profile.
- Dial overrides clamp to range (0–10 ints; 0.0–1.20 floats); out-of-range or
  unparseable → the profile's frontmatter value. A single missing dial in
  frontmatter → that dial's hardcoded default.
- Profiles are tracked code (under `agent/coach_profiles/`), not in the
  gitignored `data/` — they ship with the package.

Requires tests:
- Every shipped profile loads with dials in range and a non-empty persona.
- `resolve_coach_profile` returns the right profile per `coach_profile` setting;
  a per-dial override changes only that dial; bad override clamps/falls back.
- **Deterministic threshold gating (addresses the unfalsifiability — SIG-2):**
  the `supportive`-rendered `briefing_prompt` does **NOT** contain the harsh steps
  imperative ("Be sharp. Be harsh. Override the usual …") nor the harsh
  plan-adherence open; the `hardass`-rendered `briefing_prompt` **DOES** contain
  them. Pure string assertions on the returned prompt — no LLM call.
- Import-safety: with `adaptive.md` temporarily removed/corrupted, `import
  local_fitness.agent.prompts` still succeeds (in-code fallback) and `"roast"` is
  still present in `system_prompt(ADAPTIVE)`.
- `system_prompt(hardass)` carries accountability language; `system_prompt(supportive)`
  does NOT roast (no harshness imperatives).
- `briefing_prompt` keeps the four tone words under each profile.
- `score_prompt.py`: the default (adaptive) rendering passes all checks
  **unchanged** (no scorer edits required to ship).

## Testing strategy — every profile A/B'd + quality-tested vs. expected outcomes

This feature ships **opinionated tonal behavior**, so per the user's standard
("build an automated scorer; don't eyeball") **every profile is validated against
expected outcomes at two layers** — a deterministic prompt-level scorer (CI-gating)
and a generative output-level A/B (on-demand, cost-capped). Neither is eyeballed.

### Layer 1 — per-profile quality scorer (deterministic, CI-gating) — `scripts/score_profiles.py` (new)

Renders `system_prompt(p)` + `briefing_prompt(p)` for **all four profiles** and
asserts the **expected per-profile outcomes** as pure string/structural checks
(no LLM). All-or-nothing, exit non-zero on any miss — wired into pytest and CI:

| Check (every profile) | Expectation |
|---|---|
| four `Tone` words present | schema validity holds for every profile |
| CTL/ATL/TSB → fitness/fatigue/freshness | grounding contract retained (the fixed block) |
| schema-FIXED / "exactly one key" / `takeaways` | output schema intact |

| Profile | Expected outcome (lexical/structural) |
|---|---|
| `adaptive` | contains `"roast"`; harsh steps + plan blocks PRESENT (== today) |
| `supportive` | NO harsh imperatives (`rip`, `no excuse`, `stop coasting`, `slacking`, `this is on you`); harsh steps + plan blocks OMITTED; encouraging markers present |
| `neutral` | NO harsh imperatives AND no effusive-praise markers; factual framing |
| `hardass` | accountability/harsh language present; harsh steps + plan blocks INCLUDED |

This is the backbone "quality test all profiles vs expected outcomes" — fast,
deterministic, falsifiable (it fails if a profile's prose drifts from its intent
or a deterministic gate breaks).

### Layer 2 — per-profile generative A/B (output vs. expected tone) — `scripts/ab_brief.py --profile`

Extend `ab_brief.py` with a `--profile <name>` flag (default `adaptive`) that
generates the brief under that profile, plus a per-profile **expected-tone**
assertion over the **structured output** (not eyeballed):

- **Deterministic signal (cheap, on the JSON):** the `tone` enum distribution per
  profile on a representative slipping-day fixture — `supportive` emits **0
  `critical`** takeaways; `hardass` emits **≥1 `critical`/`caution`**; `neutral`
  in between. Structure invariants (3–5 takeaways, steps takeaway, plan-fold) must
  hold for **every** profile — so no profile produces a malformed brief.
- **Robust signal (LLM-judge):** a small judge rates each generated brief on a
  supportive↔hardass axis and asserts the ranking is **monotonic**
  (`supportive < neutral < adaptive ≤ hardass`). This is the real "expected
  outcome" validation, automated via a judge rather than human reading.

Generative runs cost subscription tokens and the `_generate` harness is flaky
(memory: feedback-ab-brief-harness-flaky), so Layer 2 is **on-demand + cost-capped**
(dry-run estimate first, hard `MAX_GENERATIONS` cap), not CI-gating. The adaptive
A/B additionally uses **differential testing** (stash the change; confirm the
baseline behaves identically) per the flaky-harness workaround.

### Other

- `uv run pytest -x` — new `test_coach.py` (load/resolve/override/clamp, import
  fallback) + the Layer-1 per-profile assertions in `test_prompts.py` /
  `test_score_profiles.py`; existing prompt tests stay green. (No golden byte-test
  — the gate is scorer-equivalence + A/B-consistency, not byte-equality.)
- `scripts/score_prompt.py` stays GREEN on the default (adaptive) rendering with
  **zero edits** (it scores only the default args; adaptive renders today's text
  plus the harmless dials line). The new `score_profiles.py` is the per-profile
  layer that score_prompt.py does not cover.
- Rebuild the container so the deployed brief honors the selected profile.

## Obligations (repo rules)

- Version bump in `pyproject.toml` + CHANGELOG entry (functionality + prompt
  change).
- `devlog/` entry.
- `.env.example` documents `LOCAL_FITNESS_COACH_PROFILE` + the `COACH_*` dials.
- No new endpoint / no auth surface change → `test_security.py` untouched.

## Quality-gate provenance

Reviewed via `/quality-gate` (artifact type: design) on `general-purpose` agents
(the `crucible-*` agent types / receipt-cairn infra are not installed here, so the
Opus recall guarantee was not enforced; findings were still code-grounded). Two
red-team rounds + a tightened look-harder pass. Terminal verdict **PASS
(clean-pass)**: 0 Fatal / 0 Significant on a fresh round, confirmed by look-harder
(which also verified consumer-completeness — the profile is threaded into both
`briefing.py` and `mcp_server.py`, the only two callers). Score trajectory 4 → 0.

Round 1 materially reshaped the design. It caught that the **"byte-identical
adaptive" claim was self-contradictory** (the appended dials line means it can't
be byte-equal) and fragile — reframed to **scorer-equivalent + A/B-consistent**
(the scorer only needs `"roast"` + the four tone words, both whitespace-
insensitive). More importantly it caught that the **numeric dials were
unfalsifiable** as pure LLM-calibration — fixed by giving the `roast`/`praise`
thresholds **deterministic teeth** (they conditionally include/omit the harsh
imperative blocks in the assembled `briefing_prompt` for goal-based mandates,
which is unit-testable) while framing the 0–10 dials honestly as prose
calibration. It also fixed the "mirror `daily_step_goal`" instruction (that path
bypasses the config resolver), the over-claimed scorer extension (optional, not
gate-required), and the import-time disk-read fragility (in-code fallback so a
missing `adaptive.md` never bricks import). The look-harder pass added the
universal-grounding-stays-fixed refinement (the jargon-translation block must not
be omittable per-profile).
