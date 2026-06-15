# 2026-06-15 — Training plans: design → siege → build

Added goal-driven training plans as a new tab. You pick a goal (5K / 10K /
Half / Full / Custom), a race date, and a target time; the agent drafts a
periodized plan from your Garmin history; you riff with it in chat; you commit.
The committed plan is tracked on the `/plan` tab and folded into the daily
brief's workout takeaway.

This one went design-first: a `/design` pass, then a 5-agent **siege +
red-team** adversarial review of the design doc *before* any code, then a
phased TDD build. The adversarial pass paid for itself — it changed the shape
of the feature.

## What the red-team changed (before a line of code)

- **No parallel brief card.** The brief is capped at 5 takeaways with the
  workout + steps cards already required; a separate "training" card would
  collide with the existing "today's workout" mandate and could prescribe
  intervals on a red-recovery day. The plan now rides *inside* the workout
  takeaway, recovery taking precedence over the schedule.
- **Type-aware adherence.** Distance-only grading mis-scores the sessions
  where distance isn't the point. Verdicts are now type-aware: intervals/tempo
  by duration, cross-training by non-running activity, rest always compliant,
  easy-by-feel by presence.
- **Grade off the data frontier, not calendar-today.** Garmin lags 2–7 days, so
  grading against "today" would roast you for runs you did but haven't synced.
  Days at/after `last_known_daily_date()` are `pending`, never `missed`.
- **Draft-only write boundary, enforced in code.** This is the first
  agent→SQLite write path. `status` is never a tool input — `propose` hardcodes
  `'draft'`, `revise` whitelists editable columns and guards the target is a
  draft. Activating/deleting is human-only; there is no tool for it. An injected
  `user_note` therefore can't reach the active plan or the brief.
- **Cut the undefined chart line.** The "target CTL ramp" had no defensible
  data source, so the trajectory chart ships actual CTL + a race-day marker.
  The computable Riegel predicted-finish was promoted into v1 instead.

## What landed

- **Schema** — `training_plans` + `plan_workouts`, additive only, with a partial
  unique index `WHERE status='active'` so a commit race fails loudly.
- **`plans.py`** — pure logic (validation, type-aware adherence, frontier
  grading, Riegel, weekly rollup, plan-quality scorer) + persistence
  (draft/revise/commit/delete) + tab/brief assembly.
- **3 agent tools** + **3 REST endpoints** (`GET /api/plan`, commit, delete with
  404/409 guards). None call Claude, so none are rate-limited; all auto
  auth-gated.
- **Brief** — workout takeaway absorbs the active plan; schema untouched.
- **Frontend** — `/plan` tab: goal header (countdown, target vs projected,
  adherence), schedule with verdicts, planned-vs-actual mileage bars, CTL
  trajectory, empty-state CTA, and the embedded riff chat that re-fetches the
  draft on every turn. All plan strings render as escaped text; a CSP
  (`script-src 'self'`) backs that up.

## Gotcha

The first CSP I shipped (`script-src 'self'`, `style-src 'self'`) would have
**blanked the SPA** — the app loads the Inter font's stylesheet from
`https://rsms.me`, which `style-src 'self'` blocks. Caught it by inspecting the
built `index.html` and screenshotting under the real CSP; fixed by allowing
`https://rsms.me` in `style-src`/`font-src`. The script-src stays locked to
`'self'` (Vite emits no inline scripts).

## Tests

+48 cases across `test_plans`, `test_plans_db`, `test_plan_tools`,
`test_web_plan`, `test_security`, `test_prompts`, `test_db`. Suite 172 passed,
coverage 52%. Frontend: tsc clean, build OK, both tab states screenshotted.

Docs: `docs/plans/2026-06-15-training-plans-{design,contract.yaml,implementation}`.
