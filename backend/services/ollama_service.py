"""OllamaService — accès au LLM local (Qwen) et aux embeddings. Aucune donnée ne quitte la machine."""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Callable, Iterator

import httpx

from backend import settings

log = logging.getLogger("ollama")


class OllamaError(RuntimeError):
    pass


def _url(path: str) -> str:
    base = settings.get("ollama.url").rstrip("/")
    if not re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", base):
        # Garde-fou : l'application ne doit parler qu'à un Ollama local.
        raise OllamaError("L'URL d'Ollama doit pointer vers la machine locale (127.0.0.1 ou localhost).")
    return base + path


def status(timeout: float = 3.0) -> dict:
    try:
        r = httpx.get(_url("/api/version"), timeout=timeout)
        r.raise_for_status()
        return {"available": True, "version": r.json().get("version", "")}
    except OllamaError as exc:
        return {"available": False, "version": "", "error": str(exc)}
    except Exception as exc:
        return {"available": False, "version": "", "error": f"Ollama ne répond pas ({exc.__class__.__name__})."}


def list_models() -> list[dict]:
    try:
        r = httpx.get(_url("/api/tags"), timeout=5)
        r.raise_for_status()
    except Exception as exc:
        raise OllamaError(f"Impossible de lister les modèles Ollama : {exc}") from exc
    running = {}
    try:
        ps = httpx.get(_url("/api/ps"), timeout=5).json().get("models", [])
        running = {m["name"]: m for m in ps}
    except Exception:
        pass
    out = []
    for m in r.json().get("models", []):
        d = m.get("details", {})
        out.append({
            "name": m["name"], "size": m.get("size", 0), "modified_at": m.get("modified_at", ""),
            "family": d.get("family", ""), "parameters": d.get("parameter_size", ""),
            "quantization": d.get("quantization_level", ""), "loaded": m["name"] in running,
            "is_embedding": "embed" in m["name"] or d.get("family", "") in ("nomic-bert", "bert"),
        })
    return out


def has_model(name: str) -> bool:
    try:
        names = {m["name"] for m in list_models()}
    except OllamaError:
        return False
    return name in names or f"{name}:latest" in names


def _options(max_tokens: int | None = None, temperature: float | None = None, num_ctx: int | None = None) -> dict:
    return {
        "temperature": settings.get("ollama.temperature") if temperature is None else temperature,
        "num_ctx": num_ctx or settings.get("ollama.num_ctx"),
        "num_predict": max_tokens or settings.get("ollama.max_tokens"),
    }


def _strip_think(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()


def chat(
    messages: list[dict],
    *,
    json_mode: bool = False,
    schema: dict | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    num_ctx: int | None = None,
    should_stop: Callable[[], bool] | None = None,
    on_token: Callable[[str], None] | None = None,
) -> str:
    """Appel bloquant (streamé en interne pour permettre l'annulation et la progression)."""
    payload: dict[str, Any] = {
        "model": settings.get("ollama.model"),
        "messages": messages,
        "stream": True,
        "think": False,  # Qwen3 : pas de raisonnement caché, réponses plus rapides
        "options": _options(max_tokens, temperature, num_ctx),
        "keep_alive": "10m",
    }
    if schema:
        payload["format"] = schema
    elif json_mode:
        payload["format"] = "json"
    parts: list[str] = []
    try:
        with httpx.stream("POST", _url("/api/chat"), json=payload,
                          timeout=httpx.Timeout(settings.get("ollama.timeout"), connect=5)) as r:
            if r.status_code >= 400:
                body = r.read().decode("utf-8", "replace")
                raise OllamaError(f"Ollama a refusé la requête ({r.status_code}) : {body[:300]}")
            for line in r.iter_lines():
                if not line:
                    continue
                if should_stop and should_stop():
                    raise InterruptedError("Analyse annulée.")
                chunk = json.loads(line)
                if chunk.get("error"):
                    raise OllamaError(chunk["error"])
                token = chunk.get("message", {}).get("content", "")
                if token:
                    parts.append(token)
                    if on_token:
                        on_token(token)
                if chunk.get("done"):
                    break
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise OllamaError("Ollama n'est pas démarré. Lancez l'application Ollama puis réessayez.") from exc
    except httpx.ReadTimeout as exc:
        raise OllamaError("Le modèle a mis trop de temps à répondre (délai dépassé).") from exc
    return _strip_think("".join(parts))


def chat_stream(messages: list[dict], max_tokens: int | None = None, temperature: float | None = None,
                num_ctx: int | None = None) -> Iterator[str]:
    """Générateur de tokens pour le chat en direct."""
    payload = {
        "model": settings.get("ollama.model"), "messages": messages, "stream": True, "think": False,
        "options": _options(max_tokens, temperature, num_ctx), "keep_alive": "10m",
    }
    try:
        with httpx.stream("POST", _url("/api/chat"), json=payload,
                          timeout=httpx.Timeout(settings.get("ollama.timeout"), connect=5)) as r:
            if r.status_code >= 400:
                raise OllamaError(f"Ollama a refusé la requête ({r.status_code}).")
            in_think = False
            for line in r.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                if chunk.get("error"):
                    raise OllamaError(chunk["error"])
                token = chunk.get("message", {}).get("content", "")
                if "<think>" in token:
                    in_think = True
                if in_think:
                    if "</think>" in token:
                        in_think = False
                    continue
                if token:
                    yield token
                if chunk.get("done"):
                    break
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise OllamaError("Ollama n'est pas démarré. Lancez l'application Ollama puis réessayez.") from exc


def parse_json(text: str) -> Any:
    """Tolère les blocs ```json et le texte parasite autour de l'objet JSON."""
    t = _strip_think(text)
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t.strip())
    try:
        return json.loads(t)
    except ValueError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        a, b = t.find(opener), t.rfind(closer)
        if a != -1 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except ValueError:
                continue
    raise OllamaError("La réponse du modèle n'est pas un JSON valide.")


def chat_json(messages: list[dict], schema: dict | None = None, retries: int = 1, **kw) -> Any:
    last: Exception | None = None
    for attempt in range(retries + 1):
        text = chat(messages, json_mode=schema is None, schema=schema, **kw)
        try:
            return parse_json(text)
        except OllamaError as exc:
            last = exc
            log.warning("JSON invalide renvoyé par le modèle (tentative %s)", attempt + 1)
    raise last  # type: ignore[misc]


def unload(model: str | None = None) -> None:
    """Libère la mémoire (RAM/VRAM) occupée par le modèle — utile avant une transcription."""
    try:
        httpx.post(_url("/api/generate"), json={"model": model or settings.get("ollama.model"), "keep_alive": 0},
                   timeout=30)
    except Exception:
        pass


def embed(texts: list[str], model: str | None = None) -> list[list[float]]:
    model = model or settings.get("ollama.embed_model")
    try:
        r = httpx.post(_url("/api/embed"), json={"model": model, "input": texts}, timeout=600)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise OllamaError("Ollama n'est pas démarré.") from exc
    if r.status_code >= 400:
        raise OllamaError(f"Le modèle d'embeddings « {model} » n'est pas disponible ({r.status_code}).")
    return r.json().get("embeddings", [])


def quick_test() -> dict:
    t = time.time()
    text = chat([{"role": "user", "content": "Réponds uniquement par le mot : OK"}], max_tokens=10, num_ctx=2048)
    return {"ok": "ok" in text.lower(), "answer": text[:80], "seconds": round(time.time() - t, 1)}


def pull(model: str) -> Iterator[dict]:
    """Télécharge un modèle — appelé uniquement après confirmation explicite de l'utilisateur."""
    if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,120}", model):
        raise OllamaError("Nom de modèle invalide.")
    with httpx.stream("POST", _url("/api/pull"), json={"model": model, "stream": True}, timeout=None) as r:
        for line in r.iter_lines():
            if line:
                yield json.loads(line)
