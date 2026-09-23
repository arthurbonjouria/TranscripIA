"""Point d'entrée du serveur local (utilisé par START.bat)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn  # noqa: E402

from backend import config  # noqa: E402


def main() -> None:
    config.ensure_dirs()
    pid_file = config.DATA_DIR / "server.pid"
    pid_file.write_text(str(os.getpid()), encoding="ascii")
    try:
        uvicorn.run("backend.app:app", host=config.APP_HOST, port=config.APP_PORT, log_level="warning",
                    access_log=False, timeout_graceful_shutdown=5)
    finally:
        pid_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
