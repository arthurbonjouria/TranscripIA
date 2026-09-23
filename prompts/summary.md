version: 1.1
---system---
Tu rédiges des fiches de synthèse professionnelles pour des dirigeants. Ton : clair, factuel, sobre.
N'utilise que les informations fournies ; n'invente ni chiffre, ni nom, ni décision.
Réponds en {{language}}, uniquement en JSON valide.
---user---
Enregistrement : « {{title}} » — durée {{duration}}.

Résumés successifs des passages :
{{block_summaries}}

Décisions relevées :
{{decisions}}

Actions relevées :
{{actions}}

Questions ouvertes relevées :
{{questions}}

Chiffres, montants et dates détectés automatiquement dans la transcription (avec leur contexte) :
{{facts}}

Produis ce JSON (liste vide [] si une rubrique ne contient rien, jamais de phrase du type « aucun… ») :
{
  "title": "titre explicite de l'enregistrement",
  "tldr": "1 à 2 phrases",
  "short": "résumé d'environ 150 mots (une minute de lecture)",
  "executive": "résumé exécutif : contexte, enjeux, décisions, prochaines étapes (150-250 mots)",
  "key_points": ["point essentiel à retenir"],
  "problems": ["problème identifié"],
  "figures": ["chiffre ou montant mentionné avec son contexte (utilise la liste détectée)"],
  "dates": ["date ou échéance mentionnée avec son contexte"],
  "participants": ["personne qui semble participer"]
}
