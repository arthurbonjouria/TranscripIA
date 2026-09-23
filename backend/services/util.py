"""Petites fonctions partagées."""
from __future__ import annotations

import difflib
import re
import unicodedata


def fmt_time(seconds: float | None, force_hours: bool = False) -> str:
    if seconds is None:
        return "--:--"
    s = int(max(0, seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h or force_hours:
        return f"{h:02d}:{m:02d}:{sec:02d}"
    return f"{m:02d}:{sec:02d}"


def fmt_srt_time(seconds: float, sep: str = ",") -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def normalize_text(text: str) -> str:
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def similar(a: str, b: str, threshold: float = 0.82) -> bool:
    na, nb = normalize_text(a), normalize_text(b)
    if not na or not nb:
        return False
    if na == nb or na in nb or nb in na:
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() >= threshold


def dedupe(items: list[dict], key: str = "text", threshold: float = 0.82) -> list[dict]:
    out: list[dict] = []
    for it in items:
        if not any(similar(it.get(key, ""), o.get(key, ""), threshold) for o in out):
            out.append(it)
    return out


FRENCH_STOPWORDS = set("""
a à au aux avec ce ces cet cette ceux chez comme dans de des du elle elles en est et être eu il ils je la le les leur
leurs lui ma mais me même mes moi mon ne nos notre nous on ou où par pas pour qu que qui sa se ses son sur ta te tes
toi ton tu un une vos votre vous y été était sont ont avait avoir fait faire dit dire quel quelle quels quelles
quoi comment pourquoi quand est-ce estce ça cela ceci plus moins très bien aussi alors donc ainsi tout tous toute
toutes rien peu été sera seront peut peuvent doit doivent the of and to is in what who how
""".split())


def keywords(text: str, max_terms: int = 12) -> list[str]:
    words = re.findall(r"[\wÀ-ÿ'-]{2,}", (text or "").lower())
    out = []
    for w in words:
        w = w.strip("'-")
        if len(w) < 3 or w in FRENCH_STOPWORDS or w in out:
            continue
        out.append(w)
    return out[:max_terms]


def fts_query(text: str) -> str:
    """Construit une requête FTS5 sûre (termes entre guillemets, combinés par OR)."""
    terms = keywords(text)
    if not terms:
        terms = [w for w in re.findall(r"[\wÀ-ÿ]{2,}", text or "")][:8]
    return " OR ".join('"' + t.replace('"', "") + '"*' for t in terms)
