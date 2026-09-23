"""API — audios, bibliothèque, upload, lecture, transcription, tags, tableau de bord."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from backend import db, settings
from backend.jobs import manager
from backend.services import analysis_store, ffmpeg_service, storage_service, transcription_service, whisper_service
from backend.services.storage_service import UploadError

router = APIRouter()
log = logging.getLogger("api.audio")

SORTS = {"created": "a.created_at", "title": "a.title COLLATE NOCASE", "duration": "a.duration",
         "size": "a.size_bytes", "opened": "a.last_opened_at", "recorded": "COALESCE(a.recorded_at, a.created_at)"}


def _get_audio(audio_id: int) -> dict:
    a = db.one("SELECT * FROM audio_files WHERE id = ?", (audio_id,))
    if not a:
        raise KeyError("Cet audio n'existe pas ou a été supprimé.")
    return a


def _tags_for(ids: list[int]) -> dict[int, list[dict]]:
    if not ids:
        return {}
    rows = db.all(f"SELECT at.audio_id, t.id, t.name, t.color FROM audio_tags at JOIN tags t ON t.id = at.tag_id "
                  f"WHERE at.audio_id IN ({','.join('?' * len(ids))}) ORDER BY t.name", ids)
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["audio_id"], []).append({"id": r["id"], "name": r["name"], "color": r["color"]})
    return out


COUNTS_SQL = """
    (SELECT COUNT(*) FROM chapters c WHERE c.audio_id = a.id) AS chapter_count,
    (SELECT COUNT(*) FROM highlights h WHERE h.audio_id = a.id) AS highlight_count,
    (SELECT COUNT(*) FROM people p WHERE p.audio_id = a.id) AS people_count,
    (SELECT COUNT(*) FROM actions x WHERE x.audio_id = a.id) AS action_count,
    (SELECT COUNT(*) FROM decisions d WHERE d.audio_id = a.id) AS decision_count
"""


# --------------------------------------------------------------------------- upload

@router.post("/audio/upload")
async def upload(file: UploadFile = File(...), auto_process: bool = Form(True), language: str = Form(""),
                 profile: str = Form("")):
    ext = storage_service.safe_extension(file.filename or "")
    max_bytes = settings.get("audio.max_upload_mb") * 1024 * 1024
    uid = storage_service.new_uid()
    stored_name = f"{uid}{ext}"
    target = storage_service.audio_path(stored_name)
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    head = b""
    try:
        with open(target, "wb") as out:
            while chunk := await file.read(4 * 1024 * 1024):
                if not head:
                    head = chunk[:64]
                    if storage_service.sniff_mime(head) is None:
                        raise UploadError("Le contenu du fichier ne correspond pas à un format audio reconnu.")
                size += len(chunk)
                if size > max_bytes:
                    raise UploadError(f"Fichier trop volumineux (maximum {settings.get('audio.max_upload_mb')} Mo).")
                out.write(chunk)
        if size == 0:
            raise UploadError("Le fichier est vide.")
        info = ffmpeg_service.probe(target)
        if info["duration"] <= 0:
            raise UploadError("Durée audio illisible.")
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    lang = language.strip().lower()[:5]
    audio_id = db.insert("audio_files", {
        "uid": uid, "original_name": (file.filename or "audio")[:255], "title": storage_service.clean_title(file.filename),
        "stored_name": stored_name, "ext": ext.lstrip("."), "mime": storage_service.sniff_mime(head) or "",
        "size_bytes": size, "duration": info["duration"], "codec": info["codec"], "sample_rate": info["sample_rate"],
        "channels": info["channels"], "bitrate": info["bitrate"], "language": lang,
    })
    log.info("Audio importé #%s (%.0f s, %s)", audio_id, info["duration"], info["codec"])
    prof = profile if profile in whisper_service.PROFILES else None
    job_id = manager.create("process", audio_id, {"language": lang, "profile": prof}) if auto_process else None
    return {"id": audio_id, "job_id": job_id, **info, "size_bytes": size}


# --------------------------------------------------------------------------- bibliothèque

@router.get("/audio")
def list_audio(q: str = "", status: str = "", tag: int | None = None, category: str = "",
               favorite: bool | None = None, archived: bool = False, sort: str = "created", order: str = "desc",
               limit: int = Query(50, le=500), offset: int = 0):
    where, params = ["a.archived = ?"], [1 if archived else 0]
    if q:
        where.append("(a.title LIKE ? OR a.description LIKE ? OR a.original_name LIKE ? OR a.participants LIKE ?)")
        params += [f"%{q}%"] * 4
    if status:
        where.append("a.status = ?")
        params.append(status)
    if category:
        where.append("a.category = ?")
        params.append(category)
    if favorite is not None:
        where.append("a.favorite = ?")
        params.append(1 if favorite else 0)
    if tag:
        where.append("EXISTS (SELECT 1 FROM audio_tags t WHERE t.audio_id = a.id AND t.tag_id = ?)")
        params.append(tag)
    col = SORTS.get(sort, SORTS["created"])
    direction = "ASC" if order == "asc" else "DESC"
    sql_where = " WHERE " + " AND ".join(where)
    total = db.scalar(f"SELECT COUNT(*) FROM audio_files a{sql_where}", params)
    rows = db.all(f"SELECT a.*, {COUNTS_SQL} FROM audio_files a{sql_where} ORDER BY {col} {direction} "
                  f"LIMIT ? OFFSET ?", [*params, limit, offset])
    tags = _tags_for([r["id"] for r in rows])
    for r in rows:
        r["tags"] = tags.get(r["id"], [])
    cats = [r["category"] for r in db.all("SELECT DISTINCT category FROM audio_files WHERE category != '' ORDER BY 1")]
    return {"items": rows, "total": total, "categories": cats}


@router.get("/audio/{audio_id}")
def get_audio(audio_id: int, touch: bool = False):
    a = _get_audio(audio_id)
    if touch:
        db.execute("UPDATE audio_files SET last_opened_at = datetime('now') WHERE id = ?", (audio_id,))
    full = db.one(f"SELECT a.*, {COUNTS_SQL} FROM audio_files a WHERE a.id = ?", (audio_id,))
    full["tags"] = _tags_for([audio_id]).get(audio_id, [])
    full["transcription"] = transcription_service.current_transcription(audio_id)
    full["jobs"] = manager.list_jobs(limit=5, audio_id=audio_id)
    full["has_summary"] = analysis_store.current(audio_id, "summary") is not None
    full["analysis_stale"] = bool(full["has_summary"] and not analysis_store.is_fresh(a, "summary"))
    full["peaks_ready"] = storage_service.peaks_path(a["uid"]).exists()
    return full


class AudioPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    category: str | None = None
    participants: str | None = None
    recorded_at: str | None = None
    language: str | None = None
    favorite: bool | None = None
    archived: bool | None = None
    tags: list[str] | None = None


@router.patch("/audio/{audio_id}")
def patch_audio(audio_id: int, body: AudioPatch):
    _get_audio(audio_id)
    data = body.model_dump(exclude_none=True)
    tags = data.pop("tags", None)
    for k in ("favorite", "archived"):
        if k in data:
            data[k] = 1 if data[k] else 0
    if "title" in data and not data["title"].strip():
        raise ValueError("Le titre ne peut pas être vide.")
    if data:
        data["updated_at"] = db.scalar("SELECT datetime('now')")
        db.update("audio_files", audio_id, data)
    if tags is not None:
        with db.transaction() as c:
            c.execute("DELETE FROM audio_tags WHERE audio_id = ?", (audio_id,))
            for name in {t.strip()[:40] for t in tags if t.strip()}:
                c.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (name,))
                tid = c.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()["id"]
                c.execute("INSERT OR IGNORE INTO audio_tags(audio_id, tag_id) VALUES (?, ?)", (audio_id, tid))
    return get_audio(audio_id)


@router.delete("/audio/{audio_id}")
def delete_audio(audio_id: int):
    a = _get_audio(audio_id)
    for j in manager.list_jobs(active_only=True, audio_id=audio_id):
        manager.cancel(j["id"])
    clips = db.all("SELECT file_name FROM clips WHERE audio_id = ? AND file_name IS NOT NULL", (audio_id,))
    with db.transaction() as c:
        c.execute("DELETE FROM segments_fts WHERE audio_id = ?", (audio_id,))
        c.execute("DELETE FROM passages_fts WHERE audio_id = ?", (audio_id,))
        c.execute("DELETE FROM audio_files WHERE id = ?", (audio_id,))
    storage_service.remove_audio_files(a["uid"], a["stored_name"])
    for cl in clips:
        storage_service.clip_path(cl["file_name"]).unlink(missing_ok=True)
    return {"ok": True}


@router.get("/audio/{audio_id}/stream")
def stream_audio(audio_id: int):
    a = _get_audio(audio_id)
    path = storage_service.audio_path(a["stored_name"])
    if not path.exists():
        raise KeyError("Le fichier audio est introuvable sur le disque.")
    mime = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac",
            "flac": "audio/flac", "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg",
            "webm": "audio/webm"}.get(a["ext"], "application/octet-stream")
    return FileResponse(path, media_type=mime)  # gère les requêtes Range (navigation dans l'audio)


@router.get("/audio/{audio_id}/peaks")
def peaks(audio_id: int):
    a = _get_audio(audio_id)
    p = storage_service.peaks_path(a["uid"])
    if not p.exists():
        return JSONResponse({"ready": False}, status_code=202)
    return FileResponse(p, media_type="application/json")


class ProcessBody(BaseModel):
    language: str = ""
    profile: str = ""
    retranscribe: bool = False
    force: bool = False


@router.post("/audio/{audio_id}/process")
def process(audio_id: int, body: ProcessBody | None = None):
    _get_audio(audio_id)
    body = body or ProcessBody()
    params = {"language": body.language.strip().lower()[:5], "retranscribe": body.retranscribe, "force": body.force,
              "profile": body.profile if body.profile in whisper_service.PROFILES else None}
    if body.language:
        db.update("audio_files", audio_id, {"language": params["language"]})
    return {"job_id": manager.create("process", audio_id, params)}


class RegenerateBody(BaseModel):
    force: bool = True


@router.post("/audio/{audio_id}/regenerate")
def regenerate(audio_id: int, body: RegenerateBody | None = None):
    """Relance l'analyse IA (bouton « Régénérer »). La transcription n'est pas refaite."""
    a = _get_audio(audio_id)
    tr = transcription_service.current_transcription(audio_id)
    if not tr or tr["status"] != "completed":
        raise ValueError("La transcription doit être terminée avant l'analyse.")
    return {"job_id": manager.create("analyze", a["id"], {"force": (body or RegenerateBody()).force})}


# --------------------------------------------------------------------------- transcription

@router.get("/audio/{audio_id}/transcription")
def get_transcription(audio_id: int):
    _get_audio(audio_id)
    tr = transcription_service.current_transcription(audio_id)
    versions = db.all("SELECT id, version, model, language, status, is_current, word_count, created_at "
                      "FROM transcriptions WHERE audio_id = ? ORDER BY version DESC", (audio_id,))
    chunks = []
    if tr:
        chunks = db.all("SELECT idx, start, end, status FROM transcription_chunks WHERE transcription_id = ? "
                        "ORDER BY idx", (tr["id"],))
    speakers = db.all("SELECT * FROM speakers WHERE audio_id = ?", (audio_id,))
    return {"transcription": tr, "segments": transcription_service.segments(audio_id), "versions": versions,
            "chunks": chunks, "speakers": speakers}


class SegmentPatch(BaseModel):
    text: str | None = None
    speaker_id: int | None = None


@router.patch("/segments/{segment_id}")
def patch_segment(segment_id: int, body: SegmentPatch):
    if body.text is not None:
        if not body.text.strip():
            raise ValueError("Le texte d'un segment ne peut pas être vide.")
        transcription_service.edit_segment(segment_id, body.text)
    if body.speaker_id is not None:
        db.execute("UPDATE transcription_segments SET speaker_id = ? WHERE id = ?", (body.speaker_id or None, segment_id))
    s = db.one("SELECT id, start, end, COALESCE(text_edited, text) AS text, text AS original, "
               "text_edited IS NOT NULL AS edited FROM transcription_segments WHERE id = ?", (segment_id,))
    if not s:
        raise KeyError("Segment introuvable")
    return s


@router.get("/segments/{segment_id}/history")
def segment_history(segment_id: int):
    return db.all("SELECT * FROM segment_edits WHERE segment_id = ? ORDER BY id DESC", (segment_id,))


class ReplaceBody(BaseModel):
    find: str
    replace: str
    case_sensitive: bool = False


@router.post("/audio/{audio_id}/transcription/replace")
def replace_in_transcription(audio_id: int, body: ReplaceBody):
    _get_audio(audio_id)
    n = transcription_service.replace_all(audio_id, body.find, body.replace, body.case_sensitive)
    return {"updated": n}


# --------------------------------------------------------------------------- tags

@router.get("/tags")
def list_tags():
    return db.all("SELECT t.*, (SELECT COUNT(*) FROM audio_tags a WHERE a.tag_id = t.id) AS count "
                  "FROM tags t ORDER BY name COLLATE NOCASE")


class TagBody(BaseModel):
    name: str
    color: str = "#B1ADA1"


@router.post("/tags")
def create_tag(body: TagBody):
    name = body.name.strip()[:40]
    if not name:
        raise ValueError("Nom de tag vide.")
    db.execute("INSERT OR IGNORE INTO tags(name, color) VALUES (?, ?)", (name, body.color[:9]))
    return db.one("SELECT * FROM tags WHERE name = ?", (name,))


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int):
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    return {"ok": True}


# --------------------------------------------------------------------------- tableau de bord

@router.get("/dashboard")
def dashboard():
    s = lambda sql, p=(): db.scalar(sql, p) or 0  # noqa: E731
    stats = {
        "audios": s("SELECT COUNT(*) FROM audio_files WHERE archived = 0"),
        "duration": s("SELECT COALESCE(SUM(duration), 0) FROM audio_files WHERE status IN ('transcribed', 'analyzed')"),
        "analyses": s("SELECT COUNT(*) FROM audio_files WHERE status = 'analyzed'"),
        "chapters": s("SELECT COUNT(*) FROM chapters"),
        "key_moments": s("SELECT COUNT(*) FROM highlights WHERE importance >= 0.8"),
        "actions": s("SELECT COUNT(*) FROM actions"),
        "actions_open": s("SELECT COUNT(*) FROM actions WHERE status != 'done'"),
        "decisions": s("SELECT COUNT(*) FROM decisions"),
        "questions": s("SELECT COUNT(*) FROM questions WHERE resolved = 0"),
        "processing": s(f"SELECT COUNT(*) FROM jobs WHERE status IN ('QUEUED', {','.join('?' * len(manager.ACTIVE))})",
                        manager.ACTIVE),
    }
    recent = db.all(f"SELECT a.*, {COUNTS_SQL} FROM audio_files a WHERE a.archived = 0 AND a.last_opened_at IS NOT NULL "
                    "ORDER BY a.last_opened_at DESC LIMIT 6")
    if len(recent) < 3:
        ids = [r["id"] for r in recent] or [0]
        recent += db.all(f"SELECT a.*, {COUNTS_SQL} FROM audio_files a WHERE a.archived = 0 AND a.id NOT IN "
                         f"({','.join('?' * len(ids))}) ORDER BY a.created_at DESC LIMIT ?", [*ids, 6 - len(recent)])
    open_actions = db.all("SELECT x.*, a.title AS audio_title FROM actions x JOIN audio_files a ON a.id = x.audio_id "
                          "WHERE x.status != 'done' AND a.archived = 0 ORDER BY x.created_at DESC LIMIT 6")
    key_moments = db.all("SELECT h.*, a.title AS audio_title FROM highlights h JOIN audio_files a ON a.id = h.audio_id "
                         "WHERE a.archived = 0 ORDER BY h.importance DESC, h.created_at DESC LIMIT 5")
    return {"stats": stats, "recent": recent, "activity": manager.list_jobs(limit=8), "open_actions": open_actions,
            "key_moments": key_moments}
