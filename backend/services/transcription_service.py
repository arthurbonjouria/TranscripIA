"""TranscriptionService — découpage en chunks, transcription reprenable, recalage des timestamps."""
from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path
from typing import Callable

import numpy as np

from backend import db, settings
from backend.services import ffmpeg_service, storage_service, whisper_service

log = logging.getLogger("transcription")


def plan_chunks(wav: Path, duration: float, chunk_sec: int, search_window: float = 10.0) -> list[tuple[float, float]]:
    """Découpe en chunks d'environ `chunk_sec` secondes, en plaçant chaque frontière
    sur le passage le plus silencieux à ±`search_window` s pour ne pas couper un mot."""
    chunk_sec = max(60, int(chunk_sec))
    if duration <= chunk_sec * 1.2:
        return [(0.0, duration)]
    sr = 16000
    data = np.memmap(wav, dtype=np.int16, mode="r", offset=ffmpeg_service.wav_data_offset(wav))
    bounds = [0.0]
    t = float(chunk_sec)
    while t < duration - chunk_sec * 0.3:
        a = int(max(0, t - search_window) * sr)
        b = int(min(duration, t + search_window) * sr)
        window = np.asarray(data[a:b], dtype=np.float32)
        frame = int(0.05 * sr)  # trames de 50 ms
        n = len(window) // frame
        if n > 0:
            energy = (window[: n * frame].reshape(n, frame) ** 2).mean(axis=1)
            cut = (a + int(np.argmin(energy)) * frame + frame // 2) / sr
        else:
            cut = t
        bounds.append(round(cut, 3))
        t = cut + chunk_sec
    bounds.append(duration)
    return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]


def current_transcription(audio_id: int) -> dict | None:
    return db.one(
        "SELECT * FROM transcriptions WHERE audio_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1", (audio_id,)
    )


def start_or_resume(audio: dict, force_new: bool = False, profile: str | None = None) -> dict:
    """Reprend une transcription inachevée, ou en crée une nouvelle (l'ancienne est conservée dans l'historique)."""
    tr = current_transcription(audio["id"])
    if tr and not force_new and tr["status"] in ("pending", "running", "failed"):
        return tr
    if tr and not force_new and tr["status"] == "completed":
        return tr
    version = (db.scalar("SELECT MAX(version) FROM transcriptions WHERE audio_id = ?", (audio["id"],)) or 0) + 1
    device, compute = whisper_service.resolve_device()
    prof = whisper_service.resolve_profile(profile)
    with db.transaction() as c:
        c.execute("UPDATE transcriptions SET is_current = 0 WHERE audio_id = ?", (audio["id"],))
        tid = db.insert("transcriptions", {
            "audio_id": audio["id"], "version": version, "model": prof["model"],
            "device": f"{device}/{compute} · {prof['label'].lower()}", "chunk_duration": settings.get("audio.chunk_duration"),
            "status": "pending", "is_current": 1,
        }, c)
    return db.one("SELECT * FROM transcriptions WHERE id = ?", (tid,))


def run(
    audio: dict,
    transcription: dict,
    progress: Callable[[float, str], None],
    should_stop: Callable[[], bool],
    language: str | None = None,
    profile: str | None = None,
) -> dict:
    """Transcrit tous les chunks restants. Chaque chunk terminé est enregistré immédiatement (reprise possible)."""
    uid = audio["uid"]
    wav = storage_service.normalized_wav(uid)
    if not wav.exists():
        raise whisper_service.WhisperError("Le fichier audio préparé est introuvable. Relancez le traitement.")
    tid = transcription["id"]
    duration = audio["duration"]

    chunks = db.all("SELECT * FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx", (tid,))
    if not chunks:
        plan = plan_chunks(wav, duration, transcription["chunk_duration"])
        with db.transaction() as c:
            for i, (a, b) in enumerate(plan):
                db.insert("transcription_chunks", {"transcription_id": tid, "idx": i, "start": a, "end": b}, c)
        chunks = db.all("SELECT * FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx", (tid,))

    lang = language or transcription["language"] or None
    db.update("transcriptions", tid, {"status": "running", **({"language": lang} if lang else {})})
    started = time.time()
    tmp_dir = storage_service.chunk_dir(uid)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    total = len(chunks)
    try:
        for ch in chunks:
            if ch["status"] == "done":
                continue
            if should_stop():
                raise InterruptedError("Transcription annulée.")
            base_pct = ch["idx"] / total * 100
            progress(base_pct, f"Transcription du segment {ch['idx'] + 1} sur {total}")
            chunk_file = tmp_dir / f"chunk_{ch['idx']:04d}.wav"
            ffmpeg_service.extract_chunk(wav, chunk_file, ch["start"], ch["end"] - ch["start"])
            span = max(1e-6, ch["end"] - ch["start"])

            def on_seg(seg, _ch=ch, _base=base_pct, _span=span):
                progress(_base + min(1.0, seg["end"] / _span) * (100 / total),
                         f"Transcription du segment {_ch['idx'] + 1} sur {total}")

            result = whisper_service.transcribe_file(chunk_file, language=lang, on_segment=on_seg,
                                                     should_stop=should_stop, profile=profile)
            chunk_file.unlink(missing_ok=True)
            if not lang:
                lang = result["language"]
                db.update("transcriptions", tid, {"language": lang,
                                                  "language_prob": round(result["language_probability"], 3)})
            next_idx = (db.scalar("SELECT MAX(idx) FROM transcription_segments WHERE transcription_id = ?",
                                  (tid,)) or -1) + 1
            with db.transaction() as c:
                for k, seg in enumerate(result["segments"]):
                    # Recalage : timestamp du chunk + offset du chunk dans la timeline originale
                    start = min(ch["end"], ch["start"] + seg["start"])
                    end = min(ch["end"], ch["start"] + seg["end"])
                    db.insert("transcription_segments", {
                        "transcription_id": tid, "audio_id": audio["id"], "idx": next_idx + k,
                        "start": round(start, 3), "end": round(max(start, end), 3), "text": seg["text"],
                        "confidence": seg["confidence"], "chunk_idx": ch["idx"],
                    }, c)
                c.execute("UPDATE transcription_chunks SET status = 'done', error = NULL WHERE id = ?", (ch["id"],))
    except BaseException as exc:
        status = "failed" if not isinstance(exc, InterruptedError) else "pending"
        db.update("transcriptions", tid, {"status": status})
        raise
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    words = db.scalar(
        "SELECT COALESCE(SUM(LENGTH(TRIM(text)) - LENGTH(REPLACE(TRIM(text), ' ', '')) + 1), 0) "
        "FROM transcription_segments WHERE transcription_id = ?", (tid,)
    ) or 0
    db.update("transcriptions", tid, {
        "status": "completed", "word_count": int(words),
        "processing_sec": round((transcription["processing_sec"] or 0) + time.time() - started, 1),
        "completed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    if lang:
        db.update("audio_files", audio["id"], {"language": lang})
    progress(100, "Transcription terminée")
    return db.one("SELECT * FROM transcriptions WHERE id = ?", (tid,))


def segments(audio_id: int) -> list[dict]:
    tr = current_transcription(audio_id)
    if not tr:
        return []
    return db.all(
        "SELECT s.id, s.idx, s.start, s.end, COALESCE(s.text_edited, s.text) AS text, s.text AS original, "
        "s.text_edited IS NOT NULL AS edited, s.confidence, s.speaker_id, sp.label AS speaker, sp.name AS speaker_name "
        "FROM transcription_segments s LEFT JOIN speakers sp ON sp.id = s.speaker_id "
        "WHERE s.transcription_id = ? ORDER BY s.start, s.idx", (tr["id"],)
    )


def rebuild_fts(audio_id: int) -> None:
    tr = current_transcription(audio_id)
    with db.transaction() as c:
        c.execute("DELETE FROM segments_fts WHERE audio_id = ?", (audio_id,))
        if tr:
            c.execute(
                "INSERT INTO segments_fts(text, segment_id, audio_id) "
                "SELECT COALESCE(text_edited, text), id, audio_id FROM transcription_segments WHERE transcription_id = ?",
                (tr["id"],),
            )


def edit_segment(segment_id: int, new_text: str) -> dict:
    seg = db.one("SELECT * FROM transcription_segments WHERE id = ?", (segment_id,))
    if not seg:
        raise KeyError("Segment introuvable")
    new_text = new_text.strip()
    old = seg["text_edited"] if seg["text_edited"] is not None else seg["text"]
    if new_text == old:
        return seg
    with db.transaction() as c:
        c.execute("INSERT INTO segment_edits(segment_id, old_text, new_text) VALUES (?, ?, ?)",
                  (segment_id, old, new_text))
        # Revenir exactement au texte original annule la correction
        edited = None if new_text == seg["text"] else new_text
        c.execute("UPDATE transcription_segments SET text_edited = ?, edited_at = datetime('now') WHERE id = ?",
                  (edited, segment_id))
        c.execute("UPDATE segments_fts SET text = ? WHERE segment_id = ?", (new_text, segment_id))
        c.execute("UPDATE audio_files SET transcript_rev = transcript_rev + 1, updated_at = datetime('now') "
                  "WHERE id = ?", (seg["audio_id"],))
    return db.one("SELECT * FROM transcription_segments WHERE id = ?", (segment_id,))


def replace_all(audio_id: int, find: str, replace: str, case_sensitive: bool = False) -> int:
    """Remplacement global (ex. « Apple play » → « Apple Pay »). Retourne le nombre de segments modifiés."""
    import re

    if not find.strip():
        return 0
    flags = 0 if case_sensitive else re.IGNORECASE
    pattern = re.compile(re.escape(find), flags)
    count = 0
    for seg in segments(audio_id):
        if pattern.search(seg["text"]):
            edit_segment(seg["id"], pattern.sub(replace, seg["text"]))
            count += 1
    return count


def full_text(audio_id: int, with_times: bool = False) -> str:
    from backend.services.util import fmt_time

    lines = []
    for s in segments(audio_id):
        lines.append(f"[{fmt_time(s['start'])}] {s['text']}" if with_times else s["text"])
    return "\n".join(lines)


def resegment(audio_id: int) -> int:
    """Redécoupe une transcription existante en phrases (sans relancer Whisper).
    Crée une nouvelle version : l'originale reste dans l'historique."""
    tr = current_transcription(audio_id)
    if not tr or tr["status"] != "completed":
        raise ValueError("Aucune transcription terminée pour cet audio.")
    old = db.all("SELECT * FROM transcription_segments WHERE transcription_id = ? ORDER BY start, idx", (tr["id"],))
    version = (db.scalar("SELECT MAX(version) FROM transcriptions WHERE audio_id = ?", (audio_id,)) or 0) + 1
    with db.transaction() as c:
        c.execute("UPDATE transcriptions SET is_current = 0 WHERE audio_id = ?", (audio_id,))
        new_id = db.insert("transcriptions", {
            "audio_id": audio_id, "version": version, "model": tr["model"], "device": tr["device"] + " · phrases",
            "language": tr["language"], "language_prob": tr["language_prob"], "chunk_duration": tr["chunk_duration"],
            "status": "completed", "is_current": 1, "word_count": tr["word_count"], "processing_sec": tr["processing_sec"],
            "completed_at": tr["completed_at"],
        }, c)
        idx = 0
        for s in old:
            base = {"start": s["start"], "end": s["end"], "text": s["text_edited"] or s["text"], "confidence": s["confidence"]}
            for part in whisper_service.split_sentences(base):
                db.insert("transcription_segments", {
                    "transcription_id": new_id, "audio_id": audio_id, "idx": idx, "start": part["start"],
                    "end": part["end"], "text": part["text"], "confidence": s["confidence"], "chunk_idx": s["chunk_idx"],
                    "speaker_id": s["speaker_id"],
                }, c)
                idx += 1
    rebuild_fts(audio_id)
    from backend.services import search_service

    search_service.build_passages(audio_id)
    return idx
