"""Chargement des prompts depuis le dossier /prompts (jamais codés en dur)."""
from __future__ import annotations

import re

from backend.config import PROMPTS_DIR

LANG_NAMES = {"fr": "français", "en": "anglais", "es": "espagnol", "de": "allemand", "it": "italien",
              "pt": "portugais", "nl": "néerlandais"}


class Prompt:
    def __init__(self, name: str, version: str, system: str, user: str):
        self.name, self.version, self.system, self.user = name, version, system, user

    def render(self, **values) -> list[dict]:
        def sub(text: str) -> str:
            return re.sub(r"\{\{(\w+)\}\}", lambda m: str(values.get(m.group(1), "")), text)

        return [{"role": "system", "content": sub(self.system).strip()},
                {"role": "user", "content": sub(self.user).strip()}]


def load(name: str) -> Prompt:
    if not re.fullmatch(r"[a-z_]+", name):
        raise ValueError("Nom de prompt invalide")
    raw = (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")
    version = "0"
    m = re.match(r"version:\s*([\w.]+)\s*\n", raw)
    if m:
        version = m.group(1)
        raw = raw[m.end():]
    system, user = "", raw
    if "---system---" in raw:
        _, rest = raw.split("---system---", 1)
        system, user = rest.split("---user---", 1)
    return Prompt(name, version, system, user)


def list_prompts() -> list[dict]:
    out = []
    for p in sorted(PROMPTS_DIR.glob("*.md")):
        if p.stem == "README":
            continue
        pr = load(p.stem)
        out.append({"name": p.stem, "version": pr.version, "path": str(p)})
    return out


def language_name(code: str | None) -> str:
    return LANG_NAMES.get((code or "fr")[:2], "français")
