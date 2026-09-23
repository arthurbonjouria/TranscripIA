"""API — chapitres, synthèse, highlights, insights, actions, décisions, questions, risques, personnes, sujets."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from backend import db
from backend.jobs import manager
from backend.services import analysis_service, analysis_store, export_service, transcription_service

router = APIRouter()


def _audio(audio_id: int) -> dict:
    a = db.one("SELECT * FROM audio_files WHERE id = ?", (audio_id,))
    if not a:
        raise KeyError("Cet audio n'existe pas.")
    return a


def _chapters(audio_id: int) -> list[dict]:
    rows = db.all("SELECT * FROM chapters WHERE audio_id = ? ORDER BY start", (audio_id,))
    for r in rows:
        r["topics"] = db.jloads(r["topics"], [])
    return rows


def _renormalize(audio_id: int) -> None:
    """Après une modification manuelle : chaque chapitre se termine au début du suivant."""
    audio = _audio(audio_id)
    rows = db.all("SELECT id, start FROM chapters WHERE audio_id = ? ORDER BY start", (audio_id,))
    with db.transaction() as c:
        for i, r in enumerate(rows):
            end = rows[i + 1]["start"] if i + 1 < len(rows) else audio["duration"]
            c.execute("UPDATE chapters SET end = ? WHERE id = ?", (end, r["id"]))


def _snapshot_chapters(audio_id: int) -> None:
    """Chaque modification manuelle est historisée : on peut toujours revenir en arrière."""
    audio = _audio(audio_id)
    analysis_store.save(audio_id, "chapters", {"chapters": _chapters(audio_id)}, source="user",
                        transcript_rev=audio["transcript_rev"])


# --------------------------------------------------------------------------- chapitres

@router.get("/audio/{audio_id}/chapters")
def list_chapters(audio_id: int):
    _audio(audio_id)
    proposal = analysis_store.current(audio_id, "chapters_proposal")
    return {"chapters": _chapters(audio_id),
            "proposal": proposal["content"] if proposal and not proposal["content"].get("applied") else None,
            "history": analysis_store.history(audio_id, "chapters")}


class ChapterBody(BaseModel):
    title: str = "Nouveau chapitre"
    start: float = 0
    summary: str = ""


@router.post("/audio/{audio_id}/chapters")
def create_chapter(audio_id: int, body: ChapterBody):
    a = _audio(audio_id)
    start = max(0.0, min(body.start, a["duration"]))
    if db.one("SELECT id FROM chapters WHERE audio_id = ? AND ABS(start - ?) < 1", (audio_id, start)):
        raise ValueError("Un chapitre commence déjà à cet instant.")
    db.insert("chapters", {"audio_id": audio_id, "title": body.title.strip()[:140] or "Nouveau chapitre",
                           "start": start, "end": start, "summary": body.summary, "source": "user"})
    _renormalize(audio_id)
    _snapshot_chapters(audio_id)
    return list_chapters(audio_id)


class ChapterPatch(BaseModel):
    title: str | None = None
    start: float | None = None
    summary: str | None = None
    importance: float | None = None


@router.patch("/chapters/{chapter_id}")
def patch_chapter(chapter_id: int, body: ChapterPatch):
    ch = db.one("SELECT * FROM chapters WHERE id = ?", (chapter_id,))
    if not ch:
        raise KeyError("Chapitre introuvable")
    data = body.model_dump(exclude_none=True)
    if "title" in data:
        data["title"] = data["title"].strip()[:140]
        if not data["title"]:
            raise ValueError("Le titre ne peut pas être vide.")
    if "start" in data:
        a = _audio(ch["audio_id"])
        data["start"] = max(0.0, min(float(data["start"]), a["duration"] - 1))
    data["source"] = "user"
    data["updated_at"] = db.scalar("SELECT datetime('now')")
    db.update("chapters", chapter_id, data)
    _renormalize(ch["audio_id"])
    _snapshot_chapters(ch["audio_id"])
    return list_chapters(ch["audio_id"])


@router.delete("/chapters/{chapter_id}")
def delete_chapter(chapter_id: int):
    ch = db.one("SELECT * FROM chapters WHERE id = ?", (chapter_id,))
    if not ch:
        raise KeyError("Chapitre introuvable")
    db.execute("DELETE FROM chapters WHERE id = ?", (chapter_id,))
    first = db.one("SELECT id FROM chapters WHERE audio_id = ? ORDER BY start LIMIT 1", (ch["audio_id"],))
    if first:
        db.execute("UPDATE chapters SET start = 0 WHERE id = ? AND start > 0 AND ? = 0", (first["id"], ch["start"]))
    _renormalize(ch["audio_id"])
    _snapshot_chapters(ch["audio_id"])
    return list_chapters(ch["audio_id"])


class MergeBody(BaseModel):
    ids: list[int]


@router.post("/audio/{audio_id}/chapters/merge")
def merge_chapters(audio_id: int, body: MergeBody):
    rows = [r for r in _chapters(audio_id) if r["id"] in body.ids]
    if len(rows) < 2:
        raise ValueError("Sélectionnez au moins deux chapitres à fusionner.")
    keep = rows[0]
    summary = " ".join(r["summary"] for r in rows if r["summary"]).strip()
    topics = list(dict.fromkeys(t for r in rows for t in r["topics"]))
    with db.transaction() as c:
        c.execute("UPDATE chapters SET summary = ?, topics = ?, source = 'user', importance = ? WHERE id = ?",
                  (summary, db.jdumps(topics), max(r["importance"] for r in rows), keep["id"]))
        for r in rows[1:]:
            c.execute("DELETE FROM chapters WHERE id = ?", (r["id"],))
    _renormalize(audio_id)
    _snapshot_chapters(audio_id)
    return list_chapters(audio_id)


class SplitBody(BaseModel):
    time: float
    title: str = ""


@router.post("/chapters/{chapter_id}/split")
def split_chapter(chapter_id: int, body: SplitBody):
    ch = db.one("SELECT * FROM chapters WHERE id = ?", (chapter_id,))
    if not ch:
        raise KeyError("Chapitre introuvable")
    if not (ch["start"] + 1 < body.time < ch["end"] - 1):
        raise ValueError("Placez la tête de lecture à l'intérieur du chapitre pour le diviser.")
    db.insert("chapters", {"audio_id": ch["audio_id"], "title": body.title.strip() or f"{ch['title']} (suite)",
                           "start": body.time, "end": ch["end"], "source": "user", "topics": ch["topics"]})
    _renormalize(ch["audio_id"])
    _snapshot_chapters(ch["audio_id"])
    return list_chapters(ch["audio_id"])


@router.post("/audio/{audio_id}/chapters/reorganize")
def reorganize(audio_id: int):
    _audio(audio_id)
    return {"job_id": manager.create("chapters_ai", audio_id)}


@router.post("/audio/{audio_id}/chapters/proposal/apply")
def apply_proposal(audio_id: int):
    p = analysis_store.current(audio_id, "chapters_proposal")
    if not p or not p["content"].get("chapters"):
        raise ValueError("Aucune proposition à appliquer.")
    analysis_service.replace_chapters(audio_id, p["content"]["chapters"], source="ai")
    _renormalize(audio_id)
    _snapshot_chapters(audio_id)
    analysis_store.save(audio_id, "chapters_proposal", {**p["content"], "applied": True}, replace_current=True)
    return list_chapters(audio_id)


@router.post("/audio/{audio_id}/chapters/proposal/dismiss")
def dismiss_proposal(audio_id: int):
    p = analysis_store.current(audio_id, "chapters_proposal")
    if p:
        analysis_store.save(audio_id, "chapters_proposal", {**p["content"], "applied": True}, replace_current=True)
    return list_chapters(audio_id)


@router.post("/audio/{audio_id}/chapters/restore/{analysis_id}")
def restore_chapters(audio_id: int, analysis_id: int):
    row = analysis_store.get(analysis_id)
    if not row or row["audio_id"] != audio_id or row["kind"] != "chapters":
        raise KeyError("Version introuvable")
    analysis_service.replace_chapters(audio_id, row["content"].get("chapters", []), source=row["source"])
    _snapshot_chapters(audio_id)
    return list_chapters(audio_id)


# --------------------------------------------------------------------------- synthèse

@router.get("/audio/{audio_id}/summary")
def get_summary(audio_id: int):
    a = _audio(audio_id)
    cur = analysis_store.current(audio_id, "summary")
    extras = {k: (analysis_store.current(audio_id, k) or {}).get("content", {}).get("markdown")
              for k in analysis_service.EXTRA_SUMMARIES}
    return {
        "summary": cur["content"] if cur else None,
        "meta": {k: cur[k] for k in ("id", "version", "model", "source", "created_at", "duration_sec")} if cur else None,
        "stale": bool(cur and cur["transcript_rev"] != a["transcript_rev"]),
        "history": analysis_store.history(audio_id, "summary"),
        "extras": extras,
        "briefing": (analysis_store.current(audio_id, "briefing") or {}).get("content"),
        "decisions": db.all("SELECT * FROM decisions WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "actions": db.all("SELECT * FROM actions WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "questions": db.all("SELECT * FROM questions WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "risks": db.all("SELECT * FROM risks WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "people": db.all("SELECT id, name, role, mentions FROM people WHERE audio_id = ? ORDER BY mentions DESC",
                         (audio_id,)),
        "topics": db.all("SELECT id, name, occurrences, duration FROM topics WHERE audio_id = ? ORDER BY duration DESC",
                         (audio_id,)),
        "quotes": db.all("SELECT * FROM highlights WHERE audio_id = ? AND category = 'citation' "
                         "ORDER BY importance DESC LIMIT 8", (audio_id,)),
    }


class SummaryEdit(BaseModel):
    content: dict


@router.put("/audio/{audio_id}/summary")
def edit_summary(audio_id: int, body: SummaryEdit):
    """Modification manuelle de la fiche : nouvelle version (source = user), l'ancienne reste dans l'historique."""
    a = _audio(audio_id)
    allowed = {"title", "tldr", "short", "executive", "key_points", "problems", "figures", "dates", "participants"}
    cur = analysis_store.current(audio_id, "summary")
    content = dict(cur["content"]) if cur else {}
    for k, v in body.content.items():
        if k in allowed:
            content[k] = [str(x) for x in v if str(x).strip()] if isinstance(v, list) else str(v)
    analysis_store.save(audio_id, "summary", content, source="user", transcript_rev=a["transcript_rev"],
                        model=cur["model"] if cur else "")
    return get_summary(audio_id)


@router.post("/analyses/{analysis_id}/restore")
def restore_analysis(analysis_id: int):
    analysis_store.restore(analysis_id)
    return {"ok": True}


@router.get("/analyses/{analysis_id}")
def get_analysis(analysis_id: int):
    row = analysis_store.get(analysis_id)
    if not row:
        raise KeyError("Version introuvable")
    return row


@router.post("/audio/{audio_id}/summary/{kind}")
def generate_extra(audio_id: int, kind: str):
    _audio(audio_id)
    if kind not in analysis_service.EXTRA_SUMMARIES:
        raise ValueError("Type de résumé inconnu.")
    return {"job_id": manager.create("summary_extra", audio_id, {"kind": kind})}


@router.post("/audio/{audio_id}/briefing")
def generate_briefing(audio_id: int):
    _audio(audio_id)
    if not analysis_store.current(audio_id, "summary"):
        raise ValueError("Lancez d'abord l'analyse de l'audio.")
    return {"job_id": manager.create("briefing", audio_id)}


# --------------------------------------------------------------------------- highlights / insights

@router.get("/audio/{audio_id}/highlights")
def list_highlights(audio_id: int, category: str = "", min_importance: float = 0, source: str = "",
                    favorite: bool | None = None):
    _audio(audio_id)
    where, params = ["audio_id = ?", "importance >= ?"], [audio_id, min_importance]
    if category:
        where.append("category = ?")
        params.append(category)
    if source:
        where.append("source = ?")
        params.append(source)
    if favorite is not None:
        where.append("favorite = ?")
        params.append(1 if favorite else 0)
    return db.all(f"SELECT * FROM highlights WHERE {' AND '.join(where)} ORDER BY start", params)


class HighlightBody(BaseModel):
    audio_id: int
    start: float
    end: float
    text: str
    category: str = "Important"
    importance: float = 0.6
    note: str = ""
    favorite: bool = False
    segment_id: int | None = None


@router.post("/highlights")
def create_highlight(body: HighlightBody):
    _audio(body.audio_id)
    if not body.text.strip():
        raise ValueError("Sélectionnez un passage à surligner.")
    hid = db.insert("highlights", {
        "audio_id": body.audio_id, "start": body.start, "end": max(body.start, body.end), "text": body.text.strip()[:2000],
        "category": body.category.strip()[:40] or "Important", "importance": max(0.0, min(1.0, body.importance)),
        "note": body.note[:2000], "favorite": 1 if body.favorite else 0, "segment_id": body.segment_id, "source": "user",
    })
    return db.one("SELECT * FROM highlights WHERE id = ?", (hid,))


class HighlightPatch(BaseModel):
    category: str | None = None
    importance: float | None = None
    note: str | None = None
    favorite: bool | None = None
    text: str | None = None


@router.patch("/highlights/{hid}")
def patch_highlight(hid: int, body: HighlightPatch):
    data = body.model_dump(exclude_none=True)
    if "favorite" in data:
        data["favorite"] = 1 if data["favorite"] else 0
    db.update("highlights", hid, data)
    h = db.one("SELECT * FROM highlights WHERE id = ?", (hid,))
    if not h:
        raise KeyError("Highlight introuvable")
    return h


@router.delete("/highlights/{hid}")
def delete_highlight(hid: int):
    db.execute("DELETE FROM highlights WHERE id = ?", (hid,))
    return {"ok": True}


@router.get("/audio/{audio_id}/insights")
def insights(audio_id: int):
    _audio(audio_id)
    summ = analysis_store.current(audio_id, "summary")
    hl = db.all("SELECT * FROM highlights WHERE audio_id = ? ORDER BY importance DESC, start", (audio_id,))
    people = db.all("SELECT * FROM people WHERE audio_id = ? ORDER BY mentions DESC", (audio_id,))
    for p in people:
        for k in ("topics", "times", "quotes"):
            p[k] = db.jloads(p[k], [])
    topics = db.all("SELECT * FROM topics WHERE audio_id = ? ORDER BY duration DESC", (audio_id,))
    for t in topics:
        t["chapter_ids"] = db.jloads(t["chapter_ids"], [])
        t["times"] = db.jloads(t["times"], [])
    entities = db.all("SELECT * FROM entities WHERE audio_id = ? ORDER BY type, count DESC", (audio_id,))
    for e in entities:
        e["times"] = db.jloads(e["times"], [])
    return {
        "summary": summ["content"] if summ else None,
        "key_moments": [h for h in hl if h["importance"] >= 0.7][:20],
        "highlights": hl,
        "ideas": [h for h in hl if h["category"] in ("idée", "opportunité")],
        "decisions": db.all("SELECT * FROM decisions WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "actions": db.all("SELECT * FROM actions WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "questions": db.all("SELECT * FROM questions WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "risks": db.all("SELECT * FROM risks WHERE audio_id = ? ORDER BY time", (audio_id,)),
        "people": people, "topics": topics, "entities": entities,
        "stats": export_service.stats(audio_id),
    }


@router.get("/audio/{audio_id}/stats")
def audio_stats(audio_id: int):
    _audio(audio_id)
    return export_service.stats(audio_id)


# --------------------------------------------------------------------------- actions, décisions, questions, risques

ITEM_TABLES = {
    "actions": {"text", "owner", "deadline", "context", "time", "status"},
    "decisions": {"text", "context", "time"},
    "questions": {"text", "time", "resolved"},
    "risks": {"text", "kind", "severity", "time"},
}


class ItemBody(BaseModel):
    audio_id: int | None = None
    text: str | None = None
    owner: str | None = None
    deadline: str | None = None
    context: str | None = None
    time: float | None = None
    status: str | None = None
    resolved: bool | None = None
    kind: str | None = None
    severity: str | None = None


def _clean_item(kind: str, data: dict) -> dict:
    allowed = ITEM_TABLES[kind]
    out = {k: v for k, v in data.items() if k in allowed and v is not None}
    if "status" in out and out["status"] not in ("todo", "doing", "done"):
        raise ValueError("Statut invalide.")
    if "kind" in out and out["kind"] not in ("fact", "inference"):
        raise ValueError("Type de risque invalide.")
    if "resolved" in out:
        out["resolved"] = 1 if out["resolved"] else 0
    if "text" in out:
        out["text"] = str(out["text"]).strip()[:1000]
        if not out["text"]:
            raise ValueError("Le texte ne peut pas être vide.")
    return out


@router.get("/items/{kind}")
def list_items(kind: str, audio_id: int | None = None, status: str = ""):
    if kind not in ITEM_TABLES:
        raise KeyError("Type inconnu")
    where, params = ["a.archived = 0"], []
    if audio_id:
        where.append("x.audio_id = ?")
        params.append(audio_id)
    if status and kind == "actions":
        where.append("x.status = ?")
        params.append(status)
    return db.all(f"SELECT x.*, a.title AS audio_title FROM {kind} x JOIN audio_files a ON a.id = x.audio_id "
                  f"WHERE {' AND '.join(where)} ORDER BY a.created_at DESC, x.time", params)


@router.post("/items/{kind}")
def create_item(kind: str, body: ItemBody):
    if kind not in ITEM_TABLES:
        raise KeyError("Type inconnu")
    if not body.audio_id:
        raise ValueError("audio_id requis")
    _audio(body.audio_id)
    data = _clean_item(kind, body.model_dump())
    if "text" not in data:
        raise ValueError("Le texte est requis.")
    data.update(audio_id=body.audio_id, source="user")
    new_id = db.insert(kind, data)
    return db.one(f"SELECT * FROM {kind} WHERE id = ?", (new_id,))


@router.patch("/items/{kind}/{item_id}")
def patch_item(kind: str, item_id: int, body: ItemBody):
    if kind not in ITEM_TABLES:
        raise KeyError("Type inconnu")
    data = _clean_item(kind, body.model_dump())
    if kind == "actions":
        data["updated_at"] = db.scalar("SELECT datetime('now')")
    db.update(kind, item_id, data)
    row = db.one(f"SELECT * FROM {kind} WHERE id = ?", (item_id,))
    if not row:
        raise KeyError("Élément introuvable")
    return row


@router.delete("/items/{kind}/{item_id}")
def delete_item(kind: str, item_id: int):
    if kind not in ITEM_TABLES:
        raise KeyError("Type inconnu")
    db.execute(f"DELETE FROM {kind} WHERE id = ?", (item_id,))
    return {"ok": True}


# --------------------------------------------------------------------------- personnes / speakers

class PersonPatch(BaseModel):
    name: str | None = None
    role: str | None = None


@router.patch("/people/{person_id}")
def patch_person(person_id: int, body: PersonPatch):
    data = {k: v.strip()[:120] for k, v in body.model_dump(exclude_none=True).items()}
    data["source"] = "user"
    db.update("people", person_id, data)
    return db.one("SELECT * FROM people WHERE id = ?", (person_id,))


class SpeakerPatch(BaseModel):
    name: str


@router.patch("/speakers/{speaker_id}")
def patch_speaker(speaker_id: int, body: SpeakerPatch):
    db.update("speakers", speaker_id, {"name": body.name.strip()[:80]})
    return db.one("SELECT * FROM speakers WHERE id = ?", (speaker_id,))


@router.get("/audio/{audio_id}/context")
def segment_context(audio_id: int, time: float, radius: float = 20):
    """Transcription autour d'un instant (utilisé par les sources du chat et les moments clés)."""
    segs = [s for s in transcription_service.segments(audio_id)
            if s["end"] >= time - radius and s["start"] <= time + radius]
    return segs
