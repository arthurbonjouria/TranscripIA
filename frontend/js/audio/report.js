// Statistiques et générateur de rapport (PDF, DOCX, Markdown, TXT, JSON, SRT, VTT).
import { api } from '../api.js';
import { h, ic, mount, errorBox, fmtTime, fmtDuration, fmtNumber, button, skeleton } from '../ui.js';

const FORMATS = [
  { key: 'pdf', label: 'PDF', desc: 'Rapport mis en page, prêt à partager' },
  { key: 'docx', label: 'Word', desc: 'Document modifiable (DOCX)' },
  { key: 'md', label: 'Markdown', desc: 'Notion, Obsidian, wiki…' },
  { key: 'txt', label: 'Texte', desc: 'Texte brut' },
  { key: 'json', label: 'JSON', desc: 'Données structurées complètes' },
  { key: 'srt', label: 'SRT', desc: 'Sous-titres' },
  { key: 'vtt', label: 'WebVTT', desc: 'Sous-titres web' },
];
const SECTIONS = [
  ['summary', 'Fiche de synthèse, TL;DR et résumés'], ['extra', 'Résumés complémentaires'], ['chapters', 'Chapitres'],
  ['highlights', 'Moments clés'], ['decisions', 'Décisions'], ['actions', 'Actions'], ['questions', 'Questions ouvertes'],
  ['risks', 'Risques'], ['people', 'Personnes'], ['topics', 'Sujets'],
];

export async function render(root, ws, section) {
  mount(root, skeleton('lines', 8));
  let st;
  try { st = await api.get(`/api/audio/${ws.id}/stats`); } catch (err) { mount(root, errorBox(err)); return; }
  if (section === 'stats') return mount(root, stats(st, ws));
  return mount(root, report(ws, st));
}

function stats(s, ws) {
  const tile = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'stat-value', text: v }), h('div', { class: 'stat-label', text: l }));
  const counts = [['Chapitres', s.chapters], ['Highlights', s.highlights], ['Actions', s.actions], ['Décisions', s.decisions], ['Questions', s.questions], ['Risques', s.risks], ['Personnes', s.people], ['Sujets', s.topics], ['Bookmarks', s.bookmarks], ['Annotations', s.annotations], ['Clips', s.clips]];
  const max = Math.max(1, ...counts.map((c) => c[1]));
  const speakers = s.speaker_times.length ? h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Temps de parole' })),
    h('div', { class: 'panel-body bar-chart' }, s.speaker_times.map((sp) => h('div', { class: 'bar-row' }, h('span', { text: sp.name || sp.label }),
      h('div', { class: 'bar' }, h('span', { style: { width: `${(sp.talk / (s.speech_time || 1)) * 100}%` } })), h('span', { class: 'tnum', text: fmtTime(sp.talk) })))))
    : h('div', { class: 'panel panel-pad' }, h('h3', { text: 'Temps de parole' }), h('p', { class: 'muted mt-2', text: "La diarisation (identification de qui parle) n'est pas encore activée. L'architecture est prête : les segments accueilleront l'identifiant du locuteur." }));
  return h('div', { class: 'col gap-6' },
    h('div', { class: 'kpis' },
      tile(fmtDuration(s.duration), 'Durée'), tile(fmtNumber(s.words), 'Mots'), tile(fmtNumber(s.segments), 'Segments'),
      tile(s.words_per_minute ? `${s.words_per_minute}` : '—', 'Mots par minute'),
      tile(fmtDuration(s.speech_time), 'Temps de parole détecté'), tile(s.speakers || '—', 'Speakers'),
      tile(s.avg_confidence ? `${Math.round(s.avg_confidence * 100)} %` : '—', 'Confiance moyenne'), tile(fmtNumber(s.edited_segments), 'Segments corrigés')),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Contenu analysé' })),
        h('div', { class: 'panel-body bar-chart' }, counts.map(([l, v]) => h('div', { class: 'bar-row' }, h('span', { text: l }), h('div', { class: 'bar' }, h('span', { style: { width: `${(v / max) * 100}%` } })), h('span', { class: 'tnum', text: v }))))),
      speakers));
}

function report(ws, s) {
  let fmt = 'pdf';
  const checks = {};
  const includeTr = h('input', { type: 'checkbox', checked: true });
  const fmtBox = h('div', { class: 'grid grid-4' });
  const drawFormats = () => mount(fmtBox, FORMATS.map((f) => {
    const b = h('button', { type: 'button', class: 'panel', style: { padding: '16px', textAlign: 'left', cursor: 'pointer', borderColor: fmt === f.key ? 'var(--color-primary)' : null, boxShadow: fmt === f.key ? 'var(--shadow-focus)' : null, background: 'var(--color-surface)' } },
      h('div', { class: 'li-title', text: f.label }), h('div', { class: 'caption', text: f.desc }));
    b.onclick = () => { fmt = f.key; drawFormats(); };
    return b;
  }));
  drawFormats();
  const sectionsBox = h('div', { class: 'grid grid-2', style: { gap: '8px' } }, SECTIONS.map(([k, l]) => {
    const cb = h('input', { type: 'checkbox', checked: true });
    checks[k] = cb;
    return h('label', { class: 'checkbox' }, cb, l);
  }));
  const go = () => {
    const sections = Object.entries(checks).filter(([, cb]) => cb.checked).map(([k]) => k);
    const all = sections.length === SECTIONS.length;
    api.download(`/api/audio/${ws.id}/export${api.qs({ fmt, transcript: includeTr.checked, sections: all ? '' : sections.join(',') })}`);
  };
  return h('div', { class: 'col gap-6', style: { maxWidth: '980px' } },
    h('div', { class: 'panel panel-pad' },
      h('div', { class: 'kicker', text: 'Rapport' }), h('h2', { class: 'mb-2', text: 'Générer un rapport' }),
      h('p', { class: 'muted', text: 'Page de couverture, fiche de synthèse, TL;DR, résumés, chapitres, moments clés, décisions, actions, questions, risques, personnes, sujets, statistiques et transcription.' }),
      h('div', { class: 'divider-label', text: 'Format' }), fmtBox,
      h('div', { class: 'divider-label', text: 'Contenu' }), sectionsBox,
      h('label', { class: 'checkbox mt-4' }, includeTr, `Inclure la transcription complète (${fmtNumber(s.segments)} segments)`),
      h('div', { class: 'row mt-6' }, button('Télécharger le rapport', { variant: 'btn-primary btn-lg', icon: 'download', onClick: go }),
        h('span', { class: 'caption', text: 'Généré localement, en quelques secondes.' }))),
    h('div', { class: 'panel panel-pad' }, h('h3', { text: 'Exporter un passage' }),
      h('p', { class: 'muted', text: 'Sélectionnez une plage sur la waveform pour créer un clip, ou exportez un chapitre (audio, transcription, PDF) depuis la section Chapitres.' }),
      button('Aller aux chapitres', { icon: 'bookmark', onClick: () => ws.open('chapters') })));
}
