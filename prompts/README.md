# Prompts IA

Chaque fichier `.md` est un prompt utilisé par le backend. Ils peuvent être modifiés sans toucher au code.

- La première ligne `version: x.y` est enregistrée avec chaque analyse (traçabilité, invalidation du cache).
- Les variables `{{nom}}` sont remplacées au moment de l'appel.
- Le texte après la ligne `---system---` est le message système, le texte après `---user---` le message utilisateur.

| Fichier | Usage |
|---|---|
| `block_analysis.md` | Analyse d'un bloc de transcription (étape « map ») : résumé, chapitres candidats, highlights, actions, décisions, questions, risques, personnes, entités, sujets. Regroupe `highlights`, `actions`, `decisions`, `entities`, `topics`, `risks`, `questions` en un seul appel pour limiter le temps de calcul. |
| `chapters.md` | Consolidation des chapitres candidats en chapitres définitifs. |
| `summary.md` | Fiche de synthèse (TL;DR, résumé court, résumé exécutif, points clés, citations). |
| `summary_detailed.md` | Résumé détaillé. |
| `summary_chronological.md` | Résumé chronologique. |
| `summary_thematic.md` | Résumé par thème. |
| `briefing.md` | « Générer mon briefing » pour un audio. |
| `prep_briefing.md` | Briefing avant réunion à partir de plusieurs audios. |
| `comparison.md` | Comparaison de réunions. |
| `chat.md` | Chat avec l'audio (RAG, sources citées). |
| `chapters_reorganize.md` | « Réorganiser avec l'IA ». |
