-- BONJOUR IA — Audio Intelligence Workspace
-- Schéma SQLite. Toutes les tables dépendantes d'un audio sont supprimées en cascade.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS audio_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uid             TEXT NOT NULL UNIQUE,
    original_name   TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    stored_name     TEXT NOT NULL,           -- nom de fichier interne (uid + extension), jamais le nom utilisateur
    ext             TEXT NOT NULL,
    mime            TEXT NOT NULL DEFAULT '',
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    duration        REAL NOT NULL DEFAULT 0,
    codec           TEXT NOT NULL DEFAULT '',
    sample_rate     INTEGER NOT NULL DEFAULT 0,
    channels        INTEGER NOT NULL DEFAULT 0,
    bitrate         INTEGER NOT NULL DEFAULT 0,
    language        TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'uploaded', -- uploaded, queued, processing, transcribed, analyzed, failed
    category        TEXT NOT NULL DEFAULT '',
    participants    TEXT NOT NULL DEFAULT '',
    recorded_at     TEXT,
    favorite        INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0,
    transcript_rev  INTEGER NOT NULL DEFAULT 0,       -- incrémenté à chaque correction de transcription
    last_opened_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audio_status ON audio_files(status);
CREATE INDEX IF NOT EXISTS idx_audio_created ON audio_files(created_at);
CREATE INDEX IF NOT EXISTS idx_audio_opened ON audio_files(last_opened_at);

CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#B1ADA1'
);

CREATE TABLE IF NOT EXISTS audio_tags (
    audio_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (audio_id, tag_id)
);

CREATE TABLE IF NOT EXISTS transcriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id        INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL DEFAULT 1,
    model           TEXT NOT NULL DEFAULT '',
    device          TEXT NOT NULL DEFAULT '',
    language        TEXT NOT NULL DEFAULT '',
    language_prob   REAL NOT NULL DEFAULT 0,
    chunk_duration  INTEGER NOT NULL DEFAULT 600,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
    is_current      INTEGER NOT NULL DEFAULT 1,
    word_count      INTEGER NOT NULL DEFAULT 0,
    processing_sec  REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcriptions_audio ON transcriptions(audio_id, is_current);

CREATE TABLE IF NOT EXISTS transcription_chunks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    transcription_id INTEGER NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
    idx              INTEGER NOT NULL,
    start            REAL NOT NULL,
    end              REAL NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending', -- pending, done, failed
    error            TEXT,
    UNIQUE (transcription_id, idx)
);

CREATE TABLE IF NOT EXISTS speakers (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id  INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    label     TEXT NOT NULL,             -- « Speaker 1 »… (diarisation)
    name      TEXT NOT NULL DEFAULT '',  -- nom réel attribué par l'utilisateur
    color     TEXT NOT NULL DEFAULT '#B1ADA1',
    talk_time REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_speakers_audio ON speakers(audio_id);

CREATE TABLE IF NOT EXISTS transcription_segments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    transcription_id INTEGER NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
    audio_id         INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    idx              INTEGER NOT NULL,
    start            REAL NOT NULL,
    end              REAL NOT NULL,
    text             TEXT NOT NULL,           -- texte original Whisper, jamais modifié
    text_edited      TEXT,                    -- correction utilisateur (NULL = pas de correction)
    speaker_id       INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
    confidence       REAL,
    chunk_idx        INTEGER NOT NULL DEFAULT 0,
    edited_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_segments_tr ON transcription_segments(transcription_id, idx);
CREATE INDEX IF NOT EXISTS idx_segments_audio_time ON transcription_segments(audio_id, start);

CREATE TABLE IF NOT EXISTS segment_edits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_id INTEGER NOT NULL REFERENCES transcription_segments(id) ON DELETE CASCADE,
    old_text   TEXT NOT NULL,
    new_text   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index plein texte (texte courant = correction si elle existe, sinon original)
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
    text,
    segment_id UNINDEXED,
    audio_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS chapters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    start      REAL NOT NULL,
    end        REAL NOT NULL,
    summary    TEXT NOT NULL DEFAULT '',
    topics     TEXT NOT NULL DEFAULT '[]',   -- JSON
    importance REAL NOT NULL DEFAULT 0.5,
    source     TEXT NOT NULL DEFAULT 'ai',   -- ai, user
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_audio ON chapters(audio_id, start);

CREATE TABLE IF NOT EXISTS highlight_categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color     TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS highlights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id    INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    start       REAL NOT NULL,
    end         REAL NOT NULL,
    text        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'information', -- décision, action, information, question, idée, opportunité, risque, citation, date, chiffre, ou catégorie utilisateur
    importance  REAL NOT NULL DEFAULT 0.5,           -- 0..1
    source      TEXT NOT NULL DEFAULT 'ai',          -- ai, user
    note        TEXT NOT NULL DEFAULT '',
    favorite    INTEGER NOT NULL DEFAULT 0,
    segment_id  INTEGER REFERENCES transcription_segments(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_highlights_audio ON highlights(audio_id, start);
CREATE INDEX IF NOT EXISTS idx_highlights_importance ON highlights(importance);

CREATE TABLE IF NOT EXISTS bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    time       REAL NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_audio ON bookmarks(audio_id, time);

CREATE TABLE IF NOT EXISTS annotations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    time       REAL NOT NULL,
    end        REAL,
    text       TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '#E83967',
    segment_id INTEGER REFERENCES transcription_segments(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_annotations_audio ON annotations(audio_id, time);

CREATE TABLE IF NOT EXISTS clips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id    INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    start       REAL NOT NULL,
    end         REAL NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    file_name   TEXT,               -- extrait MP3 généré par FFmpeg
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clips_audio ON clips(audio_id, start);

CREATE TABLE IF NOT EXISTS people (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id  INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    role      TEXT NOT NULL DEFAULT '',
    mentions  INTEGER NOT NULL DEFAULT 0,
    topics    TEXT NOT NULL DEFAULT '[]',
    times     TEXT NOT NULL DEFAULT '[]',   -- timestamps des mentions
    quotes    TEXT NOT NULL DEFAULT '[]',   -- [{time, text}]
    speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL,
    source    TEXT NOT NULL DEFAULT 'ai'
);
CREATE INDEX IF NOT EXISTS idx_people_audio ON people(audio_id);

CREATE TABLE IF NOT EXISTS entities (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id  INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    type      TEXT NOT NULL,     -- person, company, product, place, date, amount, percentage, technology, email, url
    value     TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 1,
    times     TEXT NOT NULL DEFAULT '[]',
    source    TEXT NOT NULL DEFAULT 'ai' -- ai, regex
);
CREATE INDEX IF NOT EXISTS idx_entities_audio ON entities(audio_id, type);

CREATE TABLE IF NOT EXISTS topics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id        INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    occurrences     INTEGER NOT NULL DEFAULT 0,
    duration        REAL NOT NULL DEFAULT 0,
    chapter_ids     TEXT NOT NULL DEFAULT '[]',
    highlight_count INTEGER NOT NULL DEFAULT 0,
    times           TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_topics_audio ON topics(audio_id);

CREATE TABLE IF NOT EXISTS actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    owner      TEXT NOT NULL DEFAULT '',
    deadline   TEXT NOT NULL DEFAULT '',
    context    TEXT NOT NULL DEFAULT '',
    time       REAL,
    status     TEXT NOT NULL DEFAULT 'todo',  -- todo, doing, done
    source     TEXT NOT NULL DEFAULT 'ai',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actions_audio ON actions(audio_id, status);

CREATE TABLE IF NOT EXISTS decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    context    TEXT NOT NULL DEFAULT '',
    time       REAL,
    source     TEXT NOT NULL DEFAULT 'ai',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_audio ON decisions(audio_id);

CREATE TABLE IF NOT EXISTS questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    time       REAL,
    resolved   INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT 'ai',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_questions_audio ON questions(audio_id);

CREATE TABLE IF NOT EXISTS risks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'fact',  -- fact (présent dans la source), inference (interprétation IA)
    severity   TEXT NOT NULL DEFAULT 'medium',
    time       REAL,
    source     TEXT NOT NULL DEFAULT 'ai',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_risks_audio ON risks(audio_id);

-- Historique versionné de toutes les analyses IA (résumés, fiche, briefing…)
CREATE TABLE IF NOT EXISTS analyses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id       INTEGER REFERENCES audio_files(id) ON DELETE CASCADE, -- NULL pour une analyse multi-audios
    kind           TEXT NOT NULL,   -- blocks, summary, sheet, chapters, insights, summary_detailed, summary_chronological, summary_thematic, briefing, comparison, prep_briefing, chapters_proposal
    version        INTEGER NOT NULL DEFAULT 1,
    content        TEXT NOT NULL,   -- JSON
    model          TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    transcript_rev INTEGER NOT NULL DEFAULT 0,
    source         TEXT NOT NULL DEFAULT 'ai',  -- ai, user
    scope          TEXT NOT NULL DEFAULT '',    -- liste d'ids pour les analyses multi-audios
    is_current     INTEGER NOT NULL DEFAULT 1,
    duration_sec   REAL NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analyses_audio ON analyses(audio_id, kind, is_current);
CREATE INDEX IF NOT EXISTS idx_analyses_scope ON analyses(kind, scope, is_current);

-- Passages (fenêtres de segments) utilisés par le RAG et la recherche sémantique
CREATE TABLE IF NOT EXISTS passages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id     INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    start        REAL NOT NULL,
    end          REAL NOT NULL,
    text         TEXT NOT NULL,
    embedding    BLOB,
    embed_model  TEXT
);
CREATE INDEX IF NOT EXISTS idx_passages_audio ON passages(audio_id, start);

CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
    text,
    passage_id UNINDEXED,
    audio_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT 'Nouvelle conversation',
    audio_ids  TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,     -- user, assistant
    content    TEXT NOT NULL,
    sources    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);

CREATE TABLE IF NOT EXISTS jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    type             TEXT NOT NULL,           -- process, analyze, regenerate, summary_extra, index, briefing, comparison, prep_briefing, chapters_ai
    audio_id         INTEGER REFERENCES audio_files(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'QUEUED',
    progress         REAL NOT NULL DEFAULT 0,   -- 0..100 global
    steps            TEXT NOT NULL DEFAULT '[]',-- [{key,label,status,progress}]
    message          TEXT NOT NULL DEFAULT '',
    error            TEXT,
    error_detail     TEXT,
    params           TEXT NOT NULL DEFAULT '{}',
    result           TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    started_at       TEXT,
    finished_at      TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_audio ON jobs(audio_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    level      TEXT NOT NULL,
    logger     TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
