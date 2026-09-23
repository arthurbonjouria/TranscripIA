"""Briefing d'un audio, briefing avant réunion (multi-audios) et comparaison de réunions."""
from __future__ import annotations

import time
from typing import Callable

from backend import db, settings
from backend.services import analysis_store, ollama_service, prompt_service
from backend.services.util import fmt_time

Stop = Callable[[], bool]


def _list(rows: list[dict], fmt) -> str:
    return "\n".join("- " + fmt(r) for r in rows) or "(aucun)"


def _meeting_digest(audio: dict, n: int) -> str:
    aid = audio["id"]
    summ = analysis_store.current(aid, "summary")
    tldr = summ["content"].get("tldr", "") if summ else ""
    short = summ["content"].get("short", "") if summ else ""
    date = audio.get("recorded_at") or audio["created_at"][:10]
    dec = db.all("SELECT text, time FROM decisions WHERE audio_id = ? ORDER BY time LIMIT 20", (aid,))
    act = db.all("SELECT text, owner, deadline, status FROM actions WHERE audio_id = ? ORDER BY time LIMIT 25", (aid,))
    que = db.all("SELECT text FROM questions WHERE audio_id = ? AND resolved = 0 LIMIT 15", (aid,))
    top = db.all("SELECT name FROM topics WHERE audio_id = ? ORDER BY duration DESC LIMIT 10", (aid,))
    return "\n".join([
        f"### Réunion {n} — « {audio['title']} » ({date}, {fmt_time(audio['duration'])})",
        f"Synthèse : {tldr} {short}".strip(),
        "Sujets : " + (", ".join(t["name"] for t in top) or "(non déterminés)"),
        "Décisions :\n" + _list(dec, lambda r: r["text"]),
        "Actions :\n" + _list(act, lambda r: f"{r['text']} (resp. {r['owner'] or '?'}, éch. {r['deadline'] or '?'}, statut {r['status']})"),
        "Questions ouvertes :\n" + _list(que, lambda r: r["text"]),
    ])


def _ordered(audio_ids: list[int]) -> list[dict]:
    rows = db.all(f"SELECT * FROM audio_files WHERE id IN ({','.join('?' for _ in audio_ids)})", audio_ids)
    return sorted(rows, key=lambda a: (a.get("recorded_at") or a["created_at"]))


def briefing(audio: dict, should_stop: Stop) -> dict:
    aid = audio["id"]
    summ = analysis_store.current(aid, "summary")
    prompt = prompt_service.load("briefing")
    started = time.time()
    raw = ollama_service.chat_json(prompt.render(
        language=prompt_service.language_name(audio.get("language")), title=audio["title"],
        duration=fmt_time(audio["duration"]),
        summary=(summ["content"].get("executive") or summ["content"].get("short", "")) if summ else "(pas de synthèse)",
        decisions=_list(db.all("SELECT text FROM decisions WHERE audio_id = ?", (aid,)), lambda r: r["text"]),
        actions=_list(db.all("SELECT text, owner, deadline FROM actions WHERE audio_id = ?", (aid,)),
                      lambda r: f"{r['text']} ({r['owner'] or '?'}, {r['deadline'] or '?'})"),
        questions=_list(db.all("SELECT text FROM questions WHERE audio_id = ?", (aid,)), lambda r: r["text"]),
        risks=_list(db.all("SELECT text, kind FROM risks WHERE audio_id = ?", (aid,)),
                    lambda r: r["text"] + (" (interprétation)" if r["kind"] == "inference" else "")),
    ), should_stop=should_stop, max_tokens=1500)
    raw = raw if isinstance(raw, dict) else {}
    content = {k: [str(x) for x in (raw.get(k) or []) if x][:12]
               for k in ("remember", "decided", "todo", "unresolved", "sensitive")}
    analysis_store.save(aid, "briefing", content, model=settings.get("ollama.model"), prompt_version=prompt.version,
                        transcript_rev=audio["transcript_rev"], duration_sec=round(time.time() - started, 1))
    return content


def _multi(kind: str, audio_ids: list[int], keys: list[str], should_stop: Stop, extra_str: str = "") -> dict:
    audios = _ordered(audio_ids)
    if len(audios) < (2 if kind == "comparison" else 1):
        raise ValueError("Sélectionnez au moins deux audios." if kind == "comparison" else "Sélectionnez un audio.")
    prompt = prompt_service.load(kind)
    meetings = "\n\n".join(_meeting_digest(a, i + 1) for i, a in enumerate(audios))
    started = time.time()
    raw = ollama_service.chat_json(prompt.render(
        language=prompt_service.language_name(audios[0].get("language")), meetings=meetings),
        should_stop=should_stop, max_tokens=2000, num_ctx=max(8192, settings.get("ollama.num_ctx")))
    raw = raw if isinstance(raw, dict) else {}
    content = {k: [str(x) for x in (raw.get(k) or []) if x][:20] for k in keys}
    if extra_str:
        content[extra_str] = str(raw.get(extra_str, ""))
    content["audios"] = [{"id": a["id"], "title": a["title"], "date": a.get("recorded_at") or a["created_at"][:10]}
                         for a in audios]
    scope = ",".join(str(a["id"]) for a in audios)
    analysis_store.save(None, kind, content, model=settings.get("ollama.model"), prompt_version=prompt.version,
                        scope=scope, duration_sec=round(time.time() - started, 1))
    return content


def prep_briefing(audio_ids: list[int], should_stop: Stop) -> dict:
    return _multi("prep_briefing", audio_ids, ["previous_decisions", "pending_actions", "open_questions",
                                               "evolutions", "recurring_topics", "agenda"], should_stop)


def comparison(audio_ids: list[int], should_stop: Stop) -> dict:
    return _multi("comparison", audio_ids, ["new_topics", "changed_decisions", "completed_actions", "open_actions",
                                            "evolutions", "contradictions"], should_stop, extra_str="overview")
