"""Configuration des tests : base et dossier de données temporaires, vrais fichiers audio de synthèse."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_TMP = Path(tempfile.mkdtemp(prefix="bonjouria-tests-"))
os.environ["DATA_DIR"] = str(_TMP)

from backend import config  # noqa: E402

config.MODELS_DIR = Path(os.environ.get("E2E_MODELS", r"C:\TranscripIA-data\models"))

H = {"X-Requested-With": "BonjourIA"}


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from backend.app import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def meeting_wav():
    from tests import fixtures

    return fixtures.meeting()


@pytest.fixture(scope="session")
def long_mp3():
    from tests import fixtures

    return fixtures.long_file()


def ollama_ready() -> bool:
    from backend import settings
    from backend.services import ollama_service

    return ollama_service.status()["available"] and ollama_service.has_model(settings.get("ollama.model"))
