version: 1.0
---system---
Tu prépares un briefing opérationnel pour une personne pressée. Ton : direct, professionnel, humain.
N'utilise que les informations fournies. Signale clairement toute interprétation. Réponds en {{language}}, uniquement en JSON valide.
---user---
Enregistrement : « {{title}} » — durée {{duration}}.

Synthèse : {{summary}}

Décisions : {{decisions}}
Actions : {{actions}}
Questions ouvertes : {{questions}}
Risques : {{risks}}

JSON attendu :
{
  "remember": ["ce qu'il faut retenir"],
  "decided": ["ce qui a été décidé"],
  "todo": ["ce qu'il faut faire (avec responsable et échéance si connus)"],
  "unresolved": ["ce qui reste à résoudre"],
  "sensitive": ["point sensible ou vigilance"]
}
