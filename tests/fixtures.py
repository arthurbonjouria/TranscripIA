"""Génération de vrais fichiers audio de test (voix de synthèse Windows, en français).

- meeting.wav : réunion de projet d'environ 3 minutes (décisions, actions, questions, chiffres, dates).
- long.mp3    : fichier long (~25 min) obtenu en concaténant la réunion, pour tester le découpage en chunks.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config  # noqa: E402

OUT = Path(__file__).resolve().parent / "fixtures" / "generated"

MEETING = """
Bonjour à tous, merci d'être présents pour ce point hebdomadaire sur le projet de paiement mobile.
Je suis Sophie, cheffe de projet. Avec moi, Jean, responsable technique, et Marc, du service financier.
Commençons par l'état d'avancement. Jean, où en est l'intégration ?
Merci Sophie. L'intégration de la carte bancaire fonctionne correctement depuis la semaine dernière.
En revanche, Apple Pay ne fonctionne pas correctement sur certains iPhone. Le paiement échoue dans environ quinze pour cent des cas.
C'est un vrai problème. Si nous lançons en l'état, nous risquons de perdre des clients dès le premier jour.
Je propose de corriger ce bug avant toute mise en production.
Nous avons donc décidé de reporter le lancement au douze novembre.
Jean doit contacter le fournisseur de paiement avant vendredi pour obtenir un correctif.
Parlons maintenant du budget. Marc, quelle est la situation ?
Le budget initial était de quarante-cinq mille euros. Nous avons déjà consommé trente mille euros.
Le report du lancement va coûter environ cinq mille euros supplémentaires.
Qui valide ce dépassement de budget ? C'est une question qu'il faudra poser à la direction.
Marc préparera une note budgétaire pour le comité de direction du vingt octobre.
Autre sujet : la communication. Nous avions prévu une campagne pour le lancement.
Il faut décaler la campagne, sinon nous annoncerons un service qui n'est pas prêt.
Sophie se charge de prévenir l'agence de communication cette semaine.
Enfin, une idée intéressante : proposer Google Pay en même temps qu'Apple Pay, ce qui élargirait notre audience.
C'est une opportunité à étudier, mais nous ne l'avons pas encore chiffrée.
Pour résumer : lancement reporté au douze novembre, correctif Apple Pay prioritaire, note budgétaire pour la direction.
La prochaine réunion aura lieu mardi prochain. Merci à tous.
"""


def tts(text: str, dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'fr*' } | Select-Object -First 1; "
        "if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; "
        "$s.Rate = 1; "
        f"$s.SetOutputToWaveFile('{dst}'); "
        "$s.Speak([IO.File]::ReadAllText($env:TTS_TEXT_FILE, [Text.Encoding]::UTF8)); $s.Dispose()"
    )
    txt = dst.with_suffix(".txt")
    txt.write_text(text.strip(), encoding="utf-8")
    import os

    env = {**os.environ, "TTS_TEXT_FILE": str(txt)}
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True, env=env, timeout=600)
    txt.unlink(missing_ok=True)
    return dst


def meeting() -> Path:
    dst = OUT / "meeting.wav"
    if not dst.exists():
        tts(MEETING, dst)
    return dst


def long_file(repeats: int = 8) -> Path:
    dst = OUT / "long.mp3"
    if dst.exists():
        return dst
    src = meeting()
    lst = OUT / "concat.txt"
    lst.write_text("\n".join(f"file '{src.as_posix()}'" for _ in range(repeats)), encoding="utf-8")
    subprocess.run([config.FFMPEG_PATH, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-c:a", "libmp3lame", "-q:a", "5", str(dst)], check=True, capture_output=True)
    lst.unlink(missing_ok=True)
    return dst


if __name__ == "__main__":
    print(meeting())
    print(long_file())
