"""Tests réels : upload, FFmpeg, chunks et timestamps, transcription Whisper, recherche, exports, sécurité.

Lancement : python -m pytest tests -v
Les tests IA (Ollama/Qwen) sont dans test_ai.py (plus lents).
"""
from __future__ import annotations

import io
import json
import time
from pathlib import Path

import pytest

from tests.conftest import H


# --------------------------------------------------------------------------- FFmpeg

def test_ffmpeg_probe_and_normalize(meeting_wav, tmp_path):
    from backend.services import ffmpeg_service

    info = ffmpeg_service.probe(meeting_wav)
    assert info["duration"] > 60
    assert info["channels"] == 1
    out = ffmpeg_service.normalize(meeting_wav, tmp_path / "n.wav")
    n = ffmpeg_service.probe(out)
    assert n["sample_rate"] == 16000 and n["channels"] == 1
    assert abs(n["duration"] - info["duration"]) < 0.5
    peaks = ffmpeg_service.compute_peaks(out)
    assert len(peaks["peaks"]) > 100 and max(peaks["peaks"]) == 1.0


def test_ffmpeg_clip_export(meeting_wav, tmp_path):
    from backend.services import ffmpeg_service

    for fmt in ("mp3", "wav"):
        out = ffmpeg_service.export_segment(meeting_wav, tmp_path / f"c.{fmt}", 10, 20, fmt)
        d = ffmpeg_service.probe(out)["duration"]
        assert 9.5 < d < 10.6, d


def test_sentence_split_keeps_timeline():
    from backend.services.whisper_service import split_sentences

    seg = {"start": 10.0, "end": 40.0, "text": "Première phrase assez longue. Deuxième phrase, elle aussi longue ? "
           "Troisième phrase qui termine le segment !", "confidence": 0.9, "speaker": None}
    parts = split_sentences(dict(seg))
    assert len(parts) == 3
    assert parts[0]["start"] == 10.0 and parts[-1]["end"] == 40.0
    assert all(a["end"] <= b["start"] + 1e-6 for a, b in zip(parts, parts[1:]))
    assert " ".join(p["text"] for p in parts) == seg["text"]


def test_chunk_plan_on_long_file(long_mp3, tmp_path):
    """Fichier long : les frontières de chunks tombent près de la durée demandée et couvrent toute la timeline."""
    from backend.services import ffmpeg_service, transcription_service

    wav = ffmpeg_service.normalize(long_mp3, tmp_path / "long.wav")
    dur = ffmpeg_service.probe(wav)["duration"]
    assert dur > 900
    plan = transcription_service.plan_chunks(wav, dur, 300)
    assert plan[0][0] == 0 and abs(plan[-1][1] - dur) < 0.01
    for (a, b), (c, _) in zip(plan, plan[1:]):
        assert b == c                       # contigus, sans trou ni recouvrement
        assert 280 <= b - a <= 320          # proche de 300 s (±10 s de recherche de silence)


# --------------------------------------------------------------------------- sécurité des uploads

def test_upload_rejects_bad_extension(client):
    r = client.post("/api/audio/upload", files={"file": ("x.exe", b"MZ....", "application/octet-stream")}, headers=H)
    assert r.status_code == 400
    assert "Format non pris en charge" in r.json()["error"]


def test_upload_rejects_fake_audio(client):
    r = client.post("/api/audio/upload", files={"file": ("fake.mp3", b"<script>alert(1)</script>" * 20, "audio/mpeg")},
                    headers=H)
    assert r.status_code == 400


def test_csrf_header_required(client):
    r = client.post("/api/tags", json={"name": "test"})
    assert r.status_code == 403


def test_path_traversal_blocked():
    from backend.services import storage_service

    with pytest.raises(storage_service.UploadError):
        storage_service.audio_path("../../Windows/win.ini")
    with pytest.raises(storage_service.UploadError):
        storage_service.clip_path("..\\x.mp3")


def test_ollama_url_must_be_local(client):
    r = client.put("/api/settings", json={"values": {"ollama.url": "http://example.com:11434"}}, headers=H)
    assert r.status_code == 400


# --------------------------------------------------------------------------- pipeline réel (sans IA)

@pytest.fixture(scope="session")
def processed_audio(client, meeting_wav):
    client.put("/api/settings", json={"values": {"analysis.auto_run": False}}, headers=H)
    with open(meeting_wav, "rb") as f:
        r = client.post("/api/audio/upload", files={"file": ("Réunion test.wav", f, "audio/wav")},
                        data={"auto_process": "true", "language": "fr"}, headers=H)
    assert r.status_code == 200, r.text
    up = r.json()
    deadline = time.time() + 900
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{up['job_id']}").json()
        if j["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(2)
    assert j["status"] == "COMPLETED", j
    return up


def test_upload_metadata(processed_audio):
    assert processed_audio["codec"] == "pcm_s16le"
    assert processed_audio["channels"] == 1
    assert processed_audio["duration"] > 60


def test_transcription_segments_and_timestamps(client, processed_audio):
    tr = client.get(f"/api/audio/{processed_audio['id']}/transcription").json()
    segs = tr["segments"]
    assert len(segs) > 10
    assert tr["transcription"]["language"] == "fr"
    starts = [s["start"] for s in segs]
    assert starts == sorted(starts)
    assert all(s["end"] >= s["start"] for s in segs)
    assert segs[-1]["end"] <= processed_audio["duration"] + 0.5
    assert all(0 <= s["confidence"] <= 1 for s in segs)
    text = " ".join(s["text"] for s in segs).lower()
    assert "apple pay" in text and "budget" in text


def test_text_search(client, processed_audio):
    r = client.get("/api/search", params={"q": "Apple Pay"}).json()
    assert len(r["results"]) >= 2
    assert all(x["audio_id"] == processed_audio["id"] for x in r["results"])
    r2 = client.get("/api/search", params={"q": "budget"}).json()  # insensible aux accents/majuscules
    assert r2["results"]


def test_transcript_correction_keeps_original(client, processed_audio):
    aid = processed_audio["id"]
    segs = client.get(f"/api/audio/{aid}/transcription").json()["segments"]
    s = segs[0]
    r = client.patch(f"/api/segments/{s['id']}", json={"text": s["text"] + " (corrigé)"}, headers=H)
    assert r.status_code == 200 and r.json()["edited"]
    segs2 = client.get(f"/api/audio/{aid}/transcription").json()["segments"]
    assert segs2[0]["original"] == s["original"]         # l'original n'est jamais détruit
    assert segs2[0]["text"].endswith("(corrigé)")
    hist = client.get(f"/api/segments/{s['id']}/history").json()
    assert len(hist) == 1
    client.patch(f"/api/segments/{s['id']}", json={"text": s["original"]}, headers=H)


def test_replace_all(client, processed_audio):
    aid = processed_audio["id"]
    r = client.post(f"/api/audio/{aid}/transcription/replace", json={"find": "Apple Pay", "replace": "Apple Pay"}, headers=H)
    assert r.status_code == 200


def test_bookmarks_annotations_clips(client, processed_audio):
    aid = processed_audio["id"]
    assert client.post("/api/bookmarks", json={"audio_id": aid, "time": 12.5, "label": "Point à reprendre"}, headers=H).status_code == 200
    assert client.post("/api/annotations", json={"audio_id": aid, "time": 30, "text": "À vérifier avec l'avocat."}, headers=H).status_code == 200
    r = client.post("/api/clips", json={"audio_id": aid, "start": 20, "end": 35, "title": "Clip test", "tags": ["test"]}, headers=H)
    assert r.status_code == 200
    clip = r.json()
    for fmt in ("mp3", "wav", "txt", "md"):
        d = client.get(f"/api/clips/{clip['id']}/download", params={"fmt": fmt})
        assert d.status_code == 200 and len(d.content) > 50, fmt
    tl = client.get(f"/api/audio/{aid}/timeline").json()
    assert tl["bookmarks"] and tl["annotations"] and tl["clips"]


def test_manual_chapters(client, processed_audio):
    aid = processed_audio["id"]
    r = client.post(f"/api/audio/{aid}/chapters", json={"title": "Introduction", "start": 0}, headers=H).json()
    r = client.post(f"/api/audio/{aid}/chapters", json={"title": "Budget", "start": 55}, headers=H).json()
    assert len(r["chapters"]) == 2
    first, second = r["chapters"]
    assert first["end"] == second["start"]
    r = client.post(f"/api/chapters/{second['id']}/split", json={"time": 80}, headers=H).json()
    assert len(r["chapters"]) == 3
    r = client.patch(f"/api/chapters/{r['chapters'][2]['id']}", json={"title": "Communication"}, headers=H).json()
    ids = [c["id"] for c in r["chapters"][1:]]
    r = client.post(f"/api/audio/{aid}/chapters/merge", json={"ids": ids}, headers=H).json()
    assert len(r["chapters"]) == 2
    assert len(r["history"]) >= 4   # chaque modification est historisée
    d = client.get(f"/api/chapters/{r['chapters'][1]['id']}/export", params={"fmt": "mp3"})
    assert d.status_code == 200 and len(d.content) > 1000


@pytest.mark.parametrize("fmt", ["md", "txt", "json", "srt", "vtt", "docx", "pdf"])
def test_exports(client, processed_audio, fmt):
    r = client.get(f"/api/audio/{processed_audio['id']}/export", params={"fmt": fmt})
    assert r.status_code == 200
    body = r.content
    assert len(body) > 200
    if fmt == "pdf":
        assert body[:4] == b"%PDF"
    if fmt == "docx":
        assert body[:2] == b"PK"
    if fmt == "json":
        assert json.loads(body)["audio"]["id"] == processed_audio["id"]
    if fmt == "srt":
        assert "-->" in body.decode("utf-8")
    if fmt == "vtt":
        assert body.decode("utf-8").startswith("WEBVTT")


def test_dashboard_and_library(client, processed_audio):
    d = client.get("/api/dashboard").json()
    assert d["stats"]["audios"] >= 1
    lib = client.get("/api/audio", params={"q": "Réunion"}).json()
    assert lib["total"] >= 1


def test_health(client):
    r = client.get("/api/health").json()
    keys = {i["key"]: i for i in r["items"]}
    for k in ("python", "ffmpeg", "whisper", "sqlite", "storage"):
        assert keys[k]["status"] in ("ok", "warning", "info"), keys[k]


def test_long_file_chunked_transcription(client, long_mp3):
    """Fichier long (~16 min) découpé en chunks de 5 min : timestamps recalés sur la timeline originale."""
    client.put("/api/settings", json={"values": {"audio.chunk_duration": 300, "analysis.auto_run": False}}, headers=H)
    with open(long_mp3, "rb") as f:
        up = client.post("/api/audio/upload", files={"file": ("long.mp3", f, "audio/mpeg")}, data={"language": "fr"},
                         headers=H).json()
    deadline = time.time() + 1800
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{up['job_id']}").json()
        if j["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(3)
    assert j["status"] == "COMPLETED", j
    tr = client.get(f"/api/audio/{up['id']}/transcription").json()
    assert len(tr["chunks"]) >= 3 and all(c["status"] == "done" for c in tr["chunks"])
    segs = tr["segments"]
    assert segs[-1]["end"] > up["duration"] - 60          # la fin du fichier est bien transcrite
    assert segs[-1]["end"] <= up["duration"] + 0.5
    for c in tr["chunks"]:
        inside = [s for s in segs if c["start"] <= s["start"] < c["end"]]
        assert inside, f"chunk {c['idx']} sans segment"
    # la phrase « Apple Pay » revient à chaque répétition de la réunion (8 fois)
    hits = client.get("/api/search", params={"q": "Apple Pay", "audio_ids": str(up["id"]), "limit": 200}).json()["results"]
    assert len({int(h["start"] // 120) for h in hits}) >= 6
    client.put("/api/settings", json={"values": {"audio.chunk_duration": 300}}, headers=H)
