"""Tests for agent/tools.py — the MCP tool handlers that query the DB.

The handlers are async and return ``{"content": [{"type": "text", "text": ...}]}``.
We call them directly against a seeded tmp DB (no SDK runtime, no network).
"""
from __future__ import annotations

import asyncio
import json
from datetime import date, timedelta

import pytest

from local_fitness import db
from local_fitness.agent import tools


def call(tool, args):
    """Run a tool handler and return its decoded JSON payload."""
    result = asyncio.run(tool.handler(args))
    text = result["content"][0]["text"]
    try:
        return json.loads(text), result.get("is_error", False)
    except json.JSONDecodeError:
        return text, result.get("is_error", False)


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    p = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", p)
    monkeypatch.setenv("LOCAL_FITNESS_NOTES_PATH", str(tmp_path / "user_notes.md"))
    db.init_schema(p)
    today = date.today()
    with db.connect(p) as conn:
        for i in range(40):
            d = (today - timedelta(days=i)).isoformat()
            conn.execute(
                "INSERT INTO daily_metrics (date, rhr, sleep_seconds, sleep_score, "
                "avg_stress, body_battery_min, body_battery_max, steps, "
                "intensity_minutes_moderate, intensity_minutes_vigorous) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (d, 50 + (i % 4), 27000 + i * 10, 80, 30, 20, 90, 9000, 20, 5),
            )
            conn.execute(
                "INSERT INTO baselines (date, rhr_60day_mean, rhr_60day_sd, "
                "body_battery_max_60day_mean, ctl, atl, tsb) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (d, 52.0, 2.0, 88.0, 40.0, 45.0, -5.0),
            )
        # Activities incl. one fully-detailed workout.
        conn.execute(
            "INSERT INTO activities (activity_id, date, start_time, activity_type, "
            "activity_name, duration_seconds, distance_meters, avg_hr, max_hr, "
            "training_load, aerobic_te) VALUES "
            "(1, ?, ?, 'running', 'Morning Run', 3600, 10000, 150, 170, 80.0, 3.5)",
            (today.isoformat(), today.isoformat() + "T07:00:00"),
        )
        conn.execute(
            "INSERT INTO activity_hr_zones (activity_id, zone, seconds_in_zone) VALUES (1, 2, 1800)"
        )
        conn.execute(
            "INSERT INTO activity_splits (activity_id, split_index, distance_meters, "
            "duration_seconds, avg_hr) VALUES (1, 0, 1000, 360, 148)"
        )
    return p


def test_get_today_status(seeded):
    payload, err = call(tools.get_today_status, {})
    assert not err
    assert payload["recent_days"]
    assert payload["current_baseline"]["ctl"] == 40.0


def test_get_metric_valid(seeded):
    payload, err = call(tools.get_metric, {"metric": "rhr", "days": 14})
    assert not err
    assert all("value" in row for row in payload)


def test_get_metric_unknown(seeded):
    payload, err = call(tools.get_metric, {"metric": "bogus", "days": 14})
    assert err
    assert "unknown metric" in payload["error"]


def test_get_metric_trend(seeded):
    payload, err = call(tools.get_metric_trend, {"metric": "rhr", "days": 14})
    assert not err
    assert payload["n_samples"] > 0
    assert "current_vs_baseline_sd" in payload  # rhr is baseline-tracked


def test_get_metric_trend_unknown(seeded):
    _payload, err = call(tools.get_metric_trend, {"metric": "nope", "days": 14})
    assert err


def test_get_metric_trend_no_data(seeded):
    _payload, err = call(tools.get_metric_trend, {"metric": "vo2_max", "days": 14})
    assert err  # vo2_max never seeded → no rows in window


def test_query_workouts_filters(seeded):
    payload, err = call(
        tools.query_workouts,
        {"activity_type": "run", "days": 30, "min_distance_km": 5, "min_duration_min": 10, "limit": 10},
    )
    assert not err
    assert len(payload) == 1
    assert payload[0]["activity_id"] == 1


def test_query_workouts_no_filters(seeded):
    payload, err = call(tools.query_workouts, {})
    assert not err
    assert len(payload) >= 1


def test_get_workout_detail_found(seeded):
    payload, err = call(tools.get_workout_detail, {"activity_id": 1})
    assert not err
    assert payload["activity"]["activity_name"] == "Morning Run"
    assert "raw_json" not in payload["activity"]
    assert payload["hr_zones"] and payload["splits"]


def test_get_workout_detail_missing(seeded):
    _payload, err = call(tools.get_workout_detail, {"activity_id": 999})
    assert err


def test_compare_periods_daily(seeded):
    today = date.today()
    a0 = (today - timedelta(days=10)).isoformat()
    a1 = today.isoformat()
    b0 = (today - timedelta(days=30)).isoformat()
    b1 = (today - timedelta(days=20)).isoformat()
    payload, err = call(
        tools.compare_periods,
        {"metric": "rhr", "period_a_start": a0, "period_a_end": a1,
         "period_b_start": b0, "period_b_end": b1},
    )
    assert not err
    assert payload["period_a"]["n"] > 0
    assert payload["delta_mean_a_minus_b"] is not None


def test_compare_periods_training_load(seeded):
    today = date.today()
    payload, err = call(
        tools.compare_periods,
        {"metric": "training_load",
         "period_a_start": (today - timedelta(days=5)).isoformat(),
         "period_a_end": today.isoformat(),
         "period_b_start": (today - timedelta(days=40)).isoformat(),
         "period_b_end": (today - timedelta(days=35)).isoformat()},
    )
    assert not err
    assert payload["period_a"]["n"] >= 1
    assert payload["period_b"]["n"] == 0  # no activities that far back


def test_compare_periods_unknown(seeded):
    _payload, err = call(
        tools.compare_periods,
        {"metric": "xyz", "period_a_start": "2026-01-01", "period_a_end": "2026-01-02",
         "period_b_start": "2026-01-03", "period_b_end": "2026-01-04"},
    )
    assert err


def test_find_anomalies(seeded):
    payload, err = call(tools.find_anomalies, {"metric": "rhr", "sd_threshold": 0.1})
    assert not err
    assert payload["metric"] == "rhr"
    assert isinstance(payload["anomalies"], list)


def test_find_anomalies_unsupported_metric(seeded):
    _payload, err = call(tools.find_anomalies, {"metric": "steps"})
    assert err


def test_training_load_status(seeded):
    payload, err = call(tools.training_load_status, {})
    assert not err
    assert payload["current"]["ctl"] == 40.0


def test_training_load_status_empty(tmp_path, monkeypatch):
    p = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", p)
    db.init_schema(p)
    _payload, err = call(tools.training_load_status, {})
    assert err


def test_correlate(seeded):
    payload, err = call(tools.correlate, {"metric_a": "sleep_seconds", "metric_b": "rhr", "days": 30})
    assert not err
    assert payload["n_pairs"] >= 5
    assert "pearson_r" in payload


def test_correlate_with_lag(seeded):
    payload, err = call(
        tools.correlate, {"metric_a": "sleep_seconds", "metric_b": "rhr", "days": 30, "lag_days": 1}
    )
    assert not err


def test_correlate_bad_metric(seeded):
    _payload, err = call(tools.correlate, {"metric_a": "foo", "metric_b": "rhr", "days": 30})
    assert err


def test_correlate_insufficient(seeded):
    _payload, err = call(tools.correlate, {"metric_a": "sleep_seconds", "metric_b": "rhr", "days": 2})
    assert err  # < 5 paired points


def test_recovery_pattern(seeded):
    payload, err = call(tools.recovery_pattern, {"activity_type": "run", "min_distance_km": 5})
    assert not err
    assert payload["n_workouts_matched"] >= 0
    assert "recent_workouts" in payload


def test_run_sql_select(seeded):
    payload, err = call(tools.run_sql, {"query": "SELECT COUNT(*) AS c FROM daily_metrics"})
    assert not err
    assert payload["count"] == 1


def test_run_sql_rejects_non_select(seeded):
    _payload, err = call(tools.run_sql, {"query": "DELETE FROM daily_metrics"})
    assert err


def test_run_sql_rejects_forbidden_keyword(seeded):
    _payload, err = call(tools.run_sql, {"query": "WITH x AS (SELECT 1) UPDATE settings SET value='x'"})
    assert err


def test_run_sql_bad_query(seeded):
    _payload, err = call(tools.run_sql, {"query": "SELECT * FROM does_not_exist"})
    assert err


# --- notes tools (use LOCAL_FITNESS_NOTES_PATH from the fixture) ---

def test_save_and_list_user_notes(seeded):
    saved, err = call(tools.save_user_note, {"note": "lead with the workout card"})
    assert not err and saved["saved"]
    listed, err = call(tools.list_user_notes, {})
    assert not err
    assert listed["count"] == 1
    assert listed["notes"][0]["text"] == "lead with the workout card"


def test_save_user_note_empty(seeded):
    _payload, err = call(tools.save_user_note, {"note": "   "})
    assert err


def test_update_user_note(seeded):
    call(tools.save_user_note, {"note": "old"})
    updated, err = call(tools.update_user_note, {"line": 0, "note": "new"})
    assert not err
    assert updated["text"] == "new"


def test_update_user_note_bad_line(seeded):
    _payload, err = call(tools.update_user_note, {"line": None, "note": "x"})
    assert err
    _payload, err = call(tools.update_user_note, {"line": 0, "note": ""})
    assert err
    _payload, err = call(tools.update_user_note, {"line": 99, "note": "x"})
    assert err  # no note at that line


def test_delete_user_note(seeded):
    call(tools.save_user_note, {"note": "drop me"})
    deleted, err = call(tools.delete_user_note, {"line": 0})
    assert not err and deleted["deleted"]


def test_delete_user_note_bad_line(seeded):
    _payload, err = call(tools.delete_user_note, {"line": None})
    assert err
    _payload, err = call(tools.delete_user_note, {"line": 42})
    assert err


def test_server_and_tool_names():
    server = tools.make_server()
    assert server is not None
    names = tools.allowed_tool_names()
    assert len(names) == len(tools.ALL_TOOLS)
    assert all(n.startswith("mcp__fitness__") for n in names)
