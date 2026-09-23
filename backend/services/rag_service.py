"""RAGService — chat avec un ou plusieurs audios, réponses sourcées et horodatées.

Question → recherche (sémantique + plein texte) → passages pertinents → contexte compact → Qwen → réponse + sources.
La transcription complète n'est jamais envoyée au modèle.
"""
from __future__ import annotations

import re
from typing import Iterator

from backend import db, settings
from backend.services import analysis_store, ollama_service, prompt_service, search_service
from backend.services.util import fmt_time

_INTENTS = {
    "decisions": ("décid", "decid", "décision", "tranch", "valid", "acté"),
    "actions": ("action", "faire", "tâche", "tache", "qui doit", "prochaine", "étape", "responsable", "todo"),
    "questions": ("question", "ouvert", "en suspens", "non résolu", "reste à"),
    "risks": ("risque", "problème", "probleme", "danger", "bloqu", "difficult", "inquiét"),
}


def _audios(audio_ids: list[int]) -> list[dict]:
    if not audio_ids:
        return []
    rows = db.all(f"SELECT * FROM audio_files WHERE id IN ({','.join('?' for _ in audio_ids)})", audio_ids)
    return sorted(rows, key=lambda a: (a.get("recorded_at") or a["created_at"]))


def build_context(question: str, audio_ids: list[int]) -> tuple[str, list[dict]]:
    audios = _audios(audio_ids)
    budget = int(settings.get("ollama.num_ctx") * 2.6)  # ~caractères disponibles pour le contexte
    sources: list[dict] = []
    parts: list[str] = []
    q = question.lower()
    wanted = [k for k, kws in _INTENTS.items() if any(w in q for w in kws)]

    def add_source(audio: dict, start: float, end: float | None, text: str, kind: str) -> str:
        label = f"S{len(sources) + 1}"
        sources.append({"label": label, "audio_id": audio["id"], "audio_title": audio["title"], "start": start,
                        "end": end, "text": text[:400], "kind": kind})
        return label

    by_id = {a["id"]: a for a in audios}
    for n, a in enumerate(audios, 1):
        header = f"## Enregistrement {n} : « {a['title']} » ({fmt_time(a['duration'])})"
        if a.get("recorded_at"):
            header += f" — {a['recorded_at']}"
        block = [header]
        summ = analysis_store.current(a["id"], "summary")
        if summ:
            c = summ["content"]
            if c.get("tldr"):
                block.append(f"TL;DR : {c['tldr']}")
            if c.get("short"):
                block.append(f"Résumé : {c['short']}")
        chapters = db.all("SELECT title, start FROM chapters WHERE audio_id = ? ORDER BY start", (a["id"],))
        if chapters:
            block.append("Chapitres : " + " ; ".join(f"{fmt_time(c['start'])} {c['title']}" for c in chapters))
        for kind in wanted:
            table = {"decisions": "decisions", "actions": "actions", "questions": "questions", "risks": "risks"}[kind]
            rows = db.all(f"SELECT * FROM {table} WHERE audio_id = ? ORDER BY time LIMIT 25", (a["id"],))
            if rows:
                block.append({"decisions": "Décisions relevées :", "actions": "Actions relevées :",
                              "questions": "Questions ouvertes relevées :", "risks": "Risques relevés :"}[kind])
                for r in rows:
                    extra = ""
                    if kind == "actions":
                        extra = f" (responsable : {r['owner'] or '?'}, échéance : {r['deadline'] or '?'}, statut : {r['status']})"
                    if kind == "risks":
                        extra = " (interprétation IA)" if r["kind"] == "inference" else " (mentionné)"
                    label = add_source(a, r["time"] or 0, None, r["text"], kind)
                    block.append(f"- [{label}] {fmt_time(r['time'])} {r['text']}{extra}")
        parts.append("\n".join(block))

    passages = search_service.hybrid_passages(question, audio_ids, limit=8 if len(audios) == 1 else 12)
    if not passages:
        # question générale : on prend le début de chaque chapitre comme échantillon représentatif
        for a in audios:
            for c in db.all("SELECT start FROM chapters WHERE audio_id = ? ORDER BY importance DESC, start LIMIT 4",
                            (a["id"],)):
                p = db.one("SELECT p.*, ? AS audio_title FROM passages p WHERE audio_id = ? AND start >= ? "
                           "ORDER BY start LIMIT 1", (a["title"], a["id"], c["start"]))
                if p:
                    passages.append(p)
    passages.sort(key=lambda p: (p["audio_id"], p["start"]))
    excerpt_lines = ["## Extraits de transcription"]
    used = sum(len(p) for p in parts)
    for p in passages:
        a = by_id.get(p["audio_id"])
        if not a:
            continue
        line_len = len(p["text"]) + 60
        if used + line_len > budget:
            break
        label = add_source(a, p["start"], p["end"], p["text"], "passage")
        excerpt_lines.append(f"[{label}] {a['title']} — {fmt_time(p['start'])} : {p['text']}")
        used += line_len
    parts.append("\n".join(excerpt_lines))
    return "\n\n".join(parts), sources


def answer_stream(question: str, audio_ids: list[int], history: list[dict] | None = None) -> Iterator[dict]:
    """Événements : {"type": "sources"}, {"type": "token"}, {"type": "done"}."""
    context, sources = build_context(question, audio_ids)
    lang = "français"
    audios = _audios(audio_ids)
    if audios:
        lang = prompt_service.language_name(audios[0].get("language"))
    prompt = prompt_service.load("chat")
    messages = prompt.render(language=lang, context=context, question=question)
    if history:
        # historique court : les 4 derniers échanges, sans leurs sources
        messages = messages[:1] + [{"role": m["role"], "content": m["content"][:1500]} for m in history[-8:]] + messages[1:]
    yield {"type": "sources", "sources": sources}
    parts = []
    for tok in ollama_service.chat_stream(messages, max_tokens=1200):
        parts.append(tok)
        yield {"type": "token", "text": tok}
    text = "".join(parts).strip()
    cited = sorted(set(re.findall(r"\[(S\d+)\]", text)), key=lambda s: int(s[1:]))
    yield {"type": "done", "text": text, "cited": cited}
