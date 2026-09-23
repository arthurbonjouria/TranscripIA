"""StorageService — chemins internes, validation des uploads, protection path traversal."""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from backend import config


class UploadError(ValueError):
    pass


# Signatures binaires (« magic numbers ») des formats autorisés
_MAGIC = [
    (0, b"ID3", "audio/mpeg"),
    (0, b"\xff\xfb", "audio/mpeg"),
    (0, b"\xff\xf3", "audio/mpeg"),
    (0, b"\xff\xf2", "audio/mpeg"),
    (0, b"RIFF", "audio/wav"),
    (0, b"fLaC", "audio/flac"),
    (0, b"OggS", "audio/ogg"),
    (0, b"\x1a\x45\xdf\xa3", "audio/webm"),
    (0, b"\xff\xf1", "audio/aac"),
    (0, b"\xff\xf9", "audio/aac"),
    (4, b"ftyp", "audio/mp4"),
]


def new_uid() -> str:
    return uuid.uuid4().hex


def safe_extension(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(e.lstrip(".").upper() for e in config.ALLOWED_EXTENSIONS))
        raise UploadError(f"Format non pris en charge ({ext or 'sans extension'}). Formats acceptés : {allowed}.")
    return ext


def sniff_mime(head: bytes) -> str | None:
    for offset, magic, mime in _MAGIC:
        if head[offset:offset + len(magic)] == magic:
            return mime
    # MP3 sans en-tête ID3 : synchronisation de trame 11 bits
    if len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return "audio/mpeg"
    return None


def clean_title(filename: str) -> str:
    stem = Path(filename or "audio").stem
    stem = re.sub(r"[_\-]+", " ", stem).strip()
    return stem[:200] or "Audio sans titre"


def audio_path(stored_name: str) -> Path:
    return _inside(config.AUDIO_DIR, stored_name)


def work_dir(uid: str) -> Path:
    return _inside(config.WORK_DIR, uid)


def normalized_wav(uid: str) -> Path:
    return work_dir(uid) / "normalized.wav"


def peaks_path(uid: str) -> Path:
    return work_dir(uid) / "peaks.json"


def chunk_dir(uid: str) -> Path:
    return _inside(config.CHUNKS_DIR, uid)


def clip_path(file_name: str) -> Path:
    return _inside(config.CLIPS_DIR, file_name)


def export_path(file_name: str) -> Path:
    return _inside(config.EXPORTS_DIR, file_name)


def _inside(base: Path, name: str) -> Path:
    """Refuse tout chemin qui sortirait du dossier de base (../, chemins absolus…)."""
    if not re.fullmatch(r"[A-Za-z0-9._\-]+", name or "") or ".." in name:
        raise UploadError("Nom de fichier interne invalide.")
    base_resolved = base.resolve()
    target = (base_resolved / name).resolve()
    if base_resolved not in target.parents and target != base_resolved:
        raise UploadError("Chemin refusé.")
    return target


def remove_audio_files(uid: str, stored_name: str) -> None:
    for p in (audio_path(stored_name),):
        p.unlink(missing_ok=True)
    shutil.rmtree(work_dir(uid), ignore_errors=True)
    shutil.rmtree(chunk_dir(uid), ignore_errors=True)


def disk_usage() -> dict:
    total, used, free = shutil.disk_usage(config.DATA_DIR)

    def folder_size(p: Path) -> int:
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0

    return {
        "total": total,
        "free": free,
        "audio": folder_size(config.AUDIO_DIR),
        "work": folder_size(config.WORK_DIR),
        "clips": folder_size(config.CLIPS_DIR),
        "exports": folder_size(config.EXPORTS_DIR),
        "models": folder_size(config.MODELS_DIR),
    }


def slugify(text: str, max_len: int = 60) -> str:
    import unicodedata

    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    t = re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-").lower()
    return (t or "export")[:max_len]
