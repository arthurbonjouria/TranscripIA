"""API — diagnostic, paramètres, modèles, prompts, journaux, stockage."""
from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend import config, db, settings
from backend.services import (diagnostic_service, ollama_service, prompt_service, storage_service, whisper_service)

router = APIRouter()


@router.get("/health")
def health(deep: bool = False):
    return diagnostic_service.run(deep=deep)


@router.get("/ping")
def ping():
    return {"ok": True, "app": "BONJOUR IA — Audio Intelligence Workspace", "version": "1.0.0"}


@router.get("/settings")
def get_settings():
    return {
        "values": settings.get_all(),
        "whisper_models": [{"name": m, "size_mb": whisper_service.MODEL_SIZES_MB.get(m),
                            "downloaded": whisper_service.is_model_downloaded(m)} for m in whisper_service.AVAILABLE_MODELS],
        "cuda": whisper_service.cuda_status(),
        "profiles": [{"key": k, **v, "downloaded": whisper_service.is_model_downloaded(v["model"])}
                     for k, v in whisper_service.PROFILES.items()],
        "paths": {"data": str(config.DATA_DIR), "prompts": str(config.PROMPTS_DIR), "ffmpeg": config.FFMPEG_PATH,
                  "models": str(config.MODELS_DIR), "cloud_synced": config.is_cloud_synced(config.DATA_DIR)},
        "allowed_extensions": sorted(config.ALLOWED_EXTENSIONS),
    }


class SettingsBody(BaseModel):
    values: dict
    confirm_download: bool = False


@router.put("/settings")
def put_settings(body: SettingsBody):
    new_model = body.values.get("whisper.model")
    if new_model:
        if new_model not in whisper_service.AVAILABLE_MODELS:
            raise ValueError("Modèle Whisper inconnu.")
        if not whisper_service.is_model_downloaded(new_model) and not body.confirm_download:
            raise ValueError(f"Le modèle « {new_model} » (~{whisper_service.MODEL_SIZES_MB.get(new_model)} Mo) n'est pas "
                             "encore téléchargé. Confirmez le téléchargement pour l'utiliser.")
    if "ollama.url" in body.values:
        url = str(body.values["ollama.url"]).rstrip("/")
        import re

        if not re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", url):
            raise ValueError("L'URL d'Ollama doit pointer vers la machine locale.")
        body.values["ollama.url"] = url
    vals = settings.set_many(body.values)
    whisper_service.unload()  # prise en compte au prochain traitement
    return {"values": vals}


@router.get("/models")
def models():
    out = {"ollama": {"available": False, "models": [], "current": settings.get("ollama.model"),
                      "embed": settings.get("ollama.embed_model")}}
    st = ollama_service.status()
    out["ollama"]["available"] = st["available"]
    out["ollama"]["version"] = st.get("version")
    if st["available"]:
        try:
            out["ollama"]["models"] = ollama_service.list_models()
        except ollama_service.OllamaError as exc:
            out["ollama"]["error"] = str(exc)
    out["whisper"] = {"current": settings.get("whisper.model"), "device": "/".join(whisper_service.resolve_device()),
                      "models": [{"name": m, "size_mb": whisper_service.MODEL_SIZES_MB.get(m),
                                  "downloaded": whisper_service.is_model_downloaded(m)}
                                 for m in whisper_service.AVAILABLE_MODELS]}
    return out


class PullBody(BaseModel):
    name: str
    confirm: bool = False


@router.post("/models/pull")
def pull_model(body: PullBody):
    """Téléchargement d'un modèle Ollama : uniquement sur confirmation explicite de l'utilisateur."""
    if not body.confirm:
        raise ValueError("Le téléchargement d'un modèle doit être confirmé explicitement.")

    def gen():
        try:
            for ev in ollama_service.pull(body.name.strip()):
                yield json.dumps(ev) + "\n"
        except Exception as exc:
            yield json.dumps({"error": str(exc)}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.post("/models/test")
def test_model():
    return diagnostic_service.check_llm_generation()


@router.get("/prompts")
def prompts():
    return prompt_service.list_prompts()


@router.get("/logs")
def logs(level: str = "", limit: int = 100):
    if level:
        return db.all("SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?", (level.upper(), min(limit, 500)))
    return db.all("SELECT * FROM logs ORDER BY id DESC LIMIT ?", (min(limit, 500),))


@router.get("/storage")
def storage():
    return storage_service.disk_usage()
