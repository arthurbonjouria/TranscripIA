"""BONJOUR IA — Audio Intelligence Workspace · serveur local (FastAPI)."""
from __future__ import annotations

import logging
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import config, db
from backend.logging_setup import setup_logging

log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    setup_logging()
    db.init_db()
    from backend.jobs import manager

    manager.start_workers()
    log.info("Serveur prêt sur http://%s:%s — données : %s", config.APP_HOST, config.APP_PORT, config.DATA_DIR)
    if config.is_cloud_synced(config.DATA_DIR):
        log.warning("Le dossier de données %s semble synchronisé dans le cloud.", config.DATA_DIR)
    yield
    manager.stop_workers()


app = FastAPI(title="BONJOUR IA — Audio Intelligence Workspace", version="1.0.0", lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")  # Swagger désactivé : il dépend d'un CDN

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "testserver"}  # testserver : client de tests automatisés


@app.middleware("http")
async def security(request: Request, call_next):
    """Protection CSRF / DNS rebinding : l'API n'accepte que des requêtes émises par l'application elle-même."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    if host and host not in _LOCAL_HOSTS:
        return JSONResponse({"error": "Hôte non autorisé."}, status_code=403)
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin:
            o_host = origin.split("://", 1)[-1].rsplit(":", 1)[0]
            if o_host not in _LOCAL_HOSTS:
                return JSONResponse({"error": "Origine non autorisée."}, status_code=403)
        if request.headers.get("x-requested-with") != "BonjourIA":
            return JSONResponse({"error": "Requête refusée (en-tête de sécurité manquant)."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'")
    return response


# --------------------------------------------------------------------------- erreurs lisibles

def _err(status: int, message: str, detail: str | None = None) -> JSONResponse:
    return JSONResponse({"error": message, "detail": detail}, status_code=status)


@app.exception_handler(KeyError)
async def _not_found(_, exc: KeyError):
    return _err(404, str(exc.args[0]) if exc.args else "Élément introuvable.")


@app.exception_handler(ValueError)
async def _bad_request(_, exc: ValueError):
    return _err(400, str(exc))


@app.exception_handler(Exception)
async def _server_error(_, exc: Exception):
    from backend.services.ffmpeg_service import FFmpegError
    from backend.services.ollama_service import OllamaError
    from backend.services.storage_service import UploadError
    from backend.services.whisper_service import WhisperError

    if isinstance(exc, UploadError):
        return _err(400, str(exc))
    if isinstance(exc, FFmpegError):
        return _err(422, "Le fichier audio n'a pas pu être lu.", str(exc))
    if isinstance(exc, OllamaError):
        return _err(503, str(exc))
    if isinstance(exc, WhisperError):
        return _err(500, "Whisper a rencontré un problème.", str(exc))
    log.error("Erreur inattendue : %s", exc)
    return _err(500, "Une erreur inattendue est survenue.", "".join(traceback.format_exception_only(exc)).strip())


# --------------------------------------------------------------------------- routes

from backend.api import analysis, annotations, audio, chat, export, jobs, search, system  # noqa: E402

for module in (audio, analysis, annotations, search, chat, export, jobs, system):
    app.include_router(module.router, prefix="/api")

app.mount("/static", StaticFiles(directory=config.FRONTEND_DIR), name="static")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(config.FRONTEND_DIR / "img" / "favicon.png")


@app.get("/", include_in_schema=False)
@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str = ""):
    if path.startswith("api/"):
        return _err(404, "Point d'API inconnu.")
    return FileResponse(config.FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-cache"})
