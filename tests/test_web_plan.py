"""Functional tests for the training-plan REST endpoints."""
from __future__ import annotations

import importlib
from datetime import date, timedelta

import httpx
import pytest

from local_fitness import db, plans


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def srv(tmp_path, monkeypatch):
    db_path = tmp_path / "fitness.db"
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", db_path)
    monkeypatch.delenv("LOCAL_FITNESS_API_TOKEN", raising=False)
    db.init_schema(db_path)
    with db.connect(db_path) as conn:  # data frontier = today
        conn.execute("INSERT INTO daily_metrics (date, rhr) VALUES (?, 50)",
                     (date.today().isoformat(),))
    from local_fitness.web import server as s
    importlib.reload(s)
    return s


def _client(srv):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=srv.app), base_url="http://t")


def _seed_draft(dbp):
    t = date.today()
    return plans.insert_draft(
        {"goal_type": "10k", "race_date": (t + timedelta(days=90)).isoformat(),
         "target_time_seconds": 3000, "goal_distance_m": 10000.0, "title": "Sub-50",
         "ability_snapshot": {"vo2": 48}, "created_at": t.isoformat()},
        [dict(date=(t + timedelta(days=1)).isoformat(), week_index=1, type="easy",
              target_distance_m=6000.0, description="6km easy")],
        db_path=dbp,
    )


def _seed_committed(dbp):
    pid = _seed_draft(dbp)
    plans.commit_plan(pid, now="t", db_path=dbp)
    return pid


@pytest.mark.anyio
async def test_plan_empty(srv):
    async with _client(srv) as c:
        r = await c.get("/api/plan")
    assert r.status_code == 200
    assert r.json() == {"active": None, "draft": None}


@pytest.mark.anyio
async def test_plan_populated(srv):
    _seed_committed(db.DEFAULT_DB_PATH)
    async with _client(srv) as c:
        r = await c.get("/api/plan")
    body = r.json()["active"]
    assert body["goal_type"] == "10k"
    for key in ("workouts", "weekly_mileage", "adherence_pct", "ctl_series",
                "predicted_finish_seconds"):
        assert key in body


@pytest.mark.anyio
async def test_commit_endpoint(srv):
    pid = _seed_draft(db.DEFAULT_DB_PATH)
    async with _client(srv) as c:
        r = await c.post(f"/api/plan/{pid}/commit")
    assert r.status_code == 200 and r.json()["status"] == "active"
    assert plans.get_active_plan(db_path=db.DEFAULT_DB_PATH)["plan_id"] == pid


@pytest.mark.anyio
async def test_commit_missing_404(srv):
    async with _client(srv) as c:
        r = await c.post("/api/plan/9999/commit")
    assert r.status_code == 404


@pytest.mark.anyio
async def test_commit_nondraft_409(srv):
    pid = _seed_committed(db.DEFAULT_DB_PATH)
    async with _client(srv) as c:
        r = await c.post(f"/api/plan/{pid}/commit")
    assert r.status_code == 409


@pytest.mark.anyio
async def test_delete_endpoint(srv):
    pid = _seed_committed(db.DEFAULT_DB_PATH)
    async with _client(srv) as c:
        r = await c.delete(f"/api/plan/{pid}")
    assert r.status_code == 200 and r.json()["status"] == "archived"
    assert plans.get_active_plan(db_path=db.DEFAULT_DB_PATH) is None


@pytest.mark.anyio
async def test_delete_missing_404(srv):
    async with _client(srv) as c:
        r = await c.delete("/api/plan/9999")
    assert r.status_code == 404


@pytest.mark.anyio
async def test_plan_id_rejects_non_int(srv):
    async with _client(srv) as c:
        r = await c.post("/api/plan/abc/commit")
    assert r.status_code == 422
