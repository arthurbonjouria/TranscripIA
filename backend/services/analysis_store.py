"""Historique versionné des analyses (table `analyses`) et cache IA."""
from __future__ import annotations

from typing import Any

from backend import db


def current(audio_id: int | None, kind: str, scope: str = "") -> dict | None:
    if audio_id is None:
        row = db.one("SELECT * FROM analyses WHERE audio_id IS NULL AND kind = ? AND scope = ? AND is_current = 1 "
                     "ORDER BY id DESC LIMIT 1", (kind, scope))
    else:
        row = db.one("SELECT * FROM analyses WHERE audio_id = ? AND kind = ? AND is_current = 1 "
                     "ORDER BY id DESC LIMIT 1", (audio_id, kind))
    if row:
        row["content"] = db.jloads(row["content"], {})
    return row


def history(audio_id: int, kind: str) -> list[dict]:
    rows = db.all("SELECT id, kind, version, model, prompt_version, transcript_rev, source, is_current, created_at, "
                  "duration_sec FROM analyses WHERE audio_id = ? AND kind = ? ORDER BY version DESC", (audio_id, kind))
    return rows


def get(analysis_id: int) -> dict | None:
    row = db.one("SELECT * FROM analyses WHERE id = ?", (analysis_id,))
    if row:
        row["content"] = db.jloads(row["content"], {})
    return row


def save(audio_id: int | None, kind: str, content: Any, *, model: str = "", prompt_version: str = "",
         transcript_rev: int = 0, source: str = "ai", scope: str = "", duration_sec: float = 0,
         replace_current: bool = False) -> int:
    """Enregistre une nouvelle version. Les versions précédentes sont conservées (is_current = 0).
    `replace_current` met à jour la version courante sur place (sauvegarde incrémentale d'une analyse en cours)."""
    with db.transaction() as c:
        if replace_current:
            cur = current(audio_id, kind, scope)
            if cur:
                c.execute("UPDATE analyses SET content = ?, model = ?, prompt_version = ?, transcript_rev = ?, "
                          "duration_sec = ? WHERE id = ?",
                          (db.jdumps(content), model, prompt_version, transcript_rev, duration_sec, cur["id"]))
                return cur["id"]
        if audio_id is None:
            version = (c.execute("SELECT MAX(version) AS v FROM analyses WHERE audio_id IS NULL AND kind = ? AND scope = ?",
                                 (kind, scope)).fetchone()["v"] or 0) + 1
            c.execute("UPDATE analyses SET is_current = 0 WHERE audio_id IS NULL AND kind = ? AND scope = ?",
                      (kind, scope))
        else:
            version = (c.execute("SELECT MAX(version) AS v FROM analyses WHERE audio_id = ? AND kind = ?",
                                 (audio_id, kind)).fetchone()["v"] or 0) + 1
            c.execute("UPDATE analyses SET is_current = 0 WHERE audio_id = ? AND kind = ?", (audio_id, kind))
        return db.insert("analyses", {
            "audio_id": audio_id, "kind": kind, "version": version, "content": db.jdumps(content), "model": model,
            "prompt_version": prompt_version, "transcript_rev": transcript_rev, "source": source, "scope": scope,
            "is_current": 1, "duration_sec": duration_sec,
        }, c)


def restore(analysis_id: int) -> None:
    row = db.one("SELECT audio_id, kind, scope FROM analyses WHERE id = ?", (analysis_id,))
    if not row:
        raise KeyError("Version introuvable")
    with db.transaction() as c:
        if row["audio_id"] is None:
            c.execute("UPDATE analyses SET is_current = 0 WHERE audio_id IS NULL AND kind = ? AND scope = ?",
                      (row["kind"], row["scope"]))
        else:
            c.execute("UPDATE analyses SET is_current = 0 WHERE audio_id = ? AND kind = ?", (row["audio_id"], row["kind"]))
        c.execute("UPDATE analyses SET is_current = 1 WHERE id = ?", (analysis_id,))


def is_fresh(audio: dict, kind: str) -> bool:
    """Le cache est valide si l'analyse existe et a été calculée sur la version courante de la transcription."""
    cur = current(audio["id"], kind)
    return bool(cur and cur["transcript_rev"] == audio["transcript_rev"])
