"""Tests for ingest/baselines.py — rolling baselines + CTL/ATL/TSB."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from local_fitness import db
from local_fitness.ingest import baselines


@pytest.fixture
def seeded_db(tmp_path, monkeypatch):
    p = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", p)
    db.init_schema(p)
    return p


def test_ewma_factor_monotonic():
    # Shorter time constant → larger smoothing factor (more responsive).
    assert baselines._ewma_factor(7) > baselines._ewma_factor(42)


def test_sd_needs_two_points():
    assert baselines._sd([5.0]) is None
    assert baselines._sd([]) is None
    assert baselines._sd([2.0, 4.0]) == pytest.approx(1.4142135, rel=1e-4)
    # None values are filtered out
    assert baselines._sd([2.0, None, 4.0]) == pytest.approx(1.4142135, rel=1e-4)


def test_recompute_empty_db_writes_window(seeded_db):
    through = date(2026, 6, 6)
    n = baselines.recompute(through=through, lookback_days=10)
    assert n == 11  # inclusive
    # No activities → CTL/ATL/TSB stay NULL
    with db.connect(seeded_db) as conn:
        row = conn.execute(
            "SELECT ctl, atl, tsb FROM baselines WHERE date = ?", (through.isoformat(),)
        ).fetchone()
    assert row["ctl"] is None


def test_recompute_with_activities_and_metrics(seeded_db):
    through = date(2026, 6, 6)
    with db.connect(seeded_db) as conn:
        # Daily metrics across the baseline window for mean/SD.
        for i in range(70):
            d = (through - timedelta(days=i)).isoformat()
            conn.execute(
                "INSERT INTO daily_metrics (date, rhr, sleep_seconds, body_battery_max, "
                "body_battery_min, avg_stress) VALUES (?, ?, ?, ?, ?, ?)",
                (d, 50 + (i % 3), 27000, 90, 20, 30),
            )
        # A handful of runs feeding training load.
        for i in range(10):
            d = (through - timedelta(days=i)).isoformat()
            conn.execute(
                "INSERT INTO activities (activity_id, date, activity_type, training_load) "
                "VALUES (?, ?, 'running', ?)",
                (i, d, 80.0),
            )

    n = baselines.recompute(through=through, lookback_days=30)
    assert n == 31
    with db.connect(seeded_db) as conn:
        row = conn.execute(
            "SELECT rhr_60day_mean, rhr_60day_sd, ctl, atl, tsb "
            "FROM baselines WHERE date = ?", (through.isoformat(),)
        ).fetchone()
    assert row["rhr_60day_mean"] is not None
    assert row["rhr_60day_sd"] is not None
    assert row["ctl"] is not None and row["atl"] is not None
    # Fresh load: ATL (7-day) climbs faster than CTL (42-day) on a run streak,
    # so TSB (= CTL - ATL) is negative.
    assert row["tsb"] == pytest.approx(row["ctl"] - row["atl"])
    assert row["tsb"] < 0
