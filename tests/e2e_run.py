"""Test de bout en bout réel : upload → FFmpeg → Whisper → Qwen → recherche → chat → exports.

Utilise un dossier de données temporaire (n'affecte pas vos données). Usage :
    python tests/e2e_run.py [fichier_audio] [--chunk 300] [--no-llm]
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

args = sys.argv[1:]
chunk = 600
if "--chunk" in args:
    chunk = int(args[args.index("--chunk") + 1])
no_llm = "--no-llm" in args
files = [a for a in args if a.endswith((".wav", ".mp3", ".m4a", ".flac"))]

tmp = Path(tempfile.mkdtemp(prefix="bonjouria-e2e-"))
os.environ["DATA_DIR"] = str(tmp)
# le modèle Whisper déjà téléchargé est réutilisé
os.environ.setdefault("E2E_MODELS", r"C:\TranscripIA-data\models")

from backend import config  # noqa: E402

config.MODELS_DIR = Path(os.environ["E2E_MODELS"])

from fastapi.testclient import TestClient  # noqa: E402

from backend.app import app  # noqa: E402
from tests import fixtures  # noqa: E402

H = {"X-Requested-With": "BonjourIA"}
audio_file = Path(files[0]) if files else fixtures.meeting()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


with TestClient(app) as c:
    c.put("/api/settings", json={"values": {"audio.chunk_duration": chunk, "analysis.auto_run": not no_llm}}, headers=H)
    t0 = time.time()
    with open(audio_file, "rb") as f:
        r = c.post("/api/audio/upload", files={"file": (audio_file.name, f, "audio/wav")},
                   data={"auto_process": "true"}, headers=H)
    assert r.status_code == 200, r.text
    up = r.json()
    log("UPLOAD", up["id"], f"durée={up['duration']:.1f}s codec={up['codec']} {up['sample_rate']}Hz {up['channels']}ch")
    aid, jid = up["id"], up["job_id"]
    last = ""
    while True:
        j = c.get(f"/api/jobs/{jid}").json()
        line = f"{j['status']:<12} {j['progress']:5.1f}%  " + " | ".join(
            f"{s['label']}:{s['status']}{'(' + str(s['progress']) + ')' if s['status'] == 'running' else ''}" for s in j["steps"])
        if line != last:
            log(line)
            last = line
        if j["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(3)
    log("MESSAGE", j["message"], "| ERREUR:", j.get("error"))
    if j.get("error_detail"):
        print(j["error_detail"])
    log(f"TEMPS TOTAL {time.time() - t0:.0f}s")
    tr = c.get(f"/api/audio/{aid}/transcription").json()
    segs = tr["segments"]
    log("SEGMENTS", len(segs), "chunks", len(tr["chunks"]), "langue", tr["transcription"]["language"],
        "mots", tr["transcription"]["word_count"])
    for s in segs[:4]:
        print(f"   {s['start']:7.2f} → {s['end']:7.2f}  ({s['confidence']})  {s['text']}")
    if len(segs) > 4:
        s = segs[-1]
        print(f"   … {s['start']:7.2f} → {s['end']:7.2f}  {s['text']}")
    # timestamps : croissants et dans la durée
    starts = [s["start"] for s in segs]
    assert starts == sorted(starts), "timestamps non croissants"
    assert segs[-1]["end"] <= up["duration"] + 0.5, "timestamp hors durée"
    log("TIMESTAMPS OK (croissants, dernier =", segs[-1]["end"], "/ durée", round(up["duration"], 1), ")")
    ch = c.get(f"/api/audio/{aid}/chapters").json()["chapters"]
    log("CHAPITRES", len(ch))
    for x in ch:
        print(f"   {x['start']:7.1f}  {x['title']}  — {x['summary'][:90]}")
    ins = c.get(f"/api/audio/{aid}/insights").json()
    for k in ("decisions", "actions", "questions", "risks", "people", "topics", "entities", "highlights"):
        log(k.upper(), len(ins[k]))
        for x in ins[k][:6]:
            print("   -", x.get("text") or x.get("name") or x.get("value"), "|", x.get("owner", ""), x.get("deadline", ""),
                  x.get("kind", ""), x.get("category", ""), x.get("time") or x.get("start") or "")
    summ = c.get(f"/api/audio/{aid}/summary").json()
    if summ["summary"]:
        log("TLDR", summ["summary"]["tldr"])
        log("SHORT", summ["summary"]["short"][:400])
    r = c.get("/api/search", params={"q": "Apple Pay"}).json()
    log("RECHERCHE 'Apple Pay'", len(r["results"]), [f"{x['start']:.0f}s" for x in r["results"][:5]])
    r = c.get("/api/search", params={"q": "problèmes liés au paiement", "mode": "semantic"}).json()
    log("RECHERCHE sémantique", len(r["results"]), "repli plein texte" if r.get("fallback") else "")
    for fmt in ("md", "txt", "json", "srt", "vtt", "docx", "pdf"):
        r = c.get(f"/api/audio/{aid}/export", params={"fmt": fmt})
        log("EXPORT", fmt, r.status_code, len(r.content), "octets")
        (tmp / f"export.{fmt}").write_bytes(r.content)
    r = c.post("/api/clips", json={"audio_id": aid, "start": 10, "end": 25, "title": "Test clip"}, headers=H)
    log("CLIP", r.status_code, r.json().get("file_name"))
    r = c.get(f"/api/clips/{r.json()['id']}/download", params={"fmt": "mp3"})
    log("CLIP MP3", r.status_code, len(r.content))
    if ch:
        r = c.get(f"/api/chapters/{ch[0]['id']}/export", params={"fmt": "mp3"})
        log("EXPORT CHAPITRE mp3", r.status_code, len(r.content))
    if not no_llm and j["status"] == "COMPLETED":
        t = time.time()
        with c.stream("POST", f"/api/audio/{aid}/chat", json={"question": "Quelles décisions ont été prises ?"},
                      headers=H) as resp:
            import json as _j

            answer, sources = "", []
            for line in resp.iter_lines():
                if not line:
                    continue
                ev = _j.loads(line)
                if ev["type"] == "token":
                    answer += ev["text"]
                elif ev["type"] == "done":
                    sources = ev["sources"]
                elif ev["type"] == "error":
                    log("CHAT ERREUR", ev)
        log(f"CHAT ({time.time() - t:.0f}s)", answer[:600])
        log("SOURCES", [(s["label"], round(s["start"], 1)) for s in sources])
    log("DONNÉES DE TEST :", tmp)
