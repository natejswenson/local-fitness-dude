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

**Dial semantics** (injected into the brief prompt; the LLM calibrates against
them — it sees the day's data via its tools):
- `harshness` / `warmth` / `push` — 0–10 calibration dials for the prose.
- `roast_threshold` — fraction of goal; when the day's attainment is **below**
  this, the tone hardens. `supportive` 0.00 = never roasts; `hardass` 1.00 =
  anything short of 100% gets pushed.
- `praise_threshold` — fraction of goal above which the brief celebrates.
  `hardass` 1.05 = only praises overachievement; `supportive` 0.60 = praises
  effort readily.

**`adaptive`** reproduces today's behavior; its dials describe the existing
blend, and its `.md` body is the **verbatim** current persona text (see "The
load-bearing constraint").

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
    name → load `adaptive`.
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
- **`src/local_fitness/agent/prompts.py`**:
  - `system_prompt(user_name, profile: CoachProfile = ADAPTIVE)` — the persona
    block (`prompts.py:42-73`) becomes `{profile.persona}`, and a one-line
    "Coaching dials" interpolation (`harshness N/10 · warmth N/10 · push N/10 ·
    harden below {roast_threshold} of goal · celebrate above {praise_threshold}`)
    is appended.
  - `briefing_prompt(..., profile: CoachProfile = ADAPTIVE)` — the per-mandate
    **tone→enum mapping stays factual** (which of positive|caution|critical|
    neutral by data state — needed for the schema + card color), but the
    scattered **harshness imperatives** ("Be harsh", "Override the soft voice",
    "roast") consolidate into a single injected profile-calibration block so they
    are governed by the selected profile, not hardcoded.
  - `ADAPTIVE` is a module-level `CoachProfile` loaded from `adaptive.md`, used as
    the default arg so back-compat callers (tests, the `BRIEFING_PROMPT` const)
    get today's behavior.
- **`src/local_fitness/agent/briefing.py`** + **`web/mcp_server.py`**: resolve
  the profile once (`coach.resolve_coach_profile()`) and pass it into both
  `system_prompt` and `briefing_prompt` (mirrors the existing `daily_step_goal`
  read at `briefing.py:149-153`).

## The load-bearing constraint (A/B gate)

`adaptive.md`'s body is the **verbatim** current persona text (lines `42-73`),
so **`system_prompt(ADAPTIVE)` renders byte-for-byte identical to today**. This
keeps `score_prompt.py` check #4 (`"roast"` present in the system prompt) green
without change, and a fresh clone / unset config gets exactly today's brief.

The `briefing_prompt` refactor moves harshness imperatives into the profile
block but **keeps all four `Tone` words** (`positive|caution|critical|neutral`)
and the schema-FIXED / one-key language intact, so `score_prompt.py` checks
#7–#10 still pass. The refactor is semantically equivalent for the adaptive
default — confirmed by the cross-model A/B (below), not assumed.

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
- `system_prompt(ADAPTIVE)` is byte-identical to the pre-change system prompt
  (golden test pins it — protects the A/B gate).
- `briefing_prompt(profile)` contains all four `Tone` words for **every** profile
  (so the schema/scorer hold regardless of profile).
- Unknown `coach_profile` resolves to `adaptive` (fail-safe); the prompts never
  receive an unloadable profile.
- Dial overrides clamp to range (0–10 ints; 0.0–1.20 floats); out-of-range or
  unparseable → the profile's frontmatter value.
- Profiles are tracked code (under `agent/coach_profiles/`), not in the
  gitignored `data/` — they ship with the package.

Requires tests:
- Every shipped profile loads with dials in range and a non-empty persona.
- `resolve_coach_profile` returns the right profile per `coach_profile` setting;
  a per-dial override changes only that dial; bad override clamps/falls back.
- `system_prompt(ADAPTIVE)` == captured legacy string (golden).
- `system_prompt(hardass)` carries accountability language; `system_prompt(supportive)`
  does NOT roast (no harshness imperatives).
- `briefing_prompt` keeps the four tone words under each profile.
- `score_prompt.py`: default rendering passes all checks (unchanged); the
  extended per-profile checks pass.

## Testing strategy

- `uv run pytest -x` — new `test_coach.py` (load/resolve/override/clamp), a
  golden test pinning `system_prompt(ADAPTIVE)`, and profile-rendering assertions
  in `test_prompts.py`; existing prompt tests stay green.
- **Prompt A/B gate (mandatory — this is an agent-prompt change).**
  1. `scripts/score_prompt.py` must stay GREEN. Extend it to also score each
     non-default profile's internal consistency (hardass has accountability
     language; every profile keeps the four tone words). The default (adaptive)
     rendering passes unchanged.
  2. `scripts/ab_brief.py --run` for the **adaptive** profile must report
     `consistent: true` (structure: 3–5 takeaways, steps takeaway, plan-fold).
     The `ab_brief._generate` harness is flaky (memory:
     feedback-ab-brief-harness-flaky); verify by **differential testing** — stash
     the change, confirm the baseline fails/passes identically — rather than
     trusting a single green run.
- Rebuild the container so the deployed brief honors the selected profile.

## Obligations (repo rules)

- Version bump in `pyproject.toml` + CHANGELOG entry (functionality + prompt
  change).
- `devlog/` entry.
- `.env.example` documents `LOCAL_FITNESS_COACH_PROFILE` + the `COACH_*` dials.
- No new endpoint / no auth surface change → `test_security.py` untouched.

## Quality-gate provenance

(Filled in after the `/quality-gate` pass.)
