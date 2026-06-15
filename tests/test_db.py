"""Tests for db.py — schema init, settings, and run-state helpers."""
from __future__ import annotations

from datetime import date

import pytest

from local_fitness import db


@pytest.fixture
def dbp(tmp_path):
    p = tmp_path / "fitness.db"
    db.init_schema(p)
    return p


def test_init_schema_idempotent(dbp):
    # Calling again must not raise.
    db.init_schema(dbp)


def test_settings_roundtrip(dbp):
    assert db.get_setting("user_name", db_path=dbp) is None
    assert db.get_setting("user_name", default="nobody", db_path=dbp) == "nobody"
    db.set_setting("user_name", "Dana", db_path=dbp)
    assert db.get_setting("user_name", db_path=dbp) == "Dana"
    # ON CONFLICT update path
    db.set_setting("user_name", "Sam", db_path=dbp)
    assert db.get_setting("user_name", db_path=dbp) == "Sam"
    assert db.all_settings(db_path=dbp) == {"user_name": "Sam"}


def test_last_known_daily_date(dbp):
    assert db.last_known_daily_date(db_path=dbp) is None
    with db.connect(dbp) as conn:
        conn.execute("INSERT INTO daily_metrics (date, rhr) VALUES ('2026-06-01', 50)")
        conn.execute("INSERT INTO daily_metrics (date, rhr) VALUES ('2026-06-03', 51)")
    assert db.last_known_daily_date(db_path=dbp) == "2026-06-03"


def test_missing_daily_dates(dbp):
    with db.connect(dbp) as conn:
        conn.execute("INSERT INTO daily_metrics (date, rhr) VALUES ('2026-06-02', 50)")
    missing = db.missing_daily_dates(date(2026, 6, 1), date(2026, 6, 3), db_path=dbp)
    assert missing == [date(2026, 6, 1), date(2026, 6, 3)]


def test_mark_orphaned_runs(dbp):
    with db.connect(dbp) as conn:
        conn.execute(
            "INSERT INTO ingest_runs (started_at, status) VALUES ('2026-06-01T00:00:00', 'in_progress')"
        )
    assert db.mark_orphaned_runs(db_path=dbp) == 1
    # second call: nothing left in_progress
    assert db.mark_orphaned_runs(db_path=dbp) == 0
    with db.connect(dbp) as conn:
        row = conn.execute("SELECT status FROM ingest_runs").fetchone()
    assert row["status"] == "orphaned"


def test_connect_rolls_back_on_error(dbp):
    with pytest.raises(ValueError):
        with db.connect(dbp) as conn:
            conn.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')")
            raise ValueError("boom")
    # the insert must have been rolled back
    assert db.get_setting("k", db_path=dbp) is None


def test_get_db_path_creates_parent(tmp_path, monkeypatch):
    target = tmp_path / "nested" / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", target)
    assert db.get_db_path() == target
    assert target.parent.exists()


def test_default_db_path_honors_env(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_FITNESS_DATA_DIR", str(tmp_path))
    assert db._default_db_path() == tmp_path / "fitness.db"
    monkeypatch.delenv("LOCAL_FITNESS_DATA_DIR")
    assert db._default_db_path().name == "fitness.db"


def test_training_plan_tables_exist(dbp):
    with db.connect(dbp) as conn:
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert {"training_plans", "plan_workouts"} <= tables


def test_one_active_plan_unique_index(dbp):
    import sqlite3

    # First active plan is fine.
    with db.connect(dbp) as conn:
        conn.execute(
            "INSERT INTO training_plans (status, goal_type, race_date, created_at) "
            "VALUES ('active', '10k', '2026-09-14', '2026-06-15T00:00:00')"
        )
    # A second active plan must violate the partial unique index.
    with pytest.raises(sqlite3.IntegrityError):
        with db.connect(dbp) as conn:
            conn.execute(
                "INSERT INTO training_plans (status, goal_type, race_date, created_at) "
                "VALUES ('active', '5k', '2026-10-01', '2026-06-15T00:00:00')"
            )
    # Archived/draft rows are unconstrained — many allowed.
    with db.connect(dbp) as conn:
        conn.execute(
            "INSERT INTO training_plans (status, goal_type, race_date, created_at) "
            "VALUES ('draft', '5k', '2026-10-01', '2026-06-15T00:00:00')"
        )
        conn.execute(
            "INSERT INTO training_plans (status, goal_type, race_date, created_at) "
            "VALUES ('archived', 'half', '2026-11-01', '2026-06-15T00:00:00')"
        )


def test_plan_workouts_columns(dbp):
    with db.connect(dbp) as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(plan_workouts)")}
    assert {
        "workout_id",
        "plan_id",
        "date",
        "seq",
        "week_index",
        "type",
        "target_distance_m",
        "target_pace_sec_per_km",
        "target_duration_sec",
        "description",
    } <= cols
