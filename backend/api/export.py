"""API — exports : rapport complet, chapitre, extrait."""
from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from backend import db
from backend.services import export_service

router = APIRouter()

ALL_SECTIONS = {"summary", "extra", "briefing", "chapters", "highlights", "decisions", "actions", "questions", "risks",
                "people", "topics", "segments", "summary_versions"}


def _download(body: bytes, name: str, mime: str) -> Response:
    return Response(body, media_type=mime,
                    headers={"Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}"})


@router.get("/audio/{audio_id}/export")
def export_get(audio_id: int, fmt: str = "pdf", transcript: bool = True, sections: str = ""):
    wanted = {s for s in sections.split(",") if s in ALL_SECTIONS} or None
    if wanted is not None and transcript:
        wanted.add("segments")
    return _download(*export_service.export_report(audio_id, fmt, wanted, transcript))


class ExportBody(BaseModel):
    format: str = "pdf"
    include_transcript: bool = True
    sections: list[str] = []


@router.post("/audio/{audio_id}/export")
def export_post(audio_id: int, body: ExportBody):
    wanted = {s for s in body.sections if s in ALL_SECTIONS} or None
    return _download(*export_service.export_report(audio_id, body.format, wanted, body.include_transcript))


@router.get("/audio/{audio_id}/export/range")
def export_range(audio_id: int, start: float, end: float, fmt: str = "mp3", title: str = ""):
    if end <= start:
        raise ValueError("Intervalle invalide.")
    return _download(*export_service.export_range(audio_id, start, end, fmt, title[:120]))


@router.get("/chapters/{chapter_id}/export")
def export_chapter(chapter_id: int, fmt: str = "mp3"):
    ch = db.one("SELECT * FROM chapters WHERE id = ?", (chapter_id,))
    if not ch:
        raise KeyError("Chapitre introuvable")
    return _download(*export_service.export_range(ch["audio_id"], ch["start"], ch["end"], fmt, ch["title"]))
