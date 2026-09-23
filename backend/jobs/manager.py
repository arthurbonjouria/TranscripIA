"""JobService — file de tâches persistante (SQLite), exécutée par des threads de fond.

- Les jobs survivent au rechargement de la page et au redémarrage : au démarrage, les jobs
  interrompus repassent en QUEUED et reprennent (chunks déjà transcrits et blocs déjà analysés conservés).
- Une analyse IA qui échoue n'efface jamais les données existantes et ne fait pas échouer la transcription.
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
from typing import Callable

from backend import db, settings
from backend.services import (analysis_service, analysis_store, briefing_service, ffmpeg_service, ollama_service, search_service,
                              storage_service, transcription_service, whisper_service)

log = logging.getLogger("jobs")

ACTIVE = ("PROCESSING", "TRANSCRIBING", "SEGMENTING", "CHAPTERING", "ANALYZING", "INDEXING")
FINAL = ("COMPLETED", "FAILED", "CANCELLED")

STEP_LABELS = {
    "prepare": "Préparation", "transcribe": "Transcription", "segment": "Segmentation",
    "chapter": "Chapitrage", "analyze": "Analyse", "index": "Indexation",
    "summary": "Rédaction", "briefing": "Briefing", "comparison": "Comparaison", "proposal": "Proposition",
}
STEP_STATUS = {"prepare": "PROCESSING", "transcribe": "TRANSCRIBING", "segment": "SEGMENTING",
               "chapter": "CHAPTERING", "analyze": "ANALYZING", "index": "INDEXING"}
STEP_WEIGHTS = {"prepare": 4, "transcribe": 46, "segment": 2, "chapter": 30, "analyze": 14, "index": 4}

PIPELINES = {
    "process": ["prepare", "transcribe", "segment", "chapter", "analyze", "index"],
    "analyze": ["segment", "chapter", "analyze", "index"],
    "index": ["index"],
    "summary_extra": ["summary"],
    "chapters_ai": ["proposal"],
    "briefing": ["briefing"],
    "prep_briefing": ["briefing"],
    "comparison": ["comparison"],
}

JOB_LABELS = {"process": "Traitement complet", "analyze": "Nouvelle analyse IA", "index": "Indexation sémantique",
              "summary_extra": "Résumé complémentaire", "chapters_ai": "Réorganisation des chapitres",
              "briefing": "Briefing", "prep_briefing": "Briefing avant réunion", "comparison": "Comparaison"}


class JobCancelled(Exception):
    pass


class JobContext:
    def __init__(self, job: dict):
        self.job = job
        self.id = job["id"]
        self.steps: list[dict] = db.jloads(job["steps"], [])
        self.params: dict = db.jloads(job["params"], {})
        self._last_write = 0.0
        self.started = time.time()
        self.warnings: list[str] = []

    # --- annulation / délai
    def should_stop(self) -> bool:
        if time.time() - self.started > settings.get("jobs.timeout_min") * 60:
            raise TimeoutError("Le traitement a dépassé le délai maximal autorisé.")
        return bool(db.scalar("SELECT cancel_requested FROM jobs WHERE id = ?", (self.id,)))

    # --- étapes
    def step(self, key: str) -> dict:
        return next(s for s in self.steps if s["key"] == key)

    def start_step(self, key: str) -> None:
        st = self.step(key)
        st.update(status="running", progress=0, message="")
        status = STEP_STATUS.get(key, "PROCESSING")
        self._save(status=status, message=f"{st['label']} en cours", force=True)

    def progress(self, key: str, pct: float, message: str = "") -> None:
        st = self.step(key)
        st["progress"] = round(max(0.0, min(100.0, pct)), 1)
        if message:
            st["message"] = message
        self._save(message=message or None)

    def end_step(self, key: str, status: str = "done", message: str = "") -> None:
        st = self.step(key)
        st.update(status=status, progress=100 if status == "done" else st.get("progress", 0), message=message)
        self._save(force=True)

    def _overall(self) -> float:
        total = sum(STEP_WEIGHTS.get(s["key"], 10) for s in self.steps) or 1
        acc = 0.0
        for s in self.steps:
            w = STEP_WEIGHTS.get(s["key"], 10)
            if s["status"] in ("done", "skipped", "failed"):
                acc += w
            elif s["status"] == "running":
                acc += w * s.get("progress", 0) / 100
        return round(acc / total * 100, 1)

    def _save(self, status: str | None = None, message: str | None = None, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_write < 0.7:
            return
        self._last_write = now
        data = {"steps": db.jdumps(self.steps), "progress": self._overall(),
                "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        if status:
            data["status"] = status
        if message is not None:
            data["message"] = message[:300]
        db.update("jobs", self.id, data)


# --------------------------------------------------------------------------- création / consultation

def create(job_type: str, audio_id: int | None = None, params: dict | None = None) -> int:
    if job_type not in PIPELINES:
        raise ValueError("Type de tâche inconnu")
    if audio_id is not None:
        existing = db.one(f"SELECT id FROM jobs WHERE audio_id = ? AND type = ? AND status IN ('QUEUED', {','.join('?' * len(ACTIVE))})",
                          (audio_id, job_type, *ACTIVE))
        if existing:
            return existing["id"]
    steps = [{"key": k, "label": STEP_LABELS[k], "status": "pending", "progress": 0, "message": ""}
             for k in PIPELINES[job_type]]
    job_id = db.insert("jobs", {"type": job_type, "audio_id": audio_id, "status": "QUEUED",
                                "steps": db.jdumps(steps), "params": db.jdumps(params or {}),
                                "message": "En attente"})
    if audio_id is not None and job_type == "process":
        db.update("audio_files", audio_id, {"status": "queued"})
    wake()
    return job_id


def get(job_id: int) -> dict | None:
    j = db.one("SELECT j.*, a.title AS audio_title FROM jobs j LEFT JOIN audio_files a ON a.id = j.audio_id "
               "WHERE j.id = ?", (job_id,))
    return _public(j) if j else None


def list_jobs(limit: int = 50, active_only: bool = False, audio_id: int | None = None) -> list[dict]:
    where, params = [], []
    if active_only:
        where.append(f"j.status IN ('QUEUED', {','.join('?' * len(ACTIVE))})")
        params += list(ACTIVE)
    if audio_id is not None:
        where.append("j.audio_id = ?")
        params.append(audio_id)
    sql = ("SELECT j.*, a.title AS audio_title FROM jobs j LEFT JOIN audio_files a ON a.id = j.audio_id"
           + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY j.id DESC LIMIT ?")
    return [_public(j) for j in db.all(sql, [*params, limit])]


def _public(j: dict) -> dict:
    j["steps"] = db.jloads(j["steps"], [])
    j["params"] = db.jloads(j["params"], {})
    j["result"] = db.jloads(j["result"], None)
    j["label"] = JOB_LABELS.get(j["type"], j["type"])
    return j


def cancel(job_id: int) -> None:
    j = db.one("SELECT status FROM jobs WHERE id = ?", (job_id,))
    if not j:
        raise KeyError("Tâche introuvable")
    if j["status"] == "QUEUED":
        db.update("jobs", job_id, {"status": "CANCELLED", "message": "Annulé", "finished_at": _now()})
    elif j["status"] in ACTIVE:
        db.update("jobs", job_id, {"cancel_requested": 1, "message": "Annulation en cours…"})


def retry(job_id: int) -> int:
    j = db.one("SELECT * FROM jobs WHERE id = ?", (job_id,))
    if not j or j["status"] not in ("FAILED", "CANCELLED", "COMPLETED"):
        raise ValueError("Cette tâche ne peut pas être relancée.")
    return create(j["type"], j["audio_id"], db.jloads(j["params"], {}))


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# --------------------------------------------------------------------------- exécution

def _audio(ctx: JobContext) -> dict:
    a = db.one("SELECT * FROM audio_files WHERE id = ?", (ctx.job["audio_id"],))
    if not a:
        raise KeyError("L'audio associé a été supprimé.")
    return a


def _stopper(ctx: JobContext) -> Callable[[], bool]:
    return ctx.should_stop


def step_prepare(ctx: JobContext) -> None:
    audio = _audio(ctx)
    src = storage_service.audio_path(audio["stored_name"])
    wav = storage_service.normalized_wav(audio["uid"])
    if not wav.exists():
        ctx.progress("prepare", 10, "Conversion et normalisation du son")
        ffmpeg_service.normalize(src, wav)
    ctx.progress("prepare", 80, "Calcul de la forme d'onde")
    peaks_file = storage_service.peaks_path(audio["uid"])
    if not peaks_file.exists():
        import json

        peaks_file.write_text(json.dumps(ffmpeg_service.compute_peaks(wav)), encoding="utf-8")


def step_transcribe(ctx: JobContext) -> None:
    audio = _audio(ctx)
    ollama_service.unload()  # libère la RAM/VRAM avant Whisper
    force_new = bool(ctx.params.get("retranscribe"))
    tr = transcription_service.start_or_resume(audio, force_new=force_new, profile=ctx.params.get("profile"))
    ctx.params["retranscribe"] = False
    db.update("jobs", ctx.id, {"params": db.jdumps(ctx.params)})
    if tr["status"] == "completed":
        ctx.progress("transcribe", 100, "Transcription déjà disponible")
        return
    db.update("audio_files", audio["id"], {"status": "processing"})
    transcription_service.run(audio, tr, lambda p, m: ctx.progress("transcribe", p, m), ctx.should_stop,
                              language=ctx.params.get("language") or None, profile=ctx.params.get("profile"))
    db.update("audio_files", audio["id"], {"status": "transcribed", "updated_at": _now()})


def step_segment(ctx: JobContext) -> None:
    audio = _audio(ctx)
    transcription_service.rebuild_fts(audio["id"])
    ctx.progress("segment", 50, "Découpage en passages")
    n = search_service.build_passages(audio["id"])
    ctx.progress("segment", 100, f"{n} passages indexés")


def _llm_ready(ctx: JobContext) -> str | None:
    st = ollama_service.status()
    if not st["available"]:
        return "Ollama ne répond pas : l'analyse IA n'a pas pu être lancée. La transcription reste disponible."
    if not ollama_service.has_model(settings.get("ollama.model")):
        return f"Le modèle « {settings.get('ollama.model')} » n'est pas installé dans Ollama."
    return None


def step_chapter(ctx: JobContext) -> None:
    audio = _audio(ctx)
    whisper_service.unload()  # libère la RAM pour le LLM
    force = bool(ctx.params.get("force"))
    use_cache = settings.get("analysis.use_cache") and not force
    blocks = analysis_service.run_blocks(audio, lambda p, m: ctx.progress("chapter", p * 0.85, m), ctx.should_stop,
                                         force=not use_cache)
    ctx.params["_blocks_ready"] = True
    audio = _audio(ctx)
    if use_cache and analysis_store.is_fresh(audio, "chapters") and \
            db.scalar("SELECT COUNT(*) FROM chapters WHERE audio_id = ?", (audio["id"],)):
        ctx.progress("chapter", 100, "Chapitres déjà disponibles (cache)")
        return
    ctx.progress("chapter", 88, "Consolidation des chapitres")
    try:
        analysis_service.run_chapters(audio, blocks, ctx.should_stop)
    except (InterruptedError, TimeoutError):
        raise
    except Exception as exc:
        ctx.warnings.append(f"Chapitrage : {exc}")
        log.warning("Chapitrage impossible pour l'audio %s : %s", audio["id"], exc)


def step_analyze(ctx: JobContext) -> None:
    audio = _audio(ctx)
    row = analysis_store.current(audio["id"], "blocks")
    blocks = row["content"].get("blocks", []) if row else []
    if not blocks:
        raise RuntimeError("Aucune analyse de passage disponible.")
    ctx.progress("analyze", 10, "Consolidation des moments clés, décisions et actions")
    analysis_service.aggregate_insights(audio, blocks)
    audio = _audio(ctx)
    force = bool(ctx.params.get("force"))
    if settings.get("analysis.use_cache") and not force and analysis_store.is_fresh(audio, "summary"):
        ctx.progress("analyze", 100, "Synthèse déjà disponible (cache)")
    else:
        ctx.progress("analyze", 30, "Rédaction de la fiche de synthèse")
        analysis_service.run_summary(audio, blocks, ctx.should_stop)
    db.update("audio_files", audio["id"], {"status": "analyzed", "updated_at": _now()})


def step_index(ctx: JobContext) -> None:
    audio = _audio(ctx)
    if not db.scalar("SELECT COUNT(*) FROM passages WHERE audio_id = ?", (audio["id"],)):
        search_service.build_passages(audio["id"])
    if not search_service.embedding_available():
        ctx.end_step("index", "skipped", f"Recherche sémantique inactive : modèle « {settings.get('ollama.embed_model')} » "
                                         "non installé. La recherche plein texte reste disponible.")
        return
    n = search_service.embed_passages(audio["id"], lambda p, m: ctx.progress("index", p, m), ctx.should_stop)
    ctx.progress("index", 100, f"{n} passages vectorisés")


def run_job(job: dict) -> None:
    ctx = JobContext(job)
    db.update("jobs", ctx.id, {"status": "PROCESSING", "started_at": job["started_at"] or _now(),
                               "attempts": job["attempts"] + 1, "error": None, "error_detail": None,
                               "cancel_requested": 0})
    t = job["type"]
    llm_steps = {"chapter", "analyze", "index", "summary", "briefing", "comparison", "proposal"}
    llm_error: str | None = None
    try:
        for st in ctx.steps:
            key = st["key"]
            if st["status"] in ("done", "skipped"):
                continue
            if t == "process" and key in llm_steps and not settings.get("analysis.auto_run"):
                ctx.end_step(key, "skipped", "Analyse IA automatique désactivée dans les paramètres.")
                continue
            if key in llm_steps and key != "index":
                llm_error = llm_error or _llm_ready(ctx)
                if llm_error:
                    if t in ("process", "analyze"):
                        ctx.end_step(key, "skipped", llm_error)
                        continue
                    raise RuntimeError(llm_error)
            if key == "index" and llm_error:
                ctx.end_step(key, "skipped", "Indexation sémantique ignorée (Ollama indisponible).")
                continue
            if key == "analyze" and not ctx.params.get("_blocks_ready") and \
                    not analysis_store.current(job["audio_id"], "blocks"):
                ctx.end_step(key, "skipped", "Analyse impossible : l'étape précédente n'a pas abouti.")
                continue
            ctx.start_step(key)
            try:
                if key == "prepare":
                    step_prepare(ctx)
                elif key == "transcribe":
                    step_transcribe(ctx)
                elif key == "segment":
                    step_segment(ctx)
                elif key == "chapter":
                    step_chapter(ctx)
                elif key == "analyze":
                    step_analyze(ctx)
                elif key == "index":
                    step_index(ctx)
                    if ctx.step("index")["status"] == "skipped":
                        continue
                elif key == "summary":
                    audio = _audio(ctx)
                    analysis_service.run_extra_summary(audio, ctx.params["kind"], ctx.should_stop)
                elif key == "proposal":
                    analysis_service.propose_chapters(_audio(ctx), ctx.should_stop)
                elif key == "briefing":
                    if t == "briefing":
                        briefing_service.briefing(_audio(ctx), ctx.should_stop)
                    else:
                        briefing_service.prep_briefing(ctx.params["audio_ids"], ctx.should_stop)
                elif key == "comparison":
                    briefing_service.comparison(ctx.params["audio_ids"], ctx.should_stop)
                ctx.end_step(key, "done")
            except (InterruptedError, TimeoutError, JobCancelled):
                raise
            except Exception as exc:
                # Les étapes IA d'un traitement complet n'invalident pas la transcription
                if key in llm_steps and t in ("process", "analyze"):
                    ctx.end_step(key, "failed", str(exc)[:300])
                    ctx.warnings.append(f"{STEP_LABELS[key]} : {exc}")
                    log.warning("Étape %s en échec (job %s) : %s", key, ctx.id, exc)
                    continue
                raise
        msg = "Terminé" if not ctx.warnings else "Terminé avec des avertissements"
        if ctx.warnings and not any(s["status"] == "done" for s in ctx.steps if s["key"] in llm_steps):
            msg = "Transcription terminée — analyse IA non réalisée"
        db.update("jobs", ctx.id, {"status": "COMPLETED", "message": msg, "progress": 100,
                                   "error": "\n".join(ctx.warnings) or None, "steps": db.jdumps(ctx.steps),
                                   "finished_at": _now(), "updated_at": _now()})
        if llm_error and job["audio_id"]:
            db.update("jobs", ctx.id, {"error": llm_error})
    except (InterruptedError, JobCancelled):
        for s in ctx.steps:
            if s["status"] == "running":
                s["status"] = "pending"
        db.update("jobs", ctx.id, {"status": "CANCELLED", "message": "Annulé", "steps": db.jdumps(ctx.steps),
                                   "finished_at": _now(), "cancel_requested": 0})
        _reset_audio_status(job)
    except Exception as exc:
        detail = traceback.format_exc(limit=6)
        for s in ctx.steps:
            if s["status"] == "running":
                s["status"] = "failed"
                s["message"] = str(exc)[:300]
        attempts = job["attempts"] + 1
        retryable = attempts <= settings.get("jobs.retries") and not isinstance(exc, (KeyError, ValueError, TimeoutError))
        log.error("Job %s (%s) en échec : %s", ctx.id, t, exc)
        if retryable:
            for s in ctx.steps:
                if s["status"] == "failed":
                    s["status"] = "pending"
            db.update("jobs", ctx.id, {"status": "QUEUED", "message": "Nouvelle tentative programmée",
                                       "steps": db.jdumps(ctx.steps), "error": str(exc)[:1000]})
        else:
            db.update("jobs", ctx.id, {"status": "FAILED", "message": _friendly(ctx, exc), "error": str(exc)[:2000],
                                       "error_detail": detail, "steps": db.jdumps(ctx.steps), "finished_at": _now()})
            if job["audio_id"] and t == "process":
                tr_done = transcription_service.current_transcription(job["audio_id"])
                db.update("audio_files", job["audio_id"],
                          {"status": "transcribed" if tr_done and tr_done["status"] == "completed" else "failed"})


def _friendly(ctx: JobContext, exc: Exception) -> str:
    failed = next((s for s in ctx.steps if s["status"] == "failed"), None)
    if failed and failed["key"] == "transcribe":
        return "La transcription n'a pas pu être terminée."
    if failed and failed["key"] == "prepare":
        return "Le fichier audio n'a pas pu être préparé."
    if isinstance(exc, TimeoutError):
        return "Le traitement a dépassé le délai autorisé."
    return "La tâche n'a pas pu être terminée."


def _reset_audio_status(job: dict) -> None:
    if not job["audio_id"]:
        return
    tr = transcription_service.current_transcription(job["audio_id"])
    status = "uploaded"
    if tr and tr["status"] == "completed":
        status = "analyzed" if analysis_store.current(job["audio_id"], "summary") else "transcribed"
    db.update("audio_files", job["audio_id"], {"status": status})


# --------------------------------------------------------------------------- workers

_event = threading.Event()
_stop = threading.Event()
_claim_lock = threading.Lock()
_threads: list[threading.Thread] = []


def wake() -> None:
    _event.set()


def _claim() -> dict | None:
    with _claim_lock:
        job = db.one("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY id LIMIT 1")
        if job:
            db.update("jobs", job["id"], {"status": "PROCESSING", "message": "Démarrage"})
            job["status"] = "PROCESSING"
        return job


def _worker(n: int) -> None:
    log.info("Worker %s démarré", n)
    while not _stop.is_set():
        try:
            job = _claim()
        except Exception as exc:
            log.error("Lecture de la file impossible : %s", exc)
            job = None
        if job is None:
            _event.wait(timeout=2)
            _event.clear()
            continue
        try:
            run_job(job)
        except Exception as exc:  # garde-fou ultime : un job ne doit jamais tuer le worker
            log.critical("Erreur inattendue dans le worker : %s", exc)


def recover() -> int:
    """Au démarrage : les jobs interrompus (arrêt, plantage) sont remis en file et reprendront."""
    rows = db.all(f"SELECT id, steps FROM jobs WHERE status IN ({','.join('?' * len(ACTIVE))})", ACTIVE)
    for r in rows:
        steps = db.jloads(r["steps"], [])
        for s in steps:
            if s["status"] == "running":
                s["status"] = "pending"
        db.update("jobs", r["id"], {"status": "QUEUED", "message": "Reprise après redémarrage",
                                    "steps": db.jdumps(steps), "cancel_requested": 0})
    return len(rows)


def start_workers() -> None:
    if _threads:
        return
    n = recover()
    if n:
        log.info("%s tâche(s) reprise(s) après redémarrage", n)
    for i in range(max(1, settings.get("jobs.concurrency"))):
        th = threading.Thread(target=_worker, args=(i + 1,), name=f"job-worker-{i + 1}", daemon=True)
        th.start()
        _threads.append(th)


def stop_workers() -> None:
    _stop.set()
    _event.set()
