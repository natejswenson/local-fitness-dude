"""Training-plan pure logic — no I/O.

Validation, type-aware adherence, data-frontier grading, Riegel projection,
and weekly-mileage rollup. These functions take plain dicts/rows and return
verdicts/numbers so they unit-test cleanly and are reused by the agent tools
(``agent/tools.py``) and the REST endpoints (``web/server.py``). The DB
persistence helpers live below the pure section.
"""
from __future__ import annotations

import math
from datetime import date as _date

# --- constants -------------------------------------------------------------

DONE_FRACTION = 0.80
PARTIAL_FRACTION = 0.40

GOAL_TYPES = frozenset({"5k", "10k", "half", "full", "custom"})
WORKOUT_TYPES = frozenset({"easy", "long", "tempo", "interval", "rest", "race", "cross"})

MAX_WORKOUTS = 200
RIEGEL_EXP = 1.06

#: canonical race distances (metres); 'custom' has no canonical distance
GOAL_DISTANCE_M = {"5k": 5000.0, "10k": 10000.0, "half": 21097.5, "full": 42195.0}

#: substrings that mark an activity_type as a run
_RUNNING_SUBSTRINGS = ("running", "run")

# workout types graded on distance vs. duration
_DISTANCE_TYPES = frozenset({"easy", "long", "race"})
_DURATION_TYPES = frozenset({"interval", "tempo"})

# numeric workout fields that, when present, must be finite and non-negative
_NUMERIC_FIELDS = ("target_distance_m", "target_pace_sec_per_km",
                   "target_duration_sec", "week_index", "seq")


# --- helpers ---------------------------------------------------------------

def _is_running(activity_type: str | None) -> bool:
    at = (activity_type or "").lower()
    return any(s in at for s in _RUNNING_SUBSTRINGS)


def _parse_iso(value: str) -> _date | None:
    try:
        return _date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _running_distance(activities: list[dict]) -> float:
    return sum(
        (a.get("distance_meters") or 0.0)
        for a in activities
        if _is_running(a.get("activity_type"))
    )


def _running_duration(activities: list[dict]) -> float:
    return sum(
        (a.get("duration_seconds") or 0.0)
        for a in activities
        if _is_running(a.get("activity_type"))
    )


# --- Task 1.1: validation --------------------------------------------------

def validate_plan_input(
    goal_type: str,
    race_date: str,
    workouts: list[dict],
    created_date: str,
    goal_distance_m: float | None = None,
    target_time_seconds: int | None = None,
) -> str | None:
    """Return an error string, or ``None`` if the plan input is well-formed."""
    if goal_type not in GOAL_TYPES:
        return f"unknown goal_type '{goal_type}'; expected one of {sorted(GOAL_TYPES)}"

    race = _parse_iso(race_date)
    if race is None:
        return f"race_date '{race_date}' is not an ISO date"
    created = _parse_iso(created_date)
    if created is None:
        return f"created_date '{created_date}' is not an ISO date"

    if not isinstance(workouts, list) or not workouts:
        return "at least one workout is required"
    if len(workouts) > MAX_WORKOUTS:
        return f"too many workouts ({len(workouts)} > {MAX_WORKOUTS})"

    for n in (goal_distance_m, target_time_seconds):
        if n is not None and (not math.isfinite(n) or n < 0):
            return "goal_distance_m and target_time_seconds must be finite and non-negative"

    seen: set[tuple[str, int]] = set()
    for i, w in enumerate(workouts):
        wtype = w.get("type")
        if wtype not in WORKOUT_TYPES:
            return f"workout {i}: unknown type '{wtype}'; expected one of {sorted(WORKOUT_TYPES)}"

        wdate = _parse_iso(w.get("date"))
        if wdate is None:
            return f"workout {i}: date '{w.get('date')}' is not an ISO date"
        if wdate < created or wdate > race:
            return f"workout {i}: date {w.get('date')} outside [created, race_date]"

        for field in _NUMERIC_FIELDS:
            v = w.get(field)
            if v is not None and (not math.isfinite(v) or v < 0):
                return f"workout {i}: {field} must be finite and non-negative"

        if not (w.get("description") or "").strip():
            return f"workout {i}: description is required"

        seq = int(w.get("seq") or 1)
        key = (w["date"], seq)
        if key in seen:
            return f"workout {i}: duplicate (date, seq) {key}"
        seen.add(key)

    return None


# --- Task 1.2: type-aware adherence ---------------------------------------

def classify_workout(workout: dict, day_activities: list[dict]) -> str:
    """Grade one prescribed workout against that day's activities.

    Returns ``done`` | ``partial`` | ``missed`` | ``compliant`` (rest days).
    Distance is used only for the types where distance is the target; quality
    sessions grade on duration, cross-training on any non-running activity.
    """
    wtype = workout.get("type")

    if wtype == "rest":
        return "compliant"

    if wtype in _DISTANCE_TYPES:
        target = workout.get("target_distance_m")
        actual = _running_distance(day_activities)
        if not target:  # null/0 target → "by feel": any run counts
            return "done" if actual > 0 else "missed"
        frac = actual / target
        if frac >= DONE_FRACTION:
            return "done"
        if frac >= PARTIAL_FRACTION:
            return "partial"
        return "missed"

    if wtype in _DURATION_TYPES:
        actual = _running_duration(day_activities)
        if actual <= 0:
            return "missed"
        target = workout.get("target_duration_sec")
        if target and actual < PARTIAL_FRACTION * target:
            return "partial"
        return "done"

    if wtype == "cross":
        has_cross = any(
            not _is_running(a.get("activity_type")) for a in day_activities
        )
        return "done" if has_cross else "missed"

    # unknown type: treat as missed unless something happened
    return "done" if day_activities else "missed"


# --- Task 1.3: data-frontier grading --------------------------------------

def grade_workout(workout: dict, day_activities: list[dict], frontier: str | None) -> str:
    """Grade only days strictly before the data frontier; otherwise ``pending``.

    ``frontier`` is ``db.last_known_daily_date()`` (the most recent day Garmin
    data has arrived for). Days at or after it are ``pending`` — we have no data
    yet, so we never report ``missed``. ISO ``YYYY-MM-DD`` strings compare
    lexicographically in date order, so plain string comparison is safe.
    """
    if frontier is None or workout.get("date", "") >= frontier:
        return "pending"
    return classify_workout(workout, day_activities)


# --- Task 1.4: Riegel projection + weekly mileage -------------------------

def riegel_predict(
    best_distance_m: float | None,
    best_time_s: float | None,
    target_distance_m: float | None,
) -> float | None:
    """Riegel endurance projection: t2 = t1 * (d2/d1)^1.06. ``None`` if unknown."""
    if not best_distance_m or not best_time_s or not target_distance_m:
        return None
    return best_time_s * (target_distance_m / best_distance_m) ** RIEGEL_EXP


def weekly_mileage(workouts: list[dict], activities_by_date: dict[str, list[dict]]) -> list[dict]:
    """Planned vs. actual km per ``week_index`` (actual counts each date once)."""
    planned: dict[int, float] = {}
    week_dates: dict[int, set[str]] = {}
    for w in workouts:
        wk = int(w.get("week_index") or 0)
        planned[wk] = planned.get(wk, 0.0) + (w.get("target_distance_m") or 0.0)
        week_dates.setdefault(wk, set()).add(w.get("date"))

    rows = []
    for wk in sorted(planned):
        actual_m = sum(
            _running_distance(activities_by_date.get(d, []))
            for d in week_dates.get(wk, set())
        )
        rows.append({
            "week": wk,
            "planned_km": round(planned[wk] / 1000.0, 1),
            "actual_km": round(actual_m / 1000.0, 1),
        })
    return rows
