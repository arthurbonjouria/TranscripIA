"""Diagnostic système — tests réels des composants (SYSTEM HEALTH)."""
from __future__ import annotations

import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from backend import config, db, settings
from backend.services import ffmpeg_service, ollama_service, whisper_service

_NOWIN = 0x08000000 if os.name == "nt" else 0


def _item(key: str, label: str, status: str, detail: str = "", hint: str = "", **extra) -> dict:
    # status : ok, warning, error, info
    return {"key": key, "label": label, "status": status, "detail": detail, "hint": hint, **extra}


def _cmd(args: list[str], timeout: int = 10) -> str:
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout, creationflags=_NOWIN)
        return (p.stdout or p.stderr).decode("utf-8", "replace").strip()
    except Exception:
        return ""


def check_python() -> dict:
    return _item("python", "Python", "ok", f"{platform.python_version()} — {sys.executable}")


def check_php() -> dict:
    php = shutil.which("php")
    wamp = sorted(Path(r"C:\wamp64\bin\php").glob("php*/php.exe")) if Path(r"C:\wamp64\bin\php").exists() else []
    path = php or (str(wamp[-1]) if wamp else None)
    if not path:
        return _item("php", "PHP", "info", "Non détecté — non requis (backend Python).")
    v = _cmd([path, "-v"]).splitlines()
    return _item("php", "PHP", "info", f"{v[0] if v else 'détecté'} — non requis par l'application")


def check_ffmpeg(deep: bool = True) -> dict:
    if not ffmpeg_service.available():
        return _item("ffmpeg", "FFmpeg", "error", "FFmpeg ou ffprobe introuvable.",
                     "winget install Gyan.FFmpeg, puis redémarrez l'application.")
    try:
        v = ffmpeg_service.version()
        if deep:
            tmp = config.TEMP_DIR / "diag_tone.wav"
            ffmpeg_service.generate_test_tone(tmp, 1.0)
            info = ffmpeg_service.probe(tmp)
            tmp.unlink(missing_ok=True)
            if abs(info["duration"] - 1.0) > 0.1:
                return _item("ffmpeg", "FFmpeg", "warning", f"{v} — test de conversion incohérent")
        v = v.replace("ffmpeg version ", "").split(" Copyright")[0]
        return _item("ffmpeg", "FFmpeg", "ok", f"{v} — conversion testée",
                     path=config.FFMPEG_PATH)
    except Exception as exc:
        return _item("ffmpeg", "FFmpeg", "error", str(exc)[:300])


def check_gpu() -> dict:
    smi = shutil.which("nvidia-smi") or r"C:\Windows\System32\nvidia-smi.exe"
    out = _cmd([smi, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"]) if Path(smi).exists() else ""
    cuda = whisper_service.cuda_status()
    if not out:
        return _item("gpu", "GPU", "info", "Aucun GPU NVIDIA détecté — Whisper fonctionne sur le CPU.")
    name = out.splitlines()[0]
    if cuda["available"]:
        return _item("gpu", "GPU", "ok", f"{name} — utilisable par Whisper (CUDA)")
    return _item("gpu", "GPU", "warning", f"{name} — non utilisable par Whisper : {cuda['reason'][:160]}",
                 "Pour une transcription quasi instantanée : mettez à jour le pilote NVIDIA (version 525 ou plus), "
                 "puis « python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.* » et redémarrez. "
                 "En attendant, Whisper utilise le CPU.")


def check_whisper(deep: bool = False) -> dict:
    try:
        import ctranslate2
        import faster_whisper
    except ImportError:
        return _item("whisper", "Whisper", "error", "faster-whisper n'est pas installé.", "pip install faster-whisper")
    name = settings.get("whisper.model")
    device, compute = whisper_service.resolve_device()
    base = f"faster-whisper {faster_whisper.__version__} · modèle {name} · {device}/{compute}"
    if not whisper_service.is_model_downloaded(name):
        return _item("whisper", "Whisper", "warning", f"{base} — modèle non téléchargé",
                     f"Le modèle « {name} » (~{whisper_service.MODEL_SIZES_MB.get(name, '?')} Mo) sera téléchargé "
                     "au premier traitement.")
    if deep:
        try:
            t = time.time()
            tmp = config.TEMP_DIR / "diag_whisper.wav"
            ffmpeg_service.generate_test_tone(tmp, 2.0)
            whisper_service.transcribe_file(tmp)
            tmp.unlink(missing_ok=True)
            return _item("whisper", "Whisper", "ok", f"{base} — test de transcription réussi ({time.time() - t:.1f} s)")
        except Exception as exc:
            return _item("whisper", "Whisper", "error", f"{base} — {exc}"[:300])
    return _item("whisper", "Whisper", "ok", f"{base} — modèle présent")


def check_ollama() -> tuple[dict, dict]:
    st = ollama_service.status()
    model = settings.get("ollama.model")
    if not st["available"]:
        o = _item("ollama", "Ollama", "error", st.get("error", "Ollama ne répond pas."),
                  "Lancez l'application Ollama (ou « ollama serve »). La transcription reste disponible sans Ollama.")
        return o, _item("llm", "Qwen", "error", "Indisponible tant qu'Ollama ne répond pas.")
    o = _item("ollama", "Ollama", "ok", f"version {st['version']} — {settings.get('ollama.url')}")
    try:
        models = ollama_service.list_models()
    except Exception as exc:
        return o, _item("llm", "Qwen", "error", str(exc))
    names = {m["name"] for m in models}
    if model not in names and f"{model}:latest" not in names:
        return o, _item("llm", "Qwen", "error", f"Modèle « {model} » non installé.",
                        f"ollama pull {model}  (ou choisissez un modèle installé dans Paramètres)")
    m = next(x for x in models if x["name"] in (model, f"{model}:latest"))
    return o, _item("llm", "Qwen", "ok", f"{m['name']} · {m['parameters']} · {m['quantization']}"
                    + (" · chargé en mémoire" if m["loaded"] else ""))


def check_llm_generation() -> dict:
    try:
        r = ollama_service.quick_test()
        status = "ok" if r["ok"] else "warning"
        return _item("llm", "Qwen", status, f"Réponse « {r['answer']} » en {r['seconds']} s")
    except Exception as exc:
        return _item("llm", "Qwen", "error", str(exc)[:300])


def check_embeddings() -> dict:
    name = settings.get("ollama.embed_model")
    if ollama_service.has_model(name):
        return _item("embeddings", "Recherche sémantique", "ok", f"Modèle d'embeddings « {name} » installé")
    return _item("embeddings", "Recherche sémantique", "info",
                 f"Modèle « {name} » non installé — la recherche plein texte est utilisée.",
                 f"Optionnel : ollama pull {name}")


def check_sqlite() -> dict:
    try:
        ok = db.scalar("PRAGMA quick_check")
        c = sqlite3.connect(":memory:")
        c.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        c.close()
        size = config.DB_PATH.stat().st_size if config.DB_PATH.exists() else 0
        return _item("sqlite", "SQLite", "ok" if ok == "ok" else "error",
                     f"{sqlite3.sqlite_version} · FTS5 · intégrité {ok} · {size / 1e6:.1f} Mo")
    except Exception as exc:
        return _item("sqlite", "SQLite", "error", str(exc))


def check_storage() -> dict:
    try:
        total, used, free = shutil.disk_usage(config.DATA_DIR)
        probe = config.TEMP_DIR / ".write_test"
        probe.write_text("ok")
        probe.unlink()
        detail = f"{config.DATA_DIR} · {free / 1e9:.0f} Go libres"
        if config.is_cloud_synced(config.DATA_DIR):
            return _item("storage", "Stockage", "warning", detail + " · dossier synchronisé dans le cloud !",
                         "Déplacez DATA_DIR hors de OneDrive/Dropbox pour garantir un traitement 100 % local.")
        if free < 5e9:
            return _item("storage", "Stockage", "warning", detail, "Espace disque faible.")
        return _item("storage", "Stockage", "ok", detail + " · écriture OK · hors cloud")
    except Exception as exc:
        return _item("storage", "Stockage", "error", str(exc))


def system_info() -> dict:
    info = {"os": f"{platform.system()} {platform.release()} ({platform.version()})", "machine": platform.machine(),
            "cpu": platform.processor(), "cpu_count": os.cpu_count(), "ram_total_gb": None, "ram_free_gb": None}
    if os.name == "nt":
        import ctypes

        class MEMSTAT(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

        m = MEMSTAT()
        m.dwLength = ctypes.sizeof(MEMSTAT)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            info["ram_total_gb"] = round(m.ullTotalPhys / 2**30, 1)
            info["ram_free_gb"] = round(m.ullAvailPhys / 2**30, 1)
        name = _cmd(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"], timeout=15)
        if name:
            info["cpu"] = name.splitlines()[0]
    return info


def run(deep: bool = False) -> dict:
    items = [check_python(), check_ffmpeg(deep=True), check_whisper(deep=deep)]
    ollama, llm = check_ollama()
    items += [ollama, llm if not (deep and llm["status"] == "ok") else check_llm_generation()]
    items += [check_embeddings(), check_gpu(), check_sqlite(), check_storage(), check_php()]
    worst = "ok"
    for it in items:
        if it["status"] == "error" and it["key"] in ("ffmpeg", "whisper", "sqlite", "storage", "python"):
            worst = "error"
        elif it["status"] in ("error", "warning") and worst == "ok":
            worst = "warning"
    return {"status": worst, "items": items, "system": system_info(), "checked_at": time.strftime("%Y-%m-%d %H:%M:%S")}


if __name__ == "__main__":  # DIAGNOSTIC.bat
    from backend.logging_setup import setup_logging

    config.ensure_dirs()
    db.init_db()
    icons = {"ok": "OK  ", "warning": "ATTN", "error": "ERR ", "info": "INFO"}
    print("\n  BONJOUR IA — Audio Intelligence Workspace · Diagnostic\n")
    res = run(deep="--deep" in sys.argv)
    s = res["system"]
    print(f"  Système : {s['os']} · {s['cpu']} · {s['cpu_count']} threads · RAM {s['ram_total_gb']} Go "
          f"({s['ram_free_gb']} Go libres)\n")
    for it in res["items"]:
        print(f"  [{icons[it['status']]}] {it['label']:<22} {it['detail']}")
        if it.get("hint") and it["status"] != "ok":
            print(f"         {'':<22} → {it['hint']}")
    print(f"\n  État global : {res['status'].upper()}\n")
