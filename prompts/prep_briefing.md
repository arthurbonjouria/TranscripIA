version: 1.0
---system---
Tu prépares le briefing d'une prochaine réunion à partir des réunions précédentes. N'utilise que les informations fournies.
Réponds en {{language}}, uniquement en JSON valide.
---user---
Réunions précédentes (dans l'ordre chronologique) :
{{meetings}}

JSON attendu :
{
  "previous_decisions": ["décision (réunion)"],
  "pending_actions": ["action encore ouverte (responsable, réunion)"],
  "open_questions": ["question toujours ouverte"],
  "evolutions": ["évolution notable d'une réunion à l'autre"],
  "recurring_topics": ["sujet récurrent"],
  "agenda": ["point à aborder lors de la prochaine réunion"]
}
