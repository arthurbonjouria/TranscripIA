"""SearchService (plein texte FTS5) et EmbeddingService (recherche sémantique locale).

Choix V1 : les vecteurs sont stockés dans SQLite (BLOB float32) et comparés avec numpy.
C'est suffisant pour des dizaines de milliers de passages ; l'interface `semantic_search`
permet de brancher FAISS, Chroma ou Qdrant plus tard sans toucher au reste.
"""
from __future__ import annotations

import logging
from typing import Callable

import numpy as np

from backend import db, settings
from backend.services import ollama_service, transcription_service
from backend.services.util import fts_query

log = logging.getLogger("search")


# --------------------------------------------------------------------------- passages

def build_passages(audio_id: int, target_words: int = 140, max_seconds: float = 75) -> int:
    """Fenêtres de segments consécutifs (~1 min) — unité de recherche sémantique et de contexte RAG."""
    segs = transcription_service.segments(audio_id)
    passages, cur, words = [], [], 0
    for s in segs:
        cur.append(s)
        words += len(s["text"].split())
        if words >= target_words or (s["end"] - cur[0]["start"]) >= max_seconds:
            passages.append(cur)
            # recouvrement d'un segment pour ne pas couper une idée en deux
            cur, words = [cur[-1]], len(cur[-1]["text"].split())
    if cur and (not passages or cur != passages[-1][-1:]):
        passages.append(cur)
    with db.transaction() as c:
        c.execute("DELETE FROM passages_fts WHERE audio_id = ?", (audio_id,))
        c.execute("DELETE FROM passages WHERE audio_id = ?", (audio_id,))
        for p in passages:
            text = " ".join(s["text"] for s in p)
            pid = db.insert("passages", {"audio_id": audio_id, "start": p[0]["start"], "end": p[-1]["end"],
                                         "text": text}, c)
            c.execute("INSERT INTO passages_fts(text, passage_id, audio_id) VALUES (?, ?, ?)", (text, pid, audio_id))
    return len(passages)


def embedding_available() -> bool:
    return ollama_service.has_model(settings.get("ollama.embed_model"))


def embed_passages(audio_id: int, progress: Callable[[float, str], None] | None = None,
                   should_stop: Callable[[], bool] | None = None) -> int:
    model = settings.get("ollama.embed_model")
    rows = db.all("SELECT id, text FROM passages WHERE audio_id = ? AND (embedding IS NULL OR embed_model != ?) "
                  "ORDER BY id", (audio_id, model))
    batch = 16
    for i in range(0, len(rows), batch):
        if should_stop and should_stop():
            raise InterruptedError("Indexation annulée.")
        part = rows[i:i + batch]
        vectors = ollama_service.embed([r["text"] for r in part], model)
        with db.transaction() as c:
            for r, v in zip(part, vectors):
                arr = np.asarray(v, dtype=np.float32)
                arr /= (np.linalg.norm(arr) or 1.0)
                c.execute("UPDATE passages SET embedding = ?, embed_model = ? WHERE id = ?", (arr.tobytes(), model, r["id"]))
        if progress:
            progress(min(100, (i + batch) / max(1, len(rows)) * 100), "Indexation sémantique")
    return len(rows)


# --------------------------------------------------------------------------- recherche

def _scope_clause(audio_ids: list[int] | None, alias: str = "") -> tuple[str, list]:
    if not audio_ids:
        return "", []
    col = f"{alias}audio_id" if alias else "audio_id"
    return f" AND {col} IN ({','.join('?' for _ in audio_ids)})", list(audio_ids)


def text_search(query: str, audio_ids: list[int] | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
    """Recherche plein texte dans les segments (insensible aux accents), avec chapitre et speaker."""
    q = fts_query(query)
    if not q:
        return []
    exact = '"' + query.replace('"', " ").strip() + '"'
    where, params = _scope_clause(audio_ids, "f.")
    sql = (
        "SELECT s.id AS segment_id, s.audio_id, s.start, s.end, COALESCE(s.text_edited, s.text) AS text, "
        "snippet(segments_fts, 0, '[[', ']]', '…', 24) AS snippet, bm25(segments_fts) AS score, "
        "a.title AS audio_title, sp.label AS speaker, "
        "(SELECT c.title FROM chapters c WHERE c.audio_id = s.audio_id AND c.start <= s.start "
        " ORDER BY c.start DESC LIMIT 1) AS chapter "
        "FROM segments_fts f JOIN transcription_segments s ON s.id = f.segment_id "
        "JOIN audio_files a ON a.id = s.audio_id LEFT JOIN speakers sp ON sp.id = s.speaker_id "
        f"WHERE segments_fts MATCH ?{where} ORDER BY score LIMIT ? OFFSET ?"
    )
    results = []
    # d'abord l'expression exacte, puis les termes
    for match in ([exact, q] if " " in query.strip() else [q]):
        try:
            rows = db.all(sql, [match, *params, limit, offset])
        except Exception:
            continue
        for r in rows:
            if not any(x["segment_id"] == r["segment_id"] for x in results):
                r["match"] = "exact" if match == exact else "terms"
                results.append(r)
        if len(results) >= limit:
            break
    return results[:limit]


def semantic_search(query: str, audio_ids: list[int] | None = None, limit: int = 12) -> list[dict]:
    model = settings.get("ollama.embed_model")
    where, params = _scope_clause(audio_ids, "p.")
    rows = db.all("SELECT p.id, p.audio_id, p.start, p.end, p.text, p.embedding, a.title AS audio_title "
                  "FROM passages p JOIN audio_files a ON a.id = p.audio_id "
                  f"WHERE p.embedding IS NOT NULL AND p.embed_model = ?{where}", [model, *params])
    if not rows:
        return []
    qv = np.asarray(ollama_service.embed([query], model)[0], dtype=np.float32)
    qv /= (np.linalg.norm(qv) or 1.0)
    mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    scores = mat @ qv
    order = np.argsort(-scores)[:limit]
    out = []
    for i in order:
        r = dict(rows[int(i)])
        r.pop("embedding", None)
        r["score"] = round(float(scores[int(i)]), 4)
        r["match"] = "semantic"
        out.append(r)
    return out


def passage_text_search(query: str, audio_ids: list[int] | None = None, limit: int = 12) -> list[dict]:
    q = fts_query(query)
    if not q:
        return []
    where, params = _scope_clause(audio_ids, "f.")
    try:
        return db.all(
            "SELECT p.id, p.audio_id, p.start, p.end, p.text, a.title AS audio_title, bm25(passages_fts) AS score "
            "FROM passages_fts f JOIN passages p ON p.id = f.passage_id JOIN audio_files a ON a.id = p.audio_id "
            f"WHERE passages_fts MATCH ?{where} ORDER BY score LIMIT ?", [q, *params, limit])
    except Exception:
        return []


def hybrid_passages(query: str, audio_ids: list[int] | None = None, limit: int = 8) -> list[dict]:
    """Recherche hybride : sémantique si un modèle d'embeddings est disponible, plein texte sinon (et en complément)."""
    results: list[dict] = []
    try:
        if embedding_available():
            results = semantic_search(query, audio_ids, limit)
    except Exception as exc:
        log.warning("Recherche sémantique indisponible : %s", exc)
    for r in passage_text_search(query, audio_ids, limit):
        if not any(x["id"] == r["id"] for x in results):
            r["match"] = "terms"
            results.append(r)
    return results[: limit + 4]
