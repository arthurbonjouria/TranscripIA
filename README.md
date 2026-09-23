# BONJOUR IA — Audio Intelligence Workspace

Application web **100 % locale** qui transforme de longs enregistrements (réunions, entretiens, conférences) en transcription, chapitres, fiche de synthèse, moments clés, décisions, actions, questions, risques, personnes, sujets, recherche, chat avec sources horodatées, clips et rapports.

> **Traitement local** — les fichiers audio et les données sont traités sur cette machine. Aucun service cloud n'est appelé : Whisper (transcription) et Qwen via Ollama (analyse) tournent localement.

---

## Démarrage rapide

1. Double-cliquez sur **`START.bat`** : il vérifie les dépendances, démarre Ollama si besoin, lance le serveur et ouvre **http://127.0.0.1:8765**.
2. Importez un fichier audio (glisser-déposer). La transcription puis l'analyse démarrent automatiquement.
3. **`STOP.bat`** arrête l'application. Les traitements interrompus reprennent au démarrage suivant.
4. **`DIAGNOSTIC.bat`** teste tous les composants (`DIAGNOSTIC.bat --deep` : test de transcription et de génération réelles).

## Prérequis

| Composant | Version testée | Installation |
|---|---|---|
| Windows | 11 Pro | — |
| Python | 3.14.7 (3.11+) | https://www.python.org |
| FFmpeg | 9.0.2 | `winget install Gyan.FFmpeg` |
| Ollama | 0.34.3 | https://ollama.com/download |
| Modèle LLM | `qwen3:8b` (Q4_K_M) | `ollama pull qwen3:8b` |
| faster-whisper | 1.2.1 | installé via `requirements.txt` |
| Modèles Whisper | `small` (profil Équilibré), `base` (profil Rapide) | téléchargés automatiquement au premier usage (~480 Mo / ~145 Mo) |

Dépendances Python : `python -m pip install -r requirements.txt` (fait automatiquement par `START.bat`).

Optionnel — recherche sémantique (« problèmes liés au paiement » retrouve « Apple Pay ne fonctionne pas ») :
```bash
ollama pull nomic-embed-text
```
Sans ce modèle, la recherche plein texte et le chat restent pleinement fonctionnels.

## Configuration

Copiez `.env.example` en `.env` pour modifier le port, le dossier de données ou les réglages par défaut. La plupart des réglages sont aussi modifiables dans **Paramètres** (prioritaires sur `.env`).

**Stockage** : par défaut `C:\TranscripIA-data` (base SQLite, audios, fichiers de travail, clips, exports, modèles Whisper, journaux). Ce dossier est volontairement **hors OneDrive** : un dossier synchronisé enverrait les audios dans le cloud et pourrait corrompre la base SQLite. Le diagnostic signale un dossier synchronisé.

## Architecture

```text
Navigateur (HTML/CSS/JS natif, sans CDN ni framework)
    ↓ API REST locale (127.0.0.1, protection CSRF / DNS rebinding)
FastAPI (backend/app.py)
    ↓
Job Manager (backend/jobs/manager.py) — file persistante SQLite, reprise après redémarrage
    ├── FFmpegService      conversion, normalisation, chunks, clips, waveform
    ├── WhisperService     faster-whisper (CPU int8 / GPU CUDA si disponible)
    ├── AnalysisService    map-reduce sur Qwen : passages → chapitres → insights → synthèse
    ├── SearchService      FTS5 (plein texte, sans accents) + embeddings (optionnel)
    ├── RAGService         chat : recherche → passages → Qwen → réponse + sources
    └── ExportService      PDF, DOCX, Markdown, TXT, JSON, SRT, VTT, extraits audio
```

### Arborescence

```text
TranscripIA/
├── backend/
│   ├── app.py               application FastAPI, sécurité, erreurs lisibles
│   ├── run.py               serveur (START.bat)
│   ├── config.py            configuration .env + détection FFmpeg / Ollama
│   ├── settings.py          réglages modifiables à chaud
│   ├── api/                 audio, analysis, annotations, search, chat, export, jobs, system
│   ├── services/            ffmpeg, storage, whisper, transcription, ollama, prompt,
│   │                        analysis, analysis_store, search, rag, briefing, export, diagnostic
│   ├── jobs/manager.py      JobService
│   └── db/schema.sql        schéma SQLite (index, clés étrangères, FTS5)
├── frontend/
│   ├── index.html
│   ├── css/                 tokens (design system), base, components, layout, pages
│   ├── js/                  app (routeur), api, ui, icons, player, waveform, chatbox
│   │   ├── pages/           dashboard, library, import, audio, search, chat, compare, actions, jobs, health, settings
│   │   └── audio/           overview (fiche), transcript, chapters, insights, notes, chat, report, progress
│   ├── fonts/               Poppins & Lora (SIL OFL) embarquées
│   └── img/                 logo officiel BONJOUR IA (SVG + PNG), favicon
├── prompts/                 prompts IA versionnés (modifiables sans toucher au code)
├── tests/                   tests réels (pytest) + générateur de fichiers audio de test
├── START.bat  STOP.bat  DIAGNOSTIC.bat
├── requirements.txt  .env.example
```

### Pipeline audio

1. **Upload** : liste blanche d'extensions, vérification de la signature binaire, limite de taille, lecture par ffprobe. Le fichier est stocké sous un nom interne aléatoire (jamais le nom fourni).
2. **Préparation** : FFmpeg → WAV 16 kHz mono normalisé (`dynaudnorm`) + pics de waveform.
3. **Chunks** : découpage de la durée configurée (5 min par défaut), chaque frontière est placée sur le passage le plus silencieux à ±10 s pour ne pas couper un mot.
4. **Transcription** : chaque chunk est transcrit puis enregistré immédiatement ; les timestamps sont recalés (`offset du chunk + timestamp local`). Une interruption reprend au chunk suivant. Les fichiers temporaires sont supprimés.
5. **Segmentation / indexation** : index plein texte FTS5 + passages (~1 min) pour le RAG.

Chaque segment conserve `start`, `end`, `text`, `speaker` (prévu pour la diarisation), `confidence`. Le texte Whisper original n'est jamais modifié : les corrections sont stockées à part et historisées.

### Pipeline IA (pensé pour les très longs audios)

1. **Map** — la transcription est découpée en passages (~8 min). Un appel Qwen par passage extrait résumé, chapitres candidats, highlights, décisions, actions (responsable, échéance), questions, risques (fait vs interprétation), personnes, entités, citations. Les références `[n]` renvoient aux segments : chaque élément a donc un **timestamp exact**. Sauvegarde après chaque passage (reprise possible).
2. **Insights** — agrégation et dédoublonnage sans LLM + extraction regex (montants, pourcentages, dates, emails, URLs).
3. **Chapitres** — consolidation des candidats en chapitres (1 appel).
4. **Synthèse** — fiche de synthèse à partir des résumés de passages (jamais la transcription entière).

Toutes les analyses sont **versionnées** (table `analyses`). Le cache évite tout recalcul ; « Régénérer » crée une nouvelle version. Une analyse qui échoue ne touche pas aux données existantes ; si Ollama est absent, la transcription reste disponible.

### Base de données

SQLite (WAL), tables : `audio_files`, `tags`, `audio_tags`, `transcriptions`, `transcription_chunks`, `transcription_segments`, `segment_edits`, `segments_fts`, `speakers`, `chapters`, `highlight_categories`, `highlights`, `bookmarks`, `annotations`, `clips`, `people`, `entities`, `topics`, `actions`, `decisions`, `questions`, `risks`, `analyses`, `passages`, `passages_fts`, `chat_sessions`, `chat_messages`, `jobs`, `settings`, `logs`. Requêtes toujours paramétrées.

### API (extraits)

```text
POST /api/audio/upload                GET  /api/audio            GET /api/audio/{id}
POST /api/audio/{id}/process          POST /api/audio/{id}/regenerate
GET  /api/audio/{id}/transcription    PATCH /api/segments/{id}   POST /api/audio/{id}/transcription/replace
GET  /api/audio/{id}/chapters         POST /api/audio/{id}/chapters/reorganize
GET  /api/audio/{id}/summary          PUT  /api/audio/{id}/summary
GET  /api/audio/{id}/highlights       GET  /api/audio/{id}/insights   GET /api/audio/{id}/timeline
POST /api/audio/{id}/chat             POST /api/chat (multi-documents, NDJSON streamé)
GET  /api/audio/{id}/export?fmt=pdf|docx|md|txt|json|srt|vtt
POST /api/clips   POST /api/bookmarks   POST /api/annotations   POST /api/highlights
GET  /api/search?q=…&mode=text|semantic
POST /api/compare   POST /api/prep-briefing   GET /api/jobs   GET /api/health
```

## Modèles et performances (machine auditée)

i5-10300H (4 cœurs / 8 threads), 16 Go de RAM, GTX 1650 Ti 4 Go. Mesures réelles sur un podcast français de 44 min (HugoDécrypte) :

| Profil | Réglages | Vitesse | 45 min d'audio | Qualité |
|---|---|---|---|---|
| **Équilibré** (défaut) | small, beam 1, inférence par lots | ×6,6 | **≈ 6 min 40** (mesuré : 44 min en 6 min 43 s) | bonne |
| Rapide | base, beam 1, par lots | ×21 | ≈ 2 min | correcte (erreurs sur les mots rares) |
| Précis | small, beam 5, séquentiel | ×2,8 | ≈ 16 min | la meilleure sur CPU |

- Le texte apparaît **au fil de la transcription** (chunks de 5 min) : les premières phrases sont lisibles en moins d'une minute.
- Les segments produits par le décodage par lots (~30 s) sont redécoupés en **phrases** pour une navigation précise.
- **GPU** : le pilote NVIDIA 512.72 (CUDA 11.6) est trop ancien pour CTranslate2 (CUDA 12). Après mise à jour du pilote (≥ 525), l'application utilise automatiquement le GPU (`int8_float16`) : c'est le levier pour une transcription quasi instantanée.
- **Qwen3 8B** : ~4,7 tokens/s (modèle réparti CPU/GPU). Compter environ 4 min d'analyse par tranche de 8 min d'audio. Pour aller plus vite (qualité moindre) : `ollama pull qwen3:4b`, puis sélection dans Paramètres.
- Whisper et Qwen ne tournent jamais en même temps : Qwen est déchargé avant la transcription pour libérer la mémoire.

## Tests

Tests réels sur de vrais fichiers audio (générés en français par la synthèse vocale Windows : réunion de 2 min, fichier long de 16 min) :

```bash
python -m pytest tests/test_core.py -v
```

```bash
python -m pytest tests/test_ai.py -v
```

`test_core.py` : FFmpeg, découpage en chunks sur fichier long, recalage des timestamps, transcription Whisper, recherche, correction, chapitres manuels, clips, exports (7 formats), sécurité (extensions, contenu, CSRF, path traversal, URL Ollama). `test_ai.py` : génération Qwen, chapitres, insights, synthèse versionnée, chat avec sources.

Test de bout en bout complet avec journal détaillé : `python tests/e2e_run.py [fichier_audio]`.

## Sécurité

Serveur lié à `127.0.0.1` uniquement ; contrôle de l'en-tête `Host` (anti DNS rebinding) ; en-tête `X-Requested-With` obligatoire et contrôle `Origin` sur les requêtes d'écriture (anti-CSRF) ; Content-Security-Policy stricte (aucun script externe) ; FFmpeg appelé avec des listes d'arguments, jamais via un shell ; noms de fichiers internes aléatoires et chemins vérifiés ; l'URL d'Ollama doit rester locale ; aucun modèle n'est téléchargé sans confirmation explicite ; les journaux ne contiennent ni audio ni transcription.

## Évolutions préparées

- **Diarisation** : table `speakers` et `transcription_segments.speaker_id` en place ; l'interface affiche déjà le locuteur et le temps de parole dès qu'il est renseigné (intégration future d'une solution locale type pyannote).
- **Recherche sémantique** : embeddings Ollama stockés dans SQLite ; l'interface `search_service.semantic_search` permet de brancher FAISS, Chroma ou Qdrant.
- **Temps réel** (microphone → Whisper streaming → Qwen) : le découpage en chunks, le stockage incrémental des segments et l'analyse par passages sont réutilisables tels quels pour une transcription et une analyse en direct.
- **Mode sombre** : tokens prêts (`data-theme="dark"`), aperçu dans Paramètres → Apparence.

## Dépannage

| Symptôme | Solution |
|---|---|
| « Ollama ne répond pas » | Lancez l'application Ollama. La transcription fonctionne sans elle ; relancez ensuite « Régénérer ». |
| « Modèle non installé » | `ollama pull qwen3:8b`, ou choisissez un modèle installé dans Paramètres. |
| FFmpeg introuvable | `winget install Gyan.FFmpeg`, ou renseignez `FFMPEG_PATH` / `FFPROBE_PATH` dans `.env`. |
| Transcription lente | Choisissez le profil « Rapide » à l'import, ou mettez à jour le pilote NVIDIA pour activer le GPU. |
| Le port 8765 est occupé | Changez `APP_PORT` dans `.env`. |
| Analyse partielle | Page **Traitements** → détails de l'erreur ; les étapes réussies sont conservées. |
| Journaux | `C:\TranscripIA-data\logs\app.log` (et page Diagnostic). |

---

BONJOUR IA — Cabinet de Conseil IA & Organisme de Formation · bonjouria.fr
