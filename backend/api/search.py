"""API — recherche plein texte, sémantique et globale."""
from __future__ import annotations

from fastapi import APIRouter, Query

from backend.services import search_service

router = APIRouter()


def _ids(audio_ids: str) -> list[int] | None:
    ids = [int(x) for x in audio_ids.split(",") if x.strip().isdigit()]
    return ids or None


@router.get("/search")
def search(q: str = Query(..., min_length=1, max_length=300), audio_ids: str = "", mode: str = "text",
           limit: int = Query(50, le=200), offset: int = 0):
    ids = _ids(audio_ids)
    out = {"query": q, "mode": mode, "semantic_available": search_service.embedding_available()}
    if mode == "semantic":
        if not out["semantic_available"]:
            # repli honnête : recherche par passages en plein texte
            out["results"] = search_service.passage_text_search(q, ids, limit)
            out["fallback"] = True
        else:
            out["results"] = search_service.semantic_search(q, ids, limit)
        return out
    results = search_service.text_search(q, ids, limit, offset)
    out["results"] = results
    groups: dict[int, dict] = {}
    for r in results:
        g = groups.setdefault(r["audio_id"], {"audio_id": r["audio_id"], "audio_title": r["audio_title"], "count": 0})
        g["count"] += 1
    out["by_audio"] = sorted(groups.values(), key=lambda g: -g["count"])
    return out
