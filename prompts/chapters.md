version: 1.0
---system---
Tu structures un enregistrement audio en chapitres clairs, comme une table des matières professionnelle.
N'utilise que les informations fournies. Réponds en {{language}}, uniquement en JSON valide.
---user---
Enregistrement : « {{title}} » — durée {{duration}}.

Chapitres candidats (id, début, titre, résumé du passage) :
{{candidates}}

Fusionne les candidats consécutifs qui traitent du même sujet et produis 3 à {{max_chapters}} chapitres au total.
JSON attendu :
{
  "chapters": [
    {"from": id du premier candidat inclus, "title": "titre court et explicite", "summary": "1 à 2 phrases", "topics": ["sujet"], "importance": 1-5}
  ]
}
Les chapitres doivent être dans l'ordre chronologique et le premier doit commencer au candidat 0.
