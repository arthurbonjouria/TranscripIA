"""API — tâches, comparaison et briefing multi-audios."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from backend import db
from backend.jobs import manager
from backend.services import analysis_store

router = APIRouter()


@router.get("/jobs")
def list_jobs(active: bool = False, audio_id: int | None = None, limit: int = 50):
    return manager.list_jobs(limit=min(limit, 200), active_only=active, audio_id=audio_id)


@router.get("/jobs/{job_id}")
def get_job(job_id: int):
    j = manager.get(job_id)
    if not j:
        raise KeyError("Tâche introuvable")
    return j


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int):
    manager.cancel(job_id)
    return manager.get(job_id)


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: int):
    return {"job_id": manager.retry(job_id)}


@router.delete("/jobs/finished")
def clear_finished():
    db.execute("DELETE FROM jobs WHERE status IN ('COMPLETED', 'CANCELLED') AND finished_at < datetime('now', '-1 day')")
    return {"ok": True}


class MultiBody(BaseModel):
    audio_ids: list[int]


def _scope(ids: list[int]) -> str:
    rows = db.all(f"SELECT id, recorded_at, created_at FROM audio_files WHERE id IN ({','.join('?' * len(ids))})", ids)
    rows.sort(key=lambda a: (a.get("recorded_at") or a["created_at"]))
    return ",".join(str(r["id"]) for r in rows)


@router.post("/compare")
def compare(body: MultiBody):
    ids = sorted(set(body.audio_ids))
    if len(ids) < 2:
        raise ValueError("Sélectionnez au moins deux audios à comparer.")
    return {"job_id": manager.create("comparison", None, {"audio_ids": ids})}


@router.post("/prep-briefing")
def prep_briefing(body: MultiBody):
    ids = sorted(set(body.audio_ids))
    if not ids:
        raise ValueError("Sélectionnez au moins un audio.")
    return {"job_id": manager.create("prep_briefing", None, {"audio_ids": ids})}


@router.get("/multi/{kind}")
def multi_result(kind: str, ids: str):
    if kind not in ("comparison", "prep_briefing"):
        raise KeyError("Type inconnu")
    id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]
    if not id_list:
        return None
    row = analysis_store.current(None, kind, _scope(id_list))
    return row


@router.get("/multi/{kind}/history")
def multi_history(kind: str):
    if kind not in ("comparison", "prep_briefing"):
        raise KeyError("Type inconnu")
    rows = db.all("SELECT id, scope, created_at, content FROM analyses WHERE audio_id IS NULL AND kind = ? "
                  "AND is_current = 1 ORDER BY id DESC LIMIT 20", (kind,))
    for r in rows:
        r["content"] = db.jloads(r["content"], {})
    return rows
