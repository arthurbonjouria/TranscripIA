"""FFmpegService — toutes les opérations audio.

Sécurité : FFmpeg est toujours appelé avec une liste d'arguments (jamais via un shell),
et les chemins passés sont exclusivement des chemins internes générés par l'application.
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import numpy as np

from backend import config

log = logging.getLogger("ffmpeg")

_CREATE_NO_WINDOW = 0x08000000 if hasattr(subprocess, "STARTUPINFO") else 0


class FFmpegError(RuntimeError):
    pass


def available() -> bool:
    return bool(config.FFMPEG_PATH and config.FFPROBE_PATH)


def _require() -> tuple[str, str]:
    if not available():
        raise FFmpegError(
            "FFmpeg est introuvable. Installez-le (winget install Gyan.FFmpeg) ou renseignez FFMPEG_PATH dans .env."
        )
    return config.FFMPEG_PATH, config.FFPROBE_PATH  # type: ignore[return-value]


def _run(args: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"FFmpeg a dépassé le délai autorisé ({timeout}s).") from exc
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        tail = "\n".join(err[-8:])
        raise FFmpegError(f"FFmpeg a échoué (code {proc.returncode}).\n{tail}")
    return proc


def version() -> str:
    ffmpeg, _ = _require()
    out = _run([ffmpeg, "-hide_banner", "-version"], timeout=20).stdout.decode("utf-8", "replace")
    return out.splitlines()[0] if out else ""


def probe(path: Path) -> dict:
    """Retourne durée, codec, fréquence, canaux, débit. Lève FFmpegError si ce n'est pas un audio lisible."""
    _, ffprobe = _require()
    proc = _run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        timeout=120,
    )
    data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        raise FFmpegError("Le fichier ne contient aucune piste audio exploitable.")
    s = streams[0]
    fmt = data.get("format", {})
    duration = float(fmt.get("duration") or s.get("duration") or 0)
    return {
        "duration": duration,
        "codec": s.get("codec_name", ""),
        "sample_rate": int(s.get("sample_rate") or 0),
        "channels": int(s.get("channels") or 0),
        "bitrate": int(fmt.get("bit_rate") or s.get("bit_rate") or 0),
        "format_name": fmt.get("format_name", ""),
    }


def normalize(src: Path, dst: Path, loudnorm: bool = True) -> Path:
    """Convertit en WAV PCM 16 bits, 16 kHz, mono (format attendu par Whisper), avec normalisation du volume."""
    ffmpeg, _ = _require()
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part.wav")
    args = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000"]
    if loudnorm:
        # dynaudnorm : normalisation dynamique en une passe, adaptée à la parole et aux longs fichiers
        args += ["-af", "dynaudnorm=f=250:g=15"]
    args += ["-c:a", "pcm_s16le", "-f", "wav", str(tmp)]
    _run(args)
    tmp.replace(dst)
    return dst


def extract_chunk(src_wav: Path, dst: Path, start: float, duration: float) -> Path:
    """Découpe un chunk du WAV normalisé (copie PCM, sans réencodage)."""
    ffmpeg, _ = _require()
    dst.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [ffmpeg, "-hide_banner", "-nostdin", "-y", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
         "-i", str(src_wav), "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", str(dst)],
        timeout=600,
    )
    return dst


def export_segment(src: Path, dst: Path, start: float, end: float, fmt: str = "mp3") -> Path:
    """Crée un extrait audio (clip, export de chapitre) en MP3 ou WAV."""
    ffmpeg, _ = _require()
    if end <= start:
        raise FFmpegError("La fin de l'extrait doit être après son début.")
    dst.parent.mkdir(parents=True, exist_ok=True)
    args = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src), "-vn"]
    if fmt == "wav":
        args += ["-c:a", "pcm_s16le"]
    elif fmt == "mp3":
        args += ["-c:a", "libmp3lame", "-q:a", "2"]
    else:
        raise FFmpegError(f"Format d'export non pris en charge : {fmt}")
    args.append(str(dst))
    _run(args, timeout=1800)
    return dst


def wav_data_offset(path: Path) -> int:
    """Position du bloc 'data' dans un WAV (l'en-tête produit par FFmpeg n'a pas toujours 44 octets)."""
    with open(path, "rb") as f:
        head = f.read(4096)
    pos = 12
    while pos + 8 <= len(head):
        chunk_id = head[pos:pos + 4]
        size = int.from_bytes(head[pos + 4:pos + 8], "little")
        if chunk_id == b"data":
            return pos + 8
        pos += 8 + size + (size & 1)
    return 44


def compute_peaks(wav_path: Path, per_second: int = 20, max_points: int = 200_000) -> dict:
    """Calcule les pics (min/max) de la waveform à partir du WAV 16 kHz mono, par lecture mappée en mémoire."""
    offset = wav_data_offset(wav_path)
    data = np.memmap(wav_path, dtype=np.int16, mode="r", offset=offset)
    total = data.shape[0]
    sr = 16000
    duration = total / sr
    points = int(min(max_points, max(1, duration * per_second)))
    win = max(1, total // points)
    usable = win * points
    peaks = np.empty(points, dtype=np.float32)
    step = 2000  # lignes traitées par lot pour limiter la mémoire
    for i in range(0, points, step):
        j = min(points, i + step)
        block = np.asarray(data[i * win: j * win], dtype=np.float32).reshape(j - i, win)
        peaks[i:j] = np.abs(block).max(axis=1)
    if usable == 0:
        peaks = np.zeros(1, dtype=np.float32)
    maxv = float(peaks.max()) or 1.0
    norm = np.round(peaks / maxv, 3)
    return {"duration": duration, "per_second": points / duration if duration else per_second, "peaks": norm.tolist()}


def generate_test_tone(dst: Path, seconds: float = 1.0) -> Path:
    """Génère un court fichier audio (diagnostic)."""
    ffmpeg, _ = _require()
    _run(
        [ffmpeg, "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-ar", "16000", "-ac", "1", str(dst)],
        timeout=60,
    )
    return dst
