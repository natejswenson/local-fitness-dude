"""Pydantic schemas for agent-produced structured output.

The brief is a small JSON structure: an ordered list of Takeaways. Each
Takeaway has the headline you see at a glance, a tone for visual
treatment, an optional metric pointer for the embedded chart, and a
markdown deep-dive that's hidden until the user expands the card.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# Whitelisted metric names — must be queryable via /api/metric/{name} or
# /api/training-load. Keep this list aligned with the FastAPI _ALLOWED_METRICS.
MetricName = Literal[
    "rhr",
    "sleep_seconds",
    "sleep_score",
    "avg_stress",
    "body_battery_max",
    "body_battery_min",
    "vo2_max",
    "steps",
    "intensity_minutes_moderate",
    "intensity_minutes_vigorous",
    # Training-load model — the API exposes these under /api/training-load
    "ctl",
    "atl",
    "tsb",
]

Tone = Literal["positive", "caution", "critical", "neutral"]


class TakeawayMetric(BaseModel):
    metric: MetricName
    days: int = Field(14, ge=7, le=730, description="Window for the inline chart")


class Takeaway(BaseModel):
    headline: str = Field(..., description="One-line action or insight, ~6-12 words")
    summary: str = Field(..., description="One-line 'why' — the data backing it, ~10-25 words")
    tone: Tone = Field("neutral", description="Sentiment for color treatment")
    metric: TakeawayMetric | None = Field(None, description="What metric to chart inline")
    details: str = Field(..., description="Full markdown deep-dive shown when expanded")


class Brief(BaseModel):
    date: str
    user_name: str
    takeaways: list[Takeaway] = Field(..., min_length=1, max_length=5)
