"""API — chat avec un ou plusieurs audios (réponses streamées, sources horodatées)."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend import db
from backend.services import ollama_service, rag_service

router = APIRouter()
log = logging.getLogger("api.chat")


class ChatBody(BaseModel):
    question: str
    audio_ids: list[int] = []
    session_id: int | None = None


def _session(body: ChatBody) -> dict:
    if body.session_id:
        s = db.one("SELECT * FROM chat_sessions WHERE id = ?", (body.session_id,))
        if s:
            return s
    ids = sorted(set(body.audio_ids))
    title = body.question.strip()[:80]
    sid = db.insert("chat_sessions", {"title": title or "Nouvelle conversation", "audio_ids": db.jdumps(ids)})
    return db.one("SELECT * FROM chat_sessions WHERE id = ?", (sid,))


def _stream(body: ChatBody):
    question = body.question.strip()[:2000]
    if not question:
        yield json.dumps({"type": "error", "error": "Posez une question."}) + "\n"
        return
    session = _session(body)
    audio_ids = body.audio_ids or db.jloads(session["audio_ids"], [])
    if not audio_ids:
        yield json.dumps({"type": "error", "error": "Sélectionnez au moins un audio."}) + "\n"
        return
    history = db.all("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id", (session["id"],))
    db.insert("chat_messages", {"session_id": session["id"], "role": "user", "content": question})
    yield json.dumps({"type": "session", "session_id": session["id"]}) + "\n"
    sources = []
    try:
        for ev in rag_service.answer_stream(question, audio_ids, history):
            if ev["type"] == "sources":
                sources = ev["sources"]
            if ev["type"] == "done":
                cited = set(ev["cited"])
                kept = [s for s in sources if s["label"] in cited] or []
                db.insert("chat_messages", {"session_id": session["id"], "role": "assistant", "content": ev["text"],
                                            "sources": db.jdumps(kept)})
                db.execute("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?", (session["id"],))
                ev = {**ev, "sources": kept}
            yield json.dumps(ev, ensure_ascii=False) + "\n"
    except ollama_service.OllamaError as exc:
        yield json.dumps({"type": "error", "error": str(exc)}, ensure_ascii=False) + "\n"
    except Exception as exc:
        log.error("Chat en échec : %s", exc)
        yield json.dumps({"type": "error", "error": "La réponse n'a pas pu être générée.", "detail": str(exc)},
                         ensure_ascii=False) + "\n"


@router.post("/chat")
def chat(body: ChatBody):
    return StreamingResponse(_stream(body), media_type="application/x-ndjson")


@router.post("/audio/{audio_id}/chat")
def chat_audio(audio_id: int, body: ChatBody):
    body.audio_ids = [audio_id]
    return StreamingResponse(_stream(body), media_type="application/x-ndjson")


@router.get("/chat/sessions")
def sessions(audio_id: int | None = None):
    rows = db.all("SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS messages "
                  "FROM chat_sessions s ORDER BY updated_at DESC LIMIT 100")
    for r in rows:
        r["audio_ids"] = db.jloads(r["audio_ids"], [])
    if audio_id:
        rows = [r for r in rows if r["audio_ids"] == [audio_id]]
    return rows


@router.get("/chat/sessions/{sid}")
def session_messages(sid: int):
    s = db.one("SELECT * FROM chat_sessions WHERE id = ?", (sid,))
    if not s:
        raise KeyError("Conversation introuvable")
    s["audio_ids"] = db.jloads(s["audio_ids"], [])
    msgs = db.all("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id", (sid,))
    for m in msgs:
        m["sources"] = db.jloads(m["sources"], [])
    return {"session": s, "messages": msgs}


@router.delete("/chat/sessions/{sid}")
def delete_session(sid: int):
    db.execute("DELETE FROM chat_sessions WHERE id = ?", (sid,))
    return {"ok": True}
