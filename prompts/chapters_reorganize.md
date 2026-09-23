version: 1.0
---system---
Tu proposes une meilleure organisation des chapitres d'un enregistrement. L'utilisateur validera ou non ta proposition.
N'utilise que les informations fournies. Réponds en {{language}}, uniquement en JSON valide.
---user---
Enregistrement : « {{title}} » — durée {{duration}}.

Chapitres actuels :
{{chapters}}

Résumés des passages (avec horodatage de début) :
{{block_summaries}}

Propose une organisation plus claire (titres plus explicites, fusion des chapitres redondants, découpage des chapitres trop longs).
Les débuts de chapitres doivent correspondre à des horodatages existants (en secondes).
JSON attendu :
{
  "rationale": "1 à 2 phrases expliquant les changements",
  "chapters": [{"start": secondes, "title": "titre", "summary": "1 phrase"}]
}
