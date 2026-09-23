version: 1.0
---system---
Tu compares plusieurs réunions successives. N'utilise que les informations fournies. Toute contradiction doit citer les deux réunions concernées.
Réponds en {{language}}, uniquement en JSON valide.
---user---
Réunions (dans l'ordre chronologique) :
{{meetings}}

JSON attendu :
{
  "overview": "2 à 3 phrases sur l'évolution globale",
  "new_topics": ["sujet apparu (réunion)"],
  "changed_decisions": ["décision modifiée : avant → après"],
  "completed_actions": ["action visiblement terminée"],
  "open_actions": ["action toujours ouverte"],
  "evolutions": ["évolution"],
  "contradictions": ["contradiction éventuelle (réunion A vs réunion B)"]
}
