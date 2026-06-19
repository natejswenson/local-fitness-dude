"""Functional tests for GET /api/brief — today's brief + the load_latest
fallback to a prior-day brief, and the empty shape when no briefs exist.

The route is ``briefs.load_today() or briefs.load_latest()``, so a tmp
briefings dir (monkeypatched onto ``briefs.DEFAULT_BRIEFINGS_DIR``) lets us
exercise all three cases without touching the real briefings/.
"""
from __future__ import annotations

import importlib
from datetime import date, timedelta

import httpx
import pytest

from local_fitness import db
from local_fitness.agent import briefs
from local_fitness.agent.schemas import Brief


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def srv(tmp_path, monkeypatch):
    db_path = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", db_path)
    monkeypatch.delenv("LOCAL_FITNESS_API_TOKEN", raising=False)
    out = tmp_path / "briefings"
    monkeypatch.setattr(briefs, "DEFAULT_BRIEFINGS_DIR", out)
    db.init_schema(db_path)
    with db.connect(db_path) as conn:  # data frontier = today
        conn.execute("INSERT INTO daily_metrics (date, rhr) VALUES (?, 50)",
                     (date.today().isoformat(),))
    from local_fitness.web import server as s
    importlib.reload(s)
    return out


def _client():
    from local_fitness.web import server as s
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=s.app), base_url="http://t")


def _write_brief(out_dir, d: str, headline: str):
    out_dir.mkdir(parents=True, exist_ok=True)
    tk = {
        "headline": headline,
        "summary": "Backing data line.",
        "tone": "neutral",
        "details": "Details.",
    }
    brief = Brief.model_validate(
        {"date": d, "user_name": "tester", "generated_at": f"{d}T08:00:00",
         "takeaways": [tk]}
    )
    (out_dir / f"{d}.json").write_text(brief.model_dump_json(indent=2), encoding="utf-8")


@pytest.mark.anyio
async def test_brief_serves_today(srv):
    today = date.today().isoformat()
    _write_brief(srv, today, "Today's brief")
    async with _client() as c:
        r = await c.get("/api/brief")
    body = r.json()
    assert r.status_code == 200
    assert body["cached"] is True
    assert body["date"] == today
    assert body["brief"]["takeaways"][0]["headline"] == "Today's brief"


@pytest.mark.anyio
async def test_brief_falls_back_to_prior_day(srv):
    # No file for today; a prior-day brief exists → load_latest fallback.
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    _write_brief(srv, yesterday, "Yesterday's brief")
    async with _client() as c:
        r = await c.get("/api/brief")
    body = r.json()
    assert r.status_code == 200
    # Served the prior-day brief — NOT the empty shape.
    assert body["cached"] is True
    assert body["brief"] is not None
    assert body["date"] == yesterday
    assert body["brief"]["takeaways"][0]["headline"] == "Yesterday's brief"


@pytest.mark.anyio
async def test_brief_empty_shape_when_none(srv):
    async with _client() as c:
        r = await c.get("/api/brief")
    body = r.json()
    assert r.status_code == 200
    assert body["cached"] is False
    assert body["brief"] is None
    assert body["date"] == date.today().isoformat()
