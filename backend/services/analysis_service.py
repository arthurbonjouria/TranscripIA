"""Analyse IA d'un audio — pipeline map-reduce pensé pour les très longs enregistrements.

1. MAP     : la transcription est découpée en blocs (~8 min). Chaque bloc est analysé une fois
             (résumé, chapitres candidats, highlights, actions, décisions, questions, risques, personnes, entités).
             Les résultats sont sauvegardés bloc par bloc : un job interrompu reprend où il s'était arrêté.
2. INSIGHTS: agrégation + dédoublonnage, sans LLM (rapide), écriture atomique dans les tables.
3. CHAPTERS: consolidation des chapitres candidats en chapitres définitifs (1 appel LLM).
4. SUMMARY : fiche de synthèse (1 appel LLM sur les résumés de blocs, jamais sur la transcription entière).

Chaque étape est indépendante : si l'une échoue, les résultats déjà produits restent intacts.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Callable

from backend import db, settings
from backend.services import analysis_store, ollama_service, prompt_service, transcription_service
from backend.services.util import dedupe, fmt_time, normalize_text, similar

log = logging.getLogger("analysis")

HIGHLIGHT_CATEGORIES = ["décision", "action", "information", "question", "idée", "opportunité", "risque",
                        "citation", "date", "chiffre"]
_CATEGORY_ALIASES = {"decision": "décision", "idee": "idée", "opportunite": "opportunité", "risk": "risque",
                     "quote": "citation", "number": "chiffre", "figure": "chiffre", "info": "information"}

Progress = Callable[[float, str], None]
Stop = Callable[[], bool]


# --------------------------------------------------------------------------- blocs

def build_blocks(segments: list[dict], block_minutes: int, max_words: int = 1700) -> list[dict]:
    blocks: list[dict] = []
    cur: list[dict] = []
    words = 0
    limit = max(60, block_minutes * 60)
    for s in segments:
        w = len(s["text"].split())
        if cur and (s["start"] - cur[0]["start"] >= limit or words + w > max_words):
            blocks.append({"segments": cur, "start": cur[0]["start"], "end": cur[-1]["end"]})
            cur, words = [], 0
        cur.append(s)
        words += w
    if cur:
        blocks.append({"segments": cur, "start": cur[0]["start"], "end": cur[-1]["end"]})
    return blocks


def _block_transcript(block: dict) -> str:
    return "\n".join(f"[{i}] {fmt_time(s['start'])} {s['text']}" for i, s in enumerate(block["segments"]))


def _seg_ref(block: dict, value) -> dict:
    segs = block["segments"]
    try:
        i = int(value)
    except (TypeError, ValueError):
        i = 0
    i = max(0, min(len(segs) - 1, i))
    s = segs[i]
    return {"time": s["start"], "end": s["end"], "segment_id": s["id"], "segment_text": s["text"]}


def _clean_list(value, limit: int = 20) -> list:
    return value[:limit] if isinstance(value, list) else []


def _norm_category(cat: str) -> str:
    c = (cat or "").strip().lower()
    c = _CATEGORY_ALIASES.get(normalize_text(c), c)
    return c if c in HIGHLIGHT_CATEGORIES else "information"


def _importance(v, default: float = 3) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = default
    if x > 1:
        x = x / 5
    return round(max(0.0, min(1.0, x)), 2)


def normalize_block_result(block: dict, raw: dict, index: int) -> dict:
    """Convertit les références [n] du modèle en timestamps réels de la timeline."""
    raw = raw if isinstance(raw, dict) else {}
    out = {
        "index": index, "start": block["start"], "end": block["end"],
        "summary": str(raw.get("summary", "")).strip(),
        "topics": [str(t).strip() for t in _clean_list(raw.get("topics"), 8) if str(t).strip()],
        "chapters": [], "highlights": [], "decisions": [], "actions": [], "questions": [], "risks": [],
        "people": [], "entities": [], "quotes": [],
    }
    for ch in _clean_list(raw.get("chapters"), 4):
        if isinstance(ch, dict) and ch.get("title"):
            out["chapters"].append({**_seg_ref(block, ch.get("seg")), "title": str(ch["title"]).strip()[:120],
                                    "summary": str(ch.get("summary") or "").strip()[:400]})
    if not out["chapters"]:
        out["chapters"].append({**_seg_ref(block, 0), "title": (out["topics"][0] if out["topics"] else "Passage")})
    for h in _clean_list(raw.get("highlights"), 8):
        if isinstance(h, dict) and h.get("text"):
            out["highlights"].append({**_seg_ref(block, h.get("seg")), "text": str(h["text"]).strip(),
                                      "category": _norm_category(h.get("category", "")),
                                      "importance": _importance(h.get("importance"))})
    for key in ("decisions", "questions", "quotes"):
        for d in _clean_list(raw.get(key), 10):
            if isinstance(d, dict) and d.get("text"):
                out[key].append({**_seg_ref(block, d.get("seg")), "text": str(d["text"]).strip()})
    for a in _clean_list(raw.get("actions"), 10):
        if isinstance(a, dict) and a.get("text"):
            out["actions"].append({**_seg_ref(block, a.get("seg")), "text": str(a["text"]).strip(),
                                   "owner": str(a.get("owner") or "").strip(),
                                   "deadline": str(a.get("deadline") or "").strip()})
    for r in _clean_list(raw.get("risks"), 8):
        if isinstance(r, dict) and r.get("text"):
            kind = "inference" if str(r.get("kind", "")).lower().startswith("inf") else "fact"
            sev = str(r.get("severity", "medium")).lower()
            out["risks"].append({**_seg_ref(block, r.get("seg")), "text": str(r["text"]).strip(), "kind": kind,
                                 "severity": sev if sev in ("low", "medium", "high") else "medium"})
    for p in _clean_list(raw.get("people"), 15):
        if isinstance(p, dict) and p.get("name"):
            out["people"].append({"name": str(p["name"]).strip()[:80], "role": str(p.get("role") or "").strip()[:120]})
    for e in _clean_list(raw.get("entities"), 20):
        if isinstance(e, dict) and e.get("value"):
            t = str(e.get("type", "")).lower()
            out["entities"].append({"type": t if t in ("company", "product", "place", "technology") else "company",
                                    "value": str(e["value"]).strip()[:120]})
    return out


# --------------------------------------------------------------------------- étape MAP

def run_blocks(audio: dict, progress: Progress, should_stop: Stop, force: bool = False) -> list[dict]:
    segs = transcription_service.segments(audio["id"])
    if not segs:
        raise ValueError("Aucune transcription disponible pour cet audio.")
    blocks = build_blocks(segs, settings.get("analysis.block_minutes"))
    prompt = prompt_service.load("block_analysis")
    lang = prompt_service.language_name(audio.get("language"))
    model = settings.get("ollama.model")

    cached = analysis_store.current(audio["id"], "blocks")
    done: list[dict] = []
    if cached and not force and cached["transcript_rev"] == audio["transcript_rev"] \
            and cached["content"].get("block_minutes") == settings.get("analysis.block_minutes"):
        done = cached["content"].get("blocks", [])
        if len(done) >= len(blocks) and cached["content"].get("complete"):
            progress(100, "Analyse des passages déjà disponible (cache)")
            return done
    started = time.time()
    fresh_record = not done  # nouvelle version dans l'historique, puis mises à jour incrémentales
    for i, block in enumerate(blocks):
        if i < len(done):
            continue
        if should_stop():
            raise InterruptedError("Analyse annulée.")
        progress(i / len(blocks) * 100, f"Analyse du passage {i + 1} sur {len(blocks)} ({fmt_time(block['start'])})")
        messages = prompt.render(language=lang, block_index=i + 1, block_count=len(blocks),
                                 start=fmt_time(block["start"]), end=fmt_time(block["end"]),
                                 title=audio["title"], transcript=_block_transcript(block))
        raw = ollama_service.chat_json(messages, should_stop=should_stop, max_tokens=1600)
        done.append(normalize_block_result(block, raw, i))
        content = {"block_minutes": settings.get("analysis.block_minutes"), "blocks": done,
                   "complete": len(done) >= len(blocks)}
        analysis_store.save(audio["id"], "blocks", content, model=model, prompt_version=prompt.version,
                            transcript_rev=audio["transcript_rev"], duration_sec=round(time.time() - started, 1),
                            replace_current=not fresh_record)
        fresh_record = False
    progress(100, "Analyse des passages terminée")
    return done


# --------------------------------------------------------------------------- étape INSIGHTS (sans LLM)

_RE_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_RE_URL = re.compile(r"\b(?:https?://|www\.)[^\s,;]+", re.I)
_RE_PERCENT = re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:%|pour ?cent)", re.I)
_RE_AMOUNT = re.compile(r"\b\d+(?:[ .,]\d+)*\s?(?:k€|€|euros?|dollars?|\$|millions?|milliards?|M€|K€)", re.I)
_RE_DATE = re.compile(
    r"\b(?:\d{1,2}(?:er)?\s(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|"
    r"novembre|décembre|decembre)(?:\s\d{4})?|\d{1,2}/\d{1,2}(?:/\d{2,4})?|(?:lundi|mardi|mercredi|jeudi|vendredi|"
    r"samedi|dimanche)(?:\sprochain)?|(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|"
    r"décembre)\s\d{4})\b", re.I)


def regex_entities(segs: list[dict]) -> list[dict]:
    found: dict[tuple[str, str], dict] = {}
    for s in segs:
        for kind, rx in (("email", _RE_EMAIL), ("url", _RE_URL), ("percentage", _RE_PERCENT),
                         ("amount", _RE_AMOUNT), ("date", _RE_DATE)):
            for m in rx.finditer(s["text"]):
                v = m.group(0).strip(" .,")
                key = (kind, v.lower())
                e = found.setdefault(key, {"type": kind, "value": v, "count": 0, "times": []})
                e["count"] += 1
                if len(e["times"]) < 30:
                    e["times"].append(s["start"])
    return list(found.values())


def _mention_segments(segs: list[dict], term: str) -> list[dict]:
    t = normalize_text(term)
    if not t:
        return []
    rx = re.compile(r"\b" + re.escape(t) + r"\b")
    return [s for s in segs if rx.search(normalize_text(s["text"]))]


def aggregate_insights(audio: dict, blocks: list[dict]) -> dict:
    segs = transcription_service.segments(audio["id"])
    collect = {k: [] for k in ("highlights", "decisions", "actions", "questions", "risks", "quotes")}
    people: list[dict] = []
    entities: list[dict] = []
    topics: dict[str, dict] = {}
    for b in blocks:
        for k in collect:
            collect[k].extend(b.get(k, []))
        for p in b.get("people", []):
            match = next((x for x in people if similar(x["name"], p["name"], 0.9)), None)
            if match:
                if not match["role"] and p["role"]:
                    match["role"] = p["role"]
                match["blocks"].append(b["index"])
            else:
                people.append({**p, "blocks": [b["index"]]})
        for e in b.get("entities", []):
            if not any(similar(x["value"], e["value"], 0.9) and x["type"] == e["type"] for x in entities):
                entities.append(e)
        for t in b.get("topics", []):
            key = next((k for k in topics if similar(k, t, 0.85)), None)
            if key is None:
                topics[t] = {"name": t, "blocks": [b]}
            else:
                topics[key]["blocks"].append(b)

    highlights = dedupe(sorted(collect["highlights"], key=lambda h: -h["importance"]))
    # les citations remarquables deviennent des highlights « citation » si absentes
    for q in collect["quotes"]:
        if not any(similar(q["text"], h["text"]) for h in highlights):
            highlights.append({**q, "category": "citation", "importance": 0.6})
    decisions = dedupe(collect["decisions"])
    actions = dedupe(collect["actions"])
    questions = dedupe(collect["questions"])
    risks = dedupe(collect["risks"])

    chapters = db.all("SELECT id, start, end, topics FROM chapters WHERE audio_id = ?", (audio["id"],))

    people_rows = []
    for p in people:
        tokens = [p["name"]] + ([p["name"].split()[-1]] if len(p["name"].split()) > 1 else [])
        mentions: dict[int, dict] = {}
        for tok in tokens:
            for s in _mention_segments(segs, tok):
                mentions[s["id"]] = s
        ms = sorted(mentions.values(), key=lambda s: s["start"])
        p_topics = []
        for bi in p["blocks"]:
            for t in blocks[bi].get("topics", [])[:3]:
                if t not in p_topics:
                    p_topics.append(t)
        people_rows.append({
            "name": p["name"], "role": p["role"], "mentions": max(len(ms), len(p["blocks"])),
            "topics": p_topics[:6], "times": [s["start"] for s in ms][:60] or [blocks[p["blocks"][0]]["start"]],
            "quotes": [{"time": s["start"], "text": s["text"]} for s in ms[:4]],
        })

    entity_rows = []
    for e in entities:
        ms = _mention_segments(segs, e["value"])
        entity_rows.append({"type": e["type"], "value": e["value"], "count": max(1, len(ms)),
                            "times": [s["start"] for s in ms][:30], "source": "ai"})
    for p in people_rows:
        entity_rows.append({"type": "person", "value": p["name"], "count": p["mentions"], "times": p["times"][:30],
                            "source": "ai"})
    for e in regex_entities(segs):
        entity_rows.append({**e, "source": "regex"})

    topic_rows = []
    for t in topics.values():
        ms = _mention_segments(segs, t["name"])
        tb = t["blocks"]
        dur = sum(b["end"] - b["start"] for b in tb)
        ch_ids = [c["id"] for c in chapters
                  if any(b["start"] < c["end"] and b["end"] > c["start"] for b in tb)
                  or any(similar(t["name"], x, 0.85) for x in db.jloads(c["topics"], []))]
        hl = sum(1 for h in highlights if any(b["start"] <= h["time"] <= b["end"] for b in tb))
        topic_rows.append({"name": t["name"], "occurrences": max(len(ms), len(tb)), "duration": round(dur, 1),
                           "chapter_ids": ch_ids, "highlight_count": hl, "times": [b["start"] for b in tb]})
    topic_rows.sort(key=lambda x: -x["duration"])

    with db.transaction() as c:
        aid = audio["id"]
        for table in ("highlights", "decisions", "actions", "questions", "risks", "people"):
            c.execute(f"DELETE FROM {table} WHERE audio_id = ? AND source = 'ai'", (aid,))
        c.execute("DELETE FROM entities WHERE audio_id = ? AND source IN ('ai', 'regex')", (aid,))
        c.execute("DELETE FROM topics WHERE audio_id = ?", (aid,))
        for h in highlights:
            db.insert("highlights", {"audio_id": aid, "start": h["time"], "end": h["end"], "text": h["text"],
                                     "category": h["category"], "importance": h["importance"], "source": "ai",
                                     "segment_id": h["segment_id"]}, c)
        for d in decisions:
            db.insert("decisions", {"audio_id": aid, "text": d["text"], "context": d["segment_text"],
                                    "time": d["time"], "source": "ai"}, c)
        for a in actions:
            db.insert("actions", {"audio_id": aid, "text": a["text"], "owner": a["owner"], "deadline": a["deadline"],
                                  "context": a["segment_text"], "time": a["time"], "source": "ai"}, c)
        for q in questions:
            db.insert("questions", {"audio_id": aid, "text": q["text"], "time": q["time"], "source": "ai"}, c)
        for r in risks:
            db.insert("risks", {"audio_id": aid, "text": r["text"], "kind": r["kind"], "severity": r["severity"],
                                "time": r["time"], "source": "ai"}, c)
        for p in people_rows:
            db.insert("people", {"audio_id": aid, "name": p["name"], "role": p["role"], "mentions": p["mentions"],
                                 "topics": db.jdumps(p["topics"]), "times": db.jdumps(p["times"]),
                                 "quotes": db.jdumps(p["quotes"]), "source": "ai"}, c)
        for e in entity_rows:
            db.insert("entities", {"audio_id": aid, "type": e["type"], "value": e["value"], "count": e["count"],
                                   "times": db.jdumps(e["times"]), "source": e["source"]}, c)
        for t in topic_rows:
            db.insert("topics", {"audio_id": aid, "name": t["name"], "occurrences": t["occurrences"],
                                 "duration": t["duration"], "chapter_ids": db.jdumps(t["chapter_ids"]),
                                 "highlight_count": t["highlight_count"], "times": db.jdumps(t["times"])}, c)
    counts = {"highlights": len(highlights), "decisions": len(decisions), "actions": len(actions),
              "questions": len(questions), "risks": len(risks), "people": len(people_rows),
              "entities": len(entity_rows), "topics": len(topic_rows)}
    analysis_store.save(audio["id"], "insights", counts, model=settings.get("ollama.model"),
                        transcript_rev=audio["transcript_rev"])
    return counts


# --------------------------------------------------------------------------- étape CHAPTERS

def run_chapters(audio: dict, blocks: list[dict], should_stop: Stop) -> list[dict]:
    candidates = []
    for b in blocks:
        for ch in b["chapters"]:
            candidates.append({"time": ch["time"], "title": ch["title"],
                               "summary": ch.get("summary") or (b["summary"] if len(b["chapters"]) == 1 else ""),
                               "topics": b["topics"]})
    candidates.sort(key=lambda c: c["time"])
    # dédoublonnage des candidats trop proches (< 45 s)
    compact: list[dict] = []
    for c in candidates:
        if compact and c["time"] - compact[-1]["time"] < 45:
            continue
        compact.append(c)
    if compact:
        compact[0]["time"] = 0.0
    duration = audio["duration"] or (blocks[-1]["end"] if blocks else 0)
    prompt = prompt_service.load("chapters")
    started = time.time()
    if len(compact) <= 3:
        final = [{"from": i, "title": c["title"], "summary": c["summary"], "topics": c["topics"][:3],
                  "importance": 3} for i, c in enumerate(compact)]
    else:
        max_ch = max(3, min(15, int(duration // 300) + 2))
        text = "\n".join(f"{i} | {fmt_time(c['time'])} | {c['title']} | {c['summary'][:220]}"
                         for i, c in enumerate(compact))
        raw = ollama_service.chat_json(
            prompt.render(language=prompt_service.language_name(audio.get("language")), title=audio["title"],
                          duration=fmt_time(duration), candidates=text, max_chapters=max_ch),
            should_stop=should_stop, max_tokens=1500)
        final = []
        for ch in _clean_list(raw.get("chapters") if isinstance(raw, dict) else raw, 30):
            if not isinstance(ch, dict) or not ch.get("title"):
                continue
            try:
                idx = int(ch.get("from", 0))
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(compact):
                final.append({**ch, "from": idx})
        final.sort(key=lambda c: c["from"])
        # Dédoublonne et garantit un premier chapitre à 0
        seen = set()
        final = [c for c in final if not (c["from"] in seen or seen.add(c["from"]))]
        if not final:
            raise ollama_service.OllamaError("Le modèle n'a proposé aucun chapitre exploitable.")
        final[0]["from"] = 0
    rows = []
    for i, ch in enumerate(final):
        start = compact[ch["from"]]["time"]
        end = compact[final[i + 1]["from"]]["time"] if i + 1 < len(final) else duration
        topics = [str(t) for t in _clean_list(ch.get("topics"), 5)] or compact[ch["from"]]["topics"][:3]
        rows.append({"title": str(ch["title"]).strip()[:140], "start": round(start, 2), "end": round(end, 2),
                     "summary": str(ch.get("summary") or compact[ch["from"]]["summary"]).strip(),
                     "topics": topics, "importance": _importance(ch.get("importance"))})
    replace_chapters(audio["id"], rows, source="ai")
    analysis_store.save(audio["id"], "chapters", {"chapters": rows}, model=settings.get("ollama.model"),
                        prompt_version=prompt.version, transcript_rev=audio["transcript_rev"],
                        duration_sec=round(time.time() - started, 1))
    return rows


def replace_chapters(audio_id: int, rows: list[dict], source: str = "ai") -> None:
    with db.transaction() as c:
        c.execute("DELETE FROM chapters WHERE audio_id = ?", (audio_id,))
        for r in rows:
            db.insert("chapters", {"audio_id": audio_id, "title": r["title"], "start": r["start"], "end": r["end"],
                                   "summary": r.get("summary", ""), "topics": db.jdumps(r.get("topics", [])),
                                   "importance": r.get("importance", 0.5), "source": source}, c)


# --------------------------------------------------------------------------- étape SUMMARY

def _bullets(rows: list[dict], fields=("text",), limit: int = 40) -> str:
    if not rows:
        return "(aucun)"
    out = []
    for r in rows[:limit]:
        parts = [str(r.get(f) or "") for f in fields if r.get(f)]
        t = f" ({fmt_time(r['time'])})" if r.get("time") is not None else ""
        out.append("- " + " — ".join(parts) + t)
    return "\n".join(out)


def _facts_text(audio_id: int, limit: int = 30) -> str:
    rows = db.all("SELECT type, value, times FROM entities WHERE audio_id = ? AND type IN ('amount', 'percentage', 'date') "
                  "ORDER BY type, count DESC LIMIT ?", (audio_id, limit))
    if not rows:
        return "(aucun)"
    segs = transcription_service.segments(audio_id)
    lines = []
    for r in rows:
        times = db.jloads(r["times"], [])
        ctx = next((s["text"] for s in segs if times and abs(s["start"] - times[0]) < 0.01), "")
        lines.append(f"- {r['value']} — « {ctx[:160]} »" if ctx else f"- {r['value']}")
    return "\n".join(lines)


def block_summaries_text(blocks: list[dict], max_chars: int = 14000) -> str:
    lines = [f"[{fmt_time(b['start'])}] {b['summary']}" for b in blocks if b.get("summary")]
    text = "\n".join(lines)
    if len(text) > max_chars:  # très longs audios : on raccourcit chaque résumé pour tenir dans le contexte
        per = max(80, max_chars // max(1, len(lines)))
        text = "\n".join(l[:per] for l in lines)
    return text


def run_summary(audio: dict, blocks: list[dict], should_stop: Stop) -> dict:
    prompt = prompt_service.load("summary")
    aid = audio["id"]
    started = time.time()
    raw = ollama_service.chat_json(prompt.render(
        language=prompt_service.language_name(audio.get("language")), title=audio["title"],
        duration=fmt_time(audio["duration"]), block_summaries=block_summaries_text(blocks),
        decisions=_bullets(db.all("SELECT text, time FROM decisions WHERE audio_id = ? ORDER BY time", (aid,))),
        actions=_bullets(db.all("SELECT text, owner, deadline, time FROM actions WHERE audio_id = ? ORDER BY time",
                                (aid,)), ("text", "owner", "deadline")),
        questions=_bullets(db.all("SELECT text, time FROM questions WHERE audio_id = ? ORDER BY time", (aid,))),
        facts=_facts_text(aid),
    ), should_stop=should_stop, max_tokens=2000)
    raw = raw if isinstance(raw, dict) else {}

    def items(key: str, limit: int) -> list[str]:
        # le modèle écrit parfois « Aucun chiffre mentionné » au lieu d'une liste vide
        return [str(x).strip() for x in _clean_list(raw.get(key), limit)
                if str(x).strip() and not re.match(r"^(aucun|aucune|pas de|néant|non mentionn)", str(x).strip(), re.I)]

    content = {
        "title": str(raw.get("title") or audio["title"]),
        "tldr": str(raw.get("tldr") or ""),
        "short": str(raw.get("short") or ""),
        "executive": str(raw.get("executive") or ""),
        "key_points": items("key_points", 15),
        "problems": items("problems", 15),
        "figures": items("figures", 20),
        "dates": items("dates", 20),
        "participants": items("participants", 20),
    }
    analysis_store.save(aid, "summary", content, model=settings.get("ollama.model"), prompt_version=prompt.version,
                        transcript_rev=audio["transcript_rev"], duration_sec=round(time.time() - started, 1))
    if content["participants"] and not audio.get("participants"):
        db.update("audio_files", aid, {"participants": ", ".join(content["participants"][:12])})
    return content


EXTRA_SUMMARIES = {
    "summary_detailed": "Résumé détaillé",
    "summary_chronological": "Résumé chronologique",
    "summary_thematic": "Résumé par thème",
}


def run_extra_summary(audio: dict, kind: str, should_stop: Stop) -> str:
    if kind not in EXTRA_SUMMARIES:
        raise ValueError("Type de résumé inconnu")
    blocks_row = analysis_store.current(audio["id"], "blocks")
    if not blocks_row:
        raise ValueError("Lancez d'abord l'analyse de l'audio.")
    blocks = blocks_row["content"].get("blocks", [])
    chapters = db.all("SELECT title, start FROM chapters WHERE audio_id = ? ORDER BY start", (audio["id"],))
    topics = [t["name"] for t in db.all("SELECT name FROM topics WHERE audio_id = ? ORDER BY duration DESC LIMIT 12",
                                        (audio["id"],))]
    prompt = prompt_service.load(kind)
    started = time.time()
    text = ollama_service.chat(prompt.render(
        language=prompt_service.language_name(audio.get("language")), title=audio["title"],
        duration=fmt_time(audio["duration"]), block_summaries=block_summaries_text(blocks),
        chapters="\n".join(f"- {fmt_time(c['start'])} {c['title']}" for c in chapters) or "(aucun)",
        topics=", ".join(topics) or "(non déterminés)",
    ), should_stop=should_stop, max_tokens=2000)
    analysis_store.save(audio["id"], kind, {"markdown": text}, model=settings.get("ollama.model"),
                        prompt_version=prompt.version, transcript_rev=audio["transcript_rev"],
                        duration_sec=round(time.time() - started, 1))
    return text


def propose_chapters(audio: dict, should_stop: Stop) -> dict:
    blocks_row = analysis_store.current(audio["id"], "blocks")
    if not blocks_row:
        raise ValueError("Lancez d'abord l'analyse de l'audio.")
    blocks = blocks_row["content"].get("blocks", [])
    chapters = db.all("SELECT title, start, end FROM chapters WHERE audio_id = ? ORDER BY start", (audio["id"],))
    prompt = prompt_service.load("chapters_reorganize")
    raw = ollama_service.chat_json(prompt.render(
        language=prompt_service.language_name(audio.get("language")), title=audio["title"],
        duration=fmt_time(audio["duration"]),
        chapters="\n".join(f"- {int(c['start'])}s ({fmt_time(c['start'])}) {c['title']}" for c in chapters),
        block_summaries="\n".join(f"[{int(b['start'])}s] {b['summary']}" for b in blocks),
    ), should_stop=should_stop, max_tokens=1500)
    raw = raw if isinstance(raw, dict) else {}
    segs = transcription_service.segments(audio["id"])
    starts = [s["start"] for s in segs] or [0.0]
    proposal = []
    for ch in _clean_list(raw.get("chapters"), 30):
        try:
            t = float(ch.get("start", 0))
        except (TypeError, ValueError, AttributeError):
            continue
        snapped = min(starts, key=lambda s: abs(s - t))  # aligné sur un début de segment réel
        proposal.append({"start": round(snapped, 2), "title": str(ch.get("title", "")).strip()[:140],
                         "summary": str(ch.get("summary", "")).strip()})
    proposal.sort(key=lambda c: c["start"])
    if proposal:
        proposal[0]["start"] = 0.0
    for i, ch in enumerate(proposal):
        ch["end"] = proposal[i + 1]["start"] if i + 1 < len(proposal) else audio["duration"]
    content = {"rationale": str(raw.get("rationale", "")), "chapters": proposal}
    analysis_store.save(audio["id"], "chapters_proposal", content, model=settings.get("ollama.model"),
                        prompt_version=prompt.version, transcript_rev=audio["transcript_rev"])
    return content
