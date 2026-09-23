"""Réglages modifiables à chaud, persistés dans la table `settings`."""
from __future__ import annotations

import json
from typing import Any

from backend import db
from backend.config import DEFAULT_SETTINGS


def _coerce(value: Any, kind: type) -> Any:
    if kind is bool:
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "oui", "yes", "on")
        return bool(value)
    return kind(value)


def get(key: str) -> Any:
    default, kind = DEFAULT_SETTINGS[key]
    row = db.one("SELECT value FROM settings WHERE key = ?", (key,))
    if row is None:
        return default
    try:
        return _coerce(json.loads(row["value"]), kind)
    except (ValueError, TypeError):
        return default


def get_all() -> dict[str, Any]:
    stored = {r["key"]: r["value"] for r in db.all("SELECT key, value FROM settings")}
    out: dict[str, Any] = {}
    for key, (default, kind) in DEFAULT_SETTINGS.items():
        if key in stored:
            try:
                out[key] = _coerce(json.loads(stored[key]), kind)
                continue
            except (ValueError, TypeError):
                pass
        out[key] = default
    return out


def set_many(values: dict[str, Any]) -> dict[str, Any]:
    unknown = [k for k in values if k not in DEFAULT_SETTINGS]
    if unknown:
        raise ValueError(f"Réglages inconnus : {', '.join(unknown)}")
    for key, value in values.items():
        _, kind = DEFAULT_SETTINGS[key]
        coerced = _coerce(value, kind)
        db.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(coerced)),
        )
    return get_all()


def reset(key: str) -> None:
    db.execute("DELETE FROM settings WHERE key = ?", (key,))
