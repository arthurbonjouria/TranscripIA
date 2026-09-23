"""Journalisation : fichier tournant + table `logs` pour les messages WARNING et plus.

Règle : ne jamais journaliser le contenu audio, les transcriptions complètes ni les prompts.
"""
from __future__ import annotations

import logging
import logging.handlers

from backend import config


class DbLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            from backend import db

            db.execute(
                "INSERT INTO logs(level, logger, message) VALUES (?, ?, ?)",
                (record.levelname, record.name, self.format(record)[:2000]),
            )
        except Exception:  # la journalisation ne doit jamais faire tomber l'application
            pass


def setup_logging() -> None:
    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    if getattr(root, "_bonjour_configured", False):
        return
    level = getattr(logging, config.LOG_LEVEL, logging.INFO)
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(name)s — %(message)s")

    file_handler = logging.handlers.RotatingFileHandler(
        config.LOGS_DIR / "app.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    db_handler = DbLogHandler(level=logging.WARNING)
    db_handler.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(db_handler)

    for noisy in ("httpx", "httpcore", "faster_whisper", "urllib3", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    root._bonjour_configured = True  # type: ignore[attr-defined]
