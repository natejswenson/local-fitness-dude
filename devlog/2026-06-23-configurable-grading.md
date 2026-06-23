# 2026-06-23 — The grading rules stopped being mine and started being yours

This app is public, but a handful of coaching decisions were baked into the code
as my preferences. Whether a recovery walk counts toward an easy day. How close
to the target distance counts as done versus partial. How far back to look for a
best effort when projecting a race finish. Reasonable defaults, but they were
mine, and anyone else cloning the repo was stuck with them.

So I pulled five of those choices out of the code and made them settings, each
defaulting to exactly what was hardcoded before, so a fresh clone behaves the
same and nobody has to configure anything to start.

## Where the settings live

The app already had three places config could go: environment variables for
deployment and secrets, a small key-value settings table for per-user values
like the step goal, and a notes file for the coach's conversational memory. I
did not want a fourth. So these knobs resolve in a clear order: a value in the
settings table wins, then an environment variable, then the built-in default.
That means you can set one live with a CLI command and it takes effect
immediately, or write it once in your env file, or do nothing and get the
sensible default.

## The review earned its keep again

The grading functions are pure, with no database access, which is what keeps
them easy to test. The constraint was getting user settings into them without
breaking that purity, so the callers resolve the config once and pass it in. The
adversarial review caught the parts I would have shipped wrong: an empty setting
value silently flipping a true/false knob to false instead of the default, no
guard against a fraction pair that inverts the grade bands, and a negative
lookback window that quietly erases the projected finish. Each of those is now
validated, with anything invalid falling back to the default rather than
producing a confusing result.

The defaults reproduce the old behavior exactly, which is the one property worth
pinning with a test: change a default by accident and the suite fails.
