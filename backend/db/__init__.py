"""Accès SQLite : une connexion par thread, requêtes toujours paramétrées."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

from backend import config

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
SCHEMA_VERSION = 1

_local = threading.local()
_db_path: Path = config.DB_PATH

DEFAULT_HIGHLIGHT_CATEGORIES = [
    ("Client", "#E83967"),
    ("Business", "#2D2D2D"),
    ("Technique", "#6B7A8F"),
    ("Important", "#C8A24A"),
    ("Urgent", "#C0392B"),
    ("À vérifier", "#B1ADA1"),
]


def set_db_path(path: Path) -> None:
    """Utilisé par les tests pour pointer vers une base temporaire."""
    global _db_path
    close()
    _db_path = path


def _dict_factory(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "path", None) != _db_path:
        _db_path.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(_db_path, timeout=30, check_same_thread=False)
        c.row_factory = _dict_factory
        c.execute("PRAGMA foreign_keys = ON")
        c.execute("PRAGMA journal_mode = WAL")
        c.execute("PRAGMA synchronous = NORMAL")
        c.execute("PRAGMA busy_timeout = 30000")
        _local.conn = c
        _local.path = _db_path
    return c


def close() -> None:
    c = getattr(_local, "conn", None)
    if c is not None:
        c.close()
        _local.conn = None


def init_db() -> None:
    c = conn()
    c.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    row = c.execute("SELECT version FROM schema_version").fetchone()
    if row is None:
        c.execute("INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
    for name, color in DEFAULT_HIGHLIGHT_CATEGORIES:
        c.execute(
            "INSERT OR IGNORE INTO highlight_categories(name, color, is_system) VALUES (?, ?, 0)",
            (name, color),
        )
    c.commit()


def all(sql: str, params: Iterable[Any] = ()) -> list[dict]:
    return conn().execute(sql, tuple(params)).fetchall()


def one(sql: str, params: Iterable[Any] = ()) -> dict | None:
    return conn().execute(sql, tuple(params)).fetchone()


def scalar(sql: str, params: Iterable[Any] = ()) -> Any:
    row = conn().execute(sql, tuple(params)).fetchone()
    if row is None:
        return None
    return next(iter(row.values()))


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    """Exécute et valide ; retourne lastrowid."""
    c = conn()
    cur = c.execute(sql, tuple(params))
    c.commit()
    return cur.lastrowid


@contextmanager
def transaction():
    """Transaction explicite : tout ou rien. Garantit qu'une analyse qui échoue n'efface rien."""
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        yield c
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise


def insert(table: str, data: dict, c: sqlite3.Connection | None = None) -> int:
    # `table` et les colonnes proviennent toujours du code, jamais de l'utilisateur.
    cols = ", ".join(data.keys())
    marks = ", ".join("?" for _ in data)
    target = c or conn()
    cur = target.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(data.values()))
    if c is None:
        target.commit()
    return cur.lastrowid


def update(table: str, row_id: int, data: dict, c: sqlite3.Connection | None = None) -> None:
    if not data:
        return
    sets = ", ".join(f"{k} = ?" for k in data)
    target = c or conn()
    target.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*data.values(), row_id))
    if c is None:
        target.commit()


def jloads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def jdumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
