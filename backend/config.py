"""Configuration de l'application.

Deux niveaux :
- la configuration de démarrage (.env) : hôte, port, dossier de données, chemins ;
- les réglages modifiables à chaud (table `settings`), avec des valeurs par défaut issues du .env.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

FRONTEND_DIR = ROOT_DIR / "frontend"
PROMPTS_DIR = ROOT_DIR / "prompts"


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name, "").strip()
    return value if value else default


APP_HOST = _env("APP_HOST", "127.0.0.1")
APP_PORT = int(_env("APP_PORT", "8765"))
DATA_DIR = Path(_env("DATA_DIR", r"C:\TranscripIA-data"))

DB_PATH = DATA_DIR / "db" / "transcripia.sqlite"
AUDIO_DIR = DATA_DIR / "audio"
WORK_DIR = DATA_DIR / "work"          # WAV normalisés + pics de waveform
CHUNKS_DIR = DATA_DIR / "chunks"      # chunks temporaires pendant la transcription
CLIPS_DIR = DATA_DIR / "clips"
EXPORTS_DIR = DATA_DIR / "exports"
TEMP_DIR = DATA_DIR / "temp"
LOGS_DIR = DATA_DIR / "logs"
MODELS_DIR = DATA_DIR / "models"

ALL_DIRS = [DB_PATH.parent, AUDIO_DIR, WORK_DIR, CHUNKS_DIR, CLIPS_DIR, EXPORTS_DIR, TEMP_DIR, LOGS_DIR, MODELS_DIR]

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".oga", ".opus", ".webm", ".mp4"}


def ensure_dirs() -> None:
    for d in ALL_DIRS:
        d.mkdir(parents=True, exist_ok=True)


def _find_executable(name: str, env_name: str) -> str | None:
    explicit = _env(env_name)
    if explicit and Path(explicit).is_file():
        return explicit
    found = shutil.which(name)
    if found:
        return found
    # Le PATH hérité peut être antérieur à une installation winget / Ollama récente.
    local = Path(os.getenv("LOCALAPPDATA", ""))
    candidates = [
        local / "Microsoft" / "WinGet" / "Links" / f"{name}.exe",
        local / "Programs" / "Ollama" / f"{name}.exe",
        Path(r"C:\ffmpeg\bin") / f"{name}.exe",
        Path(r"C:\ProgramData\chocolatey\bin") / f"{name}.exe",
    ]
    winget_pkgs = local / "Microsoft" / "WinGet" / "Packages"
    if winget_pkgs.is_dir():
        candidates += list(winget_pkgs.glob(f"*FFmpeg*/**/bin/{name}.exe"))
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


FFMPEG_PATH = _find_executable("ffmpeg", "FFMPEG_PATH")
FFPROBE_PATH = _find_executable("ffprobe", "FFPROBE_PATH")
OLLAMA_EXE = _find_executable("ollama", "OLLAMA_PATH")


# Réglages modifiables depuis l'interface : clé -> (valeur par défaut, type)
DEFAULT_SETTINGS: dict[str, tuple[object, type]] = {
    "whisper.profile": (_env("WHISPER_PROFILE", "equilibre"), str),
    "whisper.model": (_env("WHISPER_MODEL", "small"), str),
    "whisper.device": (_env("WHISPER_DEVICE", "auto"), str),
    "whisper.compute_type": (_env("WHISPER_COMPUTE_TYPE", "auto"), str),
    "whisper.language": (_env("WHISPER_LANGUAGE", ""), str),
    "whisper.beam_size": (int(_env("WHISPER_BEAM_SIZE", "1")), int),
    "whisper.vad": (True, bool),
    "whisper.batched": (True, bool),
    "whisper.batch_size": (16, int),
    "whisper.word_timestamps": (False, bool),
    "audio.chunk_duration": (int(_env("CHUNK_DURATION_SEC", "300")), int),
    "audio.max_upload_mb": (int(_env("MAX_UPLOAD_MB", "2048")), int),
    "ollama.url": (_env("OLLAMA_URL", "http://127.0.0.1:11434"), str),
    "ollama.model": (_env("OLLAMA_MODEL", "qwen3:8b"), str),
    "ollama.embed_model": (_env("OLLAMA_EMBED_MODEL", "nomic-embed-text"), str),
    "ollama.temperature": (float(_env("OLLAMA_TEMPERATURE", "0.2")), float),
    "ollama.num_ctx": (int(_env("OLLAMA_NUM_CTX", "8192")), int),
    "ollama.max_tokens": (int(_env("OLLAMA_MAX_TOKENS", "2048")), int),
    "ollama.timeout": (900, int),
    "analysis.block_minutes": (8, int),
    "analysis.auto_run": (True, bool),
    "analysis.use_cache": (True, bool),
    "jobs.concurrency": (1, int),
    "jobs.timeout_min": (int(_env("JOB_TIMEOUT_MIN", "720")), int),
    "jobs.retries": (int(_env("JOB_RETRIES", "1")), int),
    "ui.theme": ("light", str),
}

LOG_LEVEL = _env("LOG_LEVEL", "INFO").upper()


def is_cloud_synced(path: Path) -> bool:
    """Détecte un dossier synchronisé (OneDrive, Dropbox, Google Drive…)."""
    p = str(path.resolve()).lower()
    markers = ["onedrive", "dropbox", "google drive", "googledrive", "icloud"]
    return any(m in p for m in markers)
