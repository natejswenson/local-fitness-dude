"""Tests for the structured-output schemas in agent/schemas.py."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from local_fitness.agent import schemas


def test_takeaway_minimal_valid():
    t = schemas.Takeaway(headline="Run easy today", summary="RHR is up a touch", details="...")
    assert t.tone == "neutral"
    assert t.metric is None


def test_tone_whitespace_collapsed():
    # Models occasionally stream `"crit\nical"` — the validator must heal it.
    t = schemas.Takeaway(headline="h", summary="s", details="d", tone="crit\nical")
    assert t.tone == "critical"


def test_prose_fields_edge_trimmed_but_internal_preserved():
    t = schemas.Takeaway(
        headline="  Lead  ",
        summary="why",
        details="line one\nline two  ",
    )
    assert t.headline == "Lead"
    assert "\n" in t.details  # internal newline preserved in prose
    assert not t.details.endswith(" ")


def test_metric_whitespace_collapsed():
    m = schemas.TakeawayMetric(metric="r\nhr")
    assert m.metric == "rhr"
    assert m.days == 14


def test_metric_days_bounds():
    with pytest.raises(ValidationError):
        schemas.TakeawayMetric(metric="rhr", days=3)
    with pytest.raises(ValidationError):
        schemas.TakeawayMetric(metric="rhr", days=1000)


def test_bad_tone_rejected():
    with pytest.raises(ValidationError):
        schemas.Takeaway(headline="h", summary="s", details="d", tone="ecstatic")


def test_bad_metric_rejected():
    with pytest.raises(ValidationError):
        schemas.TakeawayMetric(metric="heart_rate_variability")


def test_brief_requires_at_least_one_takeaway():
    with pytest.raises(ValidationError):
        schemas.Brief(date="2026-06-06", user_name="Dana", takeaways=[])


def test_brief_caps_at_five_takeaways():
    one = schemas.Takeaway(headline="h", summary="s", details="d")
    with pytest.raises(ValidationError):
        schemas.Brief(date="2026-06-06", user_name="Dana", takeaways=[one] * 6)


def test_brief_generated_at_optional():
    one = schemas.Takeaway(headline="h", summary="s", details="d")
    b = schemas.Brief(date="2026-06-06", user_name="Dana", takeaways=[one])
    assert b.generated_at is None
