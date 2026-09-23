"""API — bookmarks, annotations, clips, catégories de surlignage, timeline sémantique."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from backend import db
from backend.services import export_service, ffmpeg_service, storage_service

router = APIRouter()


def _audio(audio_id: int) -> dict:
    a = db.one("SELECT * FROM audio_files WHERE id = ?", (audio_id,))
    if not a:
        raise KeyError("Cet audio n'existe pas.")
    return a


def _clamp(a: dict, t: float) -> float:
    return round(max(0.0, min(float(t), a["duration"])), 3)


# --------------------------------------------------------------------------- bookmarks

class BookmarkBody(BaseModel):
    audio_id: int
    time: float
    label: str = ""


@router.get("/audio/{audio_id}/bookmarks")
def list_bookmarks(audio_id: int):
    return db.all("SELECT * FROM bookmarks WHERE audio_id = ? ORDER BY time", (audio_id,))


@router.post("/bookmarks")
def create_bookmark(body: BookmarkBody):
    a = _audio(body.audio_id)
    bid = db.insert("bookmarks", {"audio_id": a["id"], "time": _clamp(a, body.time),
                                  "label": body.label.strip()[:200] or "Point à reprendre"})
    return db.one("SELECT * FROM bookmarks WHERE id = ?", (bid,))


class LabelPatch(BaseModel):
    label: str | None = None
    time: float | None = None


@router.patch("/bookmarks/{bid}")
def patch_bookmark(bid: int, body: LabelPatch):
    data = body.model_dump(exclude_none=True)
    if "label" in data:
        data["label"] = data["label"].strip()[:200]
    db.update("bookmarks", bid, data)
    return db.one("SELECT * FROM bookmarks WHERE id = ?", (bid,))


@router.delete("/bookmarks/{bid}")
def delete_bookmark(bid: int):
    db.execute("DELETE FROM bookmarks WHERE id = ?", (bid,))
    return {"ok": True}


# --------------------------------------------------------------------------- annotations

class AnnotationBody(BaseModel):
    audio_id: int
    time: float
    end: float | None = None
    text: str
    category: str = ""
    color: str = "#E83967"
    segment_id: int | None = None


@router.get("/audio/{audio_id}/annotations")
def list_annotations(audio_id: int):
    return db.all("SELECT * FROM annotations WHERE audio_id = ? ORDER BY time", (audio_id,))


@router.post("/annotations")
def create_annotation(body: AnnotationBody):
    a = _audio(body.audio_id)
    if not body.text.strip():
        raise ValueError("L'annotation est vide.")
    aid = db.insert("annotations", {
        "audio_id": a["id"], "time": _clamp(a, body.time), "end": _clamp(a, body.end) if body.end is not None else None,
        "text": body.text.strip()[:4000], "category": body.category.strip()[:40],
        "color": body.color if body.color.startswith("#") and len(body.color) <= 9 else "#E83967",
        "segment_id": body.segment_id,
    })
    return db.one("SELECT * FROM annotations WHERE id = ?", (aid,))


class AnnotationPatch(BaseModel):
    text: str | None = None
    category: str | None = None
    color: str | None = None
    time: float | None = None


@router.patch("/annotations/{aid}")
def patch_annotation(aid: int, body: AnnotationPatch):
    db.update("annotations", aid, body.model_dump(exclude_none=True))
    return db.one("SELECT * FROM annotations WHERE id = ?", (aid,))


@router.delete("/annotations/{aid}")
def delete_annotation(aid: int):
    db.execute("DELETE FROM annotations WHERE id = ?", (aid,))
    return {"ok": True}


# --------------------------------------------------------------------------- clips

class ClipBody(BaseModel):
    audio_id: int
    start: float
    end: float
    title: str = ""
    description: str = ""
    tags: list[str] = []


def _clip(cid: int) -> dict:
    c = db.one("SELECT * FROM clips WHERE id = ?", (cid,))
    if not c:
        raise KeyError("Clip introuvable")
    c["tags"] = db.jloads(c["tags"], [])
    return c


@router.get("/audio/{audio_id}/clips")
def list_clips(audio_id: int):
    rows = db.all("SELECT * FROM clips WHERE audio_id = ? ORDER BY start", (audio_id,))
    for r in rows:
        r["tags"] = db.jloads(r["tags"], [])
    return rows


@router.get("/clips")
def all_clips():
    rows = db.all("SELECT c.*, a.title AS audio_title FROM clips c JOIN audio_files a ON a.id = c.audio_id "
                  "ORDER BY c.created_at DESC LIMIT 200")
    for r in rows:
        r["tags"] = db.jloads(r["tags"], [])
    return rows


@router.post("/clips")
def create_clip(body: ClipBody):
    a = _audio(body.audio_id)
    start, end = _clamp(a, body.start), _clamp(a, body.end)
    if end - start < 0.5:
        raise ValueError("Un clip doit durer au moins une demi-seconde.")
    file_name = f"{storage_service.new_uid()}.mp3"
    # FFmpeg génère l'extrait immédiatement (quelques secondes, même pour un long clip)
    ffmpeg_service.export_segment(storage_service.audio_path(a["stored_name"]), storage_service.clip_path(file_name),
                                  start, end, "mp3")
    from backend.services.util import fmt_time

    cid = db.insert("clips", {"audio_id": a["id"], "title": body.title.strip()[:200] or f"Extrait {fmt_time(start)}",
                              "start": start, "end": end, "description": body.description[:2000],
                              "tags": db.jdumps([t.strip()[:40] for t in body.tags if t.strip()]),
                              "file_name": file_name})
    return _clip(cid)


class ClipPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    tags: list[str] | None = None


@router.patch("/clips/{cid}")
def patch_clip(cid: int, body: ClipPatch):
    data = body.model_dump(exclude_none=True)
    if "tags" in data:
        data["tags"] = db.jdumps(data["tags"])
    db.update("clips", cid, data)
    return _clip(cid)


@router.delete("/clips/{cid}")
def delete_clip(cid: int):
    c = _clip(cid)
    if c["file_name"]:
        storage_service.clip_path(c["file_name"]).unlink(missing_ok=True)
    db.execute("DELETE FROM clips WHERE id = ?", (cid,))
    return {"ok": True}


@router.get("/clips/{cid}/download")
def download_clip(cid: int, fmt: str = "mp3"):
    c = _clip(cid)
    if fmt == "mp3" and c["file_name"] and storage_service.clip_path(c["file_name"]).exists():
        body = storage_service.clip_path(c["file_name"]).read_bytes()
        name = storage_service.slugify(c["title"]) + ".mp3"
        mime = "audio/mpeg"
    else:
        body, name, mime = export_service.export_range(c["audio_id"], c["start"], c["end"], fmt, c["title"])
    return Response(body, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"'})


# --------------------------------------------------------------------------- catégories de surlignage

@router.get("/highlight-categories")
def list_categories():
    return db.all("SELECT * FROM highlight_categories ORDER BY id")


class CategoryBody(BaseModel):
    name: str
    color: str = "#B1ADA1"


@router.post("/highlight-categories")
def create_category(body: CategoryBody):
    name = body.name.strip()[:40]
    if not name:
        raise ValueError("Nom de catégorie vide.")
    db.execute("INSERT OR IGNORE INTO highlight_categories(name, color) VALUES (?, ?)", (name, body.color[:9]))
    return db.one("SELECT * FROM highlight_categories WHERE name = ?", (name,))


@router.delete("/highlight-categories/{cid}")
def delete_category(cid: int):
    db.execute("DELETE FROM highlight_categories WHERE id = ?", (cid,))
    return {"ok": True}


# --------------------------------------------------------------------------- timeline sémantique

@router.get("/audio/{audio_id}/timeline")
def timeline(audio_id: int):
    """Tous les éléments positionnés dans le temps, pour la waveform et la timeline sémantique."""
    _audio(audio_id)
    q = lambda sql: db.all(sql, (audio_id,))  # noqa: E731
    return {
        "chapters": q("SELECT id, title, start, end, importance FROM chapters WHERE audio_id = ? ORDER BY start"),
        "highlights": q("SELECT id, start, end, text, category, importance, source, note, favorite FROM highlights "
                        "WHERE audio_id = ? ORDER BY start"),
        "decisions": q("SELECT id, time, text FROM decisions WHERE audio_id = ? AND time IS NOT NULL ORDER BY time"),
        "actions": q("SELECT id, time, text, owner, status FROM actions WHERE audio_id = ? AND time IS NOT NULL ORDER BY time"),
        "questions": q("SELECT id, time, text FROM questions WHERE audio_id = ? AND time IS NOT NULL ORDER BY time"),
        "risks": q("SELECT id, time, text, kind FROM risks WHERE audio_id = ? AND time IS NOT NULL ORDER BY time"),
        "bookmarks": q("SELECT * FROM bookmarks WHERE audio_id = ? ORDER BY time"),
        "annotations": q("SELECT * FROM annotations WHERE audio_id = ? ORDER BY time"),
        "clips": q("SELECT id, title, start, end FROM clips WHERE audio_id = ? ORDER BY start"),
    }
