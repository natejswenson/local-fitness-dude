"""Tests for the user-tunable config accessors (DB > env > default)."""
from __future__ import annotations

import pytest

from local_fitness import config, db, plans


@pytest.fixture
def dbp(tmp_path, monkeypatch):
    p = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", p)
    db.init_schema(p)
    # ensure no leakage from the real environment
    for env in ("LOCAL_FITNESS_COUNT_WALKS_EASY", "LOCAL_FITNESS_COUNT_WALKS_MILEAGE",
                "LOCAL_FITNESS_GRADE_DONE_FRACTION", "LOCAL_FITNESS_GRADE_PARTIAL_FRACTION",
                "LOCAL_FITNESS_RIEGEL_LOOKBACK_DAYS"):
        monkeypatch.delenv(env, raising=False)
    return p


def test_defaults_when_unset(dbp):
    assert config.count_walks_easy() is True
    assert config.count_walks_mileage() is False
    assert config.grade_done_fraction() == 0.80
    assert config.grade_partial_fraction() == 0.40
    assert config.riegel_lookback_days() == 120


def test_env_overrides_default(dbp, monkeypatch):
    monkeypatch.setenv("LOCAL_FITNESS_COUNT_WALKS_EASY", "false")
    monkeypatch.setenv("LOCAL_FITNESS_GRADE_DONE_FRACTION", "0.9")
    assert config.count_walks_easy() is False
    assert config.grade_done_fraction() == 0.9


def test_db_overrides_env(dbp, monkeypatch):
    monkeypatch.setenv("LOCAL_FITNESS_COUNT_WALKS_EASY", "false")
    db.set_setting("count_walks_easy", "true")
    assert config.count_walks_easy() is True  # DB wins over env


def test_blank_db_falls_through_to_env(dbp, monkeypatch):
    monkeypatch.setenv("LOCAL_FITNESS_COUNT_WALKS_EASY", "false")
    db.set_setting("count_walks_easy", "   ")  # blank → unset → env
    assert config.count_walks_easy() is False


def test_blank_env_falls_to_default(dbp, monkeypatch):
    monkeypatch.setenv("LOCAL_FITNESS_COUNT_WALKS_EASY", "")  # blank → default
    assert config.count_walks_easy() is True


def test_unrecognized_bool_falls_to_default_not_false(dbp):
    db.set_setting("count_walks_easy", "maybe")
    assert config.count_walks_easy() is True  # NOT silently False (SIG-1)


def test_bad_float_falls_to_default(dbp):
    db.set_setting("grade_done_fraction", "abc")
    assert config.grade_done_fraction() == 0.80


def test_as_bool_tokens():
    assert config._as_bool("ON") is True
    assert config._as_bool("No") is False
    with pytest.raises(ValueError):
        config._as_bool("maybe")


def test_riegel_clamps_nonsense_to_default(dbp):
    for bad in ("0", "-5", "99999"):
        db.set_setting("riegel_lookback_days", bad)
        assert config.riegel_lookback_days() == 120
    db.set_setting("riegel_lookback_days", "200")
    assert config.riegel_lookback_days() == 200


def test_resolve_grading_config_reverts_inverted_fraction_pair(dbp):
    # partial > done would make 'partial' unreachable → revert BOTH to defaults
    db.set_setting("grade_done_fraction", "0.4")
    db.set_setting("grade_partial_fraction", "0.8")
    cfg = plans.resolve_grading_config()
    assert cfg.done_fraction == 0.80 and cfg.partial_fraction == 0.40


def test_resolve_grading_config_reverts_out_of_range(dbp):
    db.set_setting("grade_done_fraction", "2.0")  # > 1 → revert both
    cfg = plans.resolve_grading_config()
    assert cfg.done_fraction == 0.80 and cfg.partial_fraction == 0.40


def test_resolve_grading_config_accepts_valid_custom(dbp):
    db.set_setting("grade_done_fraction", "0.9")
    db.set_setting("grade_partial_fraction", "0.5")
    db.set_setting("count_walks_easy", "false")
    cfg = plans.resolve_grading_config()
    assert cfg.done_fraction == 0.9
    assert cfg.partial_fraction == 0.5
    assert cfg.count_walks_easy is False
