"""WhisperService — transcription locale via faster-whisper (CTranslate2)."""
from __future__ import annotations

import gc
import logging
import math
import threading
from pathlib import Path
from typing import Callable

from backend import config, settings

log = logging.getLogger("whisper")

AVAILABLE_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "distil-large-v3"]
MODEL_SIZES_MB = {"tiny": 75, "base": 145, "small": 484, "medium": 1530, "large-v3": 3100,
                  "large-v3-turbo": 1620, "distil-large-v3": 1510}

# Profils de transcription (mesurés sur i5-10300H, CPU int8, podcast français) :
#   rapide    : base,  beam 1, par lots — ×21 temps réel (45 min ≈ 2 min), qualité correcte
#   equilibre : small, beam 1, par lots — ×7 temps réel  (45 min ≈ 6 min), bonne qualité (défaut)
#   precis    : small, beam 5, séquentiel — ×2,8 temps réel (45 min ≈ 16 min)
#   perso     : réglages détaillés des paramètres
PROFILES = {
    "rapide": {"model": "base", "beam": 1, "batched": True, "label": "Rapide"},
    "equilibre": {"model": "small", "beam": 1, "batched": True, "label": "Équilibré"},
    "precis": {"model": "small", "beam": 5, "batched": False, "label": "Précis"},
}

_lock = threading.Lock()
_model = None
_model_key: tuple | None = None


class WhisperError(RuntimeError):
    pass


def cuda_status() -> dict:
    try:
        import ctranslate2

        count = ctranslate2.get_cuda_device_count()
        if count > 0:
            return {"available": True, "devices": count, "reason": ""}
        return {"available": False, "devices": 0, "reason": "Aucun GPU CUDA utilisable par CTranslate2."}
    except Exception as exc:  # pilote trop ancien, bibliothèques CUDA absentes…
        return {"available": False, "devices": 0, "reason": str(exc)}


def resolve_device() -> tuple[str, str]:
    device = settings.get("whisper.device")
    compute = settings.get("whisper.compute_type")
    if device == "auto":
        device = "cuda" if cuda_status()["available"] else "cpu"
    if compute == "auto":
        compute = "int8_float16" if device == "cuda" else "int8"
    return device, compute


def is_model_downloaded(name: str) -> bool:
    target = config.MODELS_DIR / f"models--Systran--faster-whisper-{name}"
    if name == "large-v3-turbo":
        target = config.MODELS_DIR / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo"
    if name == "distil-large-v3":
        target = config.MODELS_DIR / "models--Systran--faster-distil-whisper-large-v3"
    return any(target.glob("snapshots/*/model.bin")) if target.exists() else False


def resolve_profile(profile: str | None = None) -> dict:
    name = profile or settings.get("whisper.profile")
    if name in PROFILES:
        return {**PROFILES[name], "profile": name}
    return {"model": settings.get("whisper.model"), "beam": settings.get("whisper.beam_size"),
            "batched": settings.get("whisper.batched"), "label": "Personnalisé", "profile": "perso"}


def get_model(name: str | None = None):
    """Charge le modèle une seule fois (et le recharge si les réglages changent)."""
    global _model, _model_key
    name = name or resolve_profile()["model"]
    device, compute = resolve_device()
    key = (name, device, compute)
    with _lock:
        if _model is not None and _model_key == key:
            return _model
        unload()
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise WhisperError("faster-whisper n'est pas installé (pip install faster-whisper).") from exc
        log.info("Chargement du modèle Whisper %s (%s, %s)", name, device, compute)
        try:
            _model = WhisperModel(name, device=device, compute_type=compute, download_root=str(config.MODELS_DIR),
                                  cpu_threads=0)
        except Exception as exc:
            if device == "cuda":
                log.warning("Échec du chargement sur GPU (%s), repli sur le CPU.", exc)
                _model = WhisperModel(name, device="cpu", compute_type="int8", download_root=str(config.MODELS_DIR))
                key = (name, "cpu", "int8")
            else:
                raise WhisperError(f"Impossible de charger le modèle Whisper « {name} » : {exc}") from exc
        _model_key = key
        return _model


def current_device() -> str:
    return _model_key[1] if _model_key else resolve_device()[0]


def unload() -> None:
    global _model, _model_key
    _model = None
    _model_key = None
    gc.collect()


def split_sentences(seg: dict, max_len: float = 12.0) -> list[dict]:
    """Le décodage par lots produit des segments d'environ 30 s. On les redécoupe en phrases pour une navigation
    précise : horodatages issus des mots quand ils existent, sinon répartis au prorata du nombre de caractères."""
    import re

    dur = seg["end"] - seg["start"]
    if dur <= max_len:
        return [seg]
    words = seg.pop("_words", None)
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+", seg["text"]) if p.strip()]
    if len(parts) < 2:
        return [seg]
    out = []
    if words:
        wi = 0
        for part in parts:
            n = len(part.split())
            chunk = words[wi:wi + n] or words[-1:]
            wi += n
            out.append({**seg, "start": round(chunk[0][0], 3), "end": round(chunk[-1][1], 3), "text": part})
    else:
        total = sum(len(p) for p in parts) or 1
        t = seg["start"]
        for part in parts:
            d = dur * len(part) / total
            out.append({**seg, "start": round(t, 3), "end": round(t + d, 3), "text": part})
            t += d
    # regroupe les phrases très courtes avec la suivante (« Oui. », « Ah ouais ? »)
    merged: list[dict] = []
    for o in out:
        if merged and (merged[-1]["end"] - merged[-1]["start"] < 2.5 or len(merged[-1]["text"]) < 25):
            merged[-1] = {**merged[-1], "end": o["end"], "text": f"{merged[-1]['text']} {o['text']}"}
        else:
            merged.append(o)
    merged[0]["start"] = seg["start"]
    merged[-1]["end"] = seg["end"]
    return merged


def transcribe_file(
    path: Path,
    language: str | None = None,
    on_segment: Callable[[dict], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    profile: str | None = None,
) -> dict:
    """Transcrit un fichier (un chunk). Les timestamps retournés sont relatifs au fichier."""
    prof = resolve_profile(profile)
    model = get_model(prof["model"])
    lang = language or settings.get("whisper.language") or None
    try:
        if prof["batched"]:
            # Inférence par lots : les passages de parole détectés par le VAD sont décodés en parallèle
            from faster_whisper import BatchedInferencePipeline

            segments, info = BatchedInferencePipeline(model=model).transcribe(
                str(path), language=lang, beam_size=prof["beam"], batch_size=settings.get("whisper.batch_size"),
                vad_filter=True, word_timestamps=settings.get("whisper.word_timestamps"),
            )
        else:
            segments, info = model.transcribe(
                str(path),
                language=lang,
                beam_size=prof["beam"],
                vad_filter=settings.get("whisper.vad"),
                vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False,  # limite les hallucinations en boucle sur les longs fichiers
            )
        out = []
        for s in segments:
            if should_stop and should_stop():
                raise InterruptedError("Transcription interrompue.")
            text = s.text.strip()
            if not text:
                continue
            seg = {
                "start": round(float(s.start), 3),
                "end": round(float(s.end), 3),
                "text": text,
                "speaker": None,
                "confidence": round(min(1.0, math.exp(s.avg_logprob)), 3),
            }
            if getattr(s, "words", None):
                seg["_words"] = [(float(w.start), float(w.end)) for w in s.words]
            for part in split_sentences(seg):
                part.pop("_words", None)
                out.append(part)
            if on_segment:
                on_segment(out[-1])
    except InterruptedError:
        raise
    except Exception as exc:
        raise WhisperError(f"Whisper a rencontré un problème pendant la transcription : {exc}") from exc
    return {"segments": out, "language": info.language, "language_probability": float(info.language_probability),
            "duration": float(info.duration)}


def detect_language(path: Path) -> tuple[str, float]:
    model = get_model()
    _, info = model.transcribe(str(path), beam_size=1, vad_filter=True)
    return info.language, float(info.language_probability)
