# 2026-06-23 — The plan stopped lying about today, and started counting the walk

I asked the coach how my plan was going and two things were wrong. Today's run,
already on my wrist and synced, showed up as "pending." And Saturday, when I
went for a long recovery walk instead of a run, showed up as a missed day. Both
were the grading logic being too literal, and both were quick to find once I
looked.

## Today shouldn't be "pending" when the work is done

The grader held any day at or after the data frontier as `pending`, so it
wouldn't cry "missed" on a day Garmin hadn't reported yet. Reasonable, except
the frontier is today, so today was *always* pending, even with a completed run
sitting right there in the database. The fix flips the logic from date-based to
outcome-based: grade the day first, and only hold `pending` when the verdict is
negative and the window is still open. A done day grades immediately. A rest day
resolves to compliant instead of lingering. And a half-done run still holds
pending rather than prematurely booking half credit and self-healing later, a
gap the review caught that I'd have shipped.

## A recovery walk is recovery

The grader counted running distance only, so a 3.9-mile walk at a 94-average
heart rate, which is exactly what a recovery week asks for, scored as a miss.
Now easy and recovery days count walking too; the quality and long days stay
running-only, because there a walk genuinely isn't the work. Every day also
surfaces what you actually did, so the plan reads "walked 3.9mi" instead of a
blank.

## The bug the review found that the tests couldn't

The backend was clean and unit-tested, but a tightened second-look review caught
that the plan tab colored each row red or green by recomputing a pace miss,
independent of the verdict. A walk counts as done now, but a walking pace is far
slower than the run target, so the tab would have painted that done day red.
Contradiction on the screen the moment it shipped. The frontend now colors from
the verdict itself. I confirmed it with a screenshot: Saturday's walk renders
green at a 17-minute mile, today grades done, adherence reads 100 percent.
