"""Tests IA réels avec Ollama / Qwen : chapitres, highlights, résumé, actions, décisions, chat avec sources.

Ignorés automatiquement si Ollama ou le modèle configuré ne sont pas disponibles.
Durée indicative sur un i5 + GTX 1650 : 8 à 12 minutes.
"""
from __future__ import annotations

import json
import time

import pytest

from tests.conftest import H, ollama_ready

pytestmark = pytest.mark.skipif(not ollama_ready(), reason="Ollama ou le modèle Qwen n'est pas disponible")


def test_ollama_generation():
    from backend.services import ollama_service

    r = ollama_service.quick_test()
    assert r["answer"]


def test_json_parsing_tolerant():
    from backend.services.ollama_service import parse_json

    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json('<think>x</think> Voici : {"b": [1, 2]} merci') == {"b": [1, 2]}


@pytest.fixture(scope="module")
def analyzed(client, meeting_wav):
    client.put("/api/settings", json={"values": {"analysis.auto_run": True}}, headers=H)
    with open(meeting_wav, "rb") as f:
        up = client.post("/api/audio/upload", files={"file": ("Réunion IA.wav", f, "audio/wav")}, data={"language": "fr"},
                         headers=H).json()
    deadline = time.time() + 2400
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{up['job_id']}").json()
        if j["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(3)
    assert j["status"] == "COMPLETED" and not j["error"], j
    return up


def test_chapters_generated(client, analyzed):
    ch = client.get(f"/api/audio/{analyzed['id']}/chapters").json()["chapters"]
    assert ch and ch[0]["start"] == 0
    assert all(c["title"] for c in ch)


def test_insights_generated(client, analyzed):
    ins = client.get(f"/api/audio/{analyzed['id']}/insights").json()
    assert ins["decisions"], "aucune décision détectée"
    assert ins["actions"], "aucune action détectée"
    owners = " ".join(a["owner"] for a in ins["actions"]).lower()
    assert any(n in owners for n in ("jean", "marc", "sophie"))
    assert ins["highlights"]
    assert all(0 <= h["importance"] <= 1 for h in ins["highlights"])
    assert any(e["type"] in ("amount", "percentage") for e in ins["entities"])
    assert all(r["kind"] in ("fact", "inference") for r in ins["risks"])


def test_summary_generated_and_cached(client, analyzed):
    s = client.get(f"/api/audio/{analyzed['id']}/summary").json()
    assert s["summary"]["tldr"] and s["summary"]["short"]
    v1 = s["meta"]["version"]
    # modification manuelle → nouvelle version, l'ancienne est conservée
    client.put(f"/api/audio/{analyzed['id']}/summary", json={"content": {"tldr": "Résumé corrigé."}}, headers=H)
    s2 = client.get(f"/api/audio/{analyzed['id']}/summary").json()
    assert s2["summary"]["tldr"] == "Résumé corrigé." and s2["meta"]["version"] == v1 + 1
    assert len(s2["history"]) >= 2


def test_chat_with_sources(client, analyzed):
    events = []
    with client.stream("POST", f"/api/audio/{analyzed['id']}/chat", json={"question": "Quelle décision a été prise sur le lancement ?"},
                       headers=H) as r:
        for line in r.iter_lines():
            if line:
                events.append(json.loads(line))
    done = next(e for e in events if e["type"] == "done")
    assert "novembre" in done["text"].lower() or "report" in done["text"].lower()
    assert done["sources"], "aucune source citée"
    assert all("start" in s for s in done["sources"])
