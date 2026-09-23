// Chapitrage : automatique (IA), manuel (créer, renommer, déplacer, fusionner, diviser, supprimer), réorganisation IA.
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtTime, parseTime, button, iconButton, toast, toastError, formDialog, popMenu, confirmDialog, stars, alertBox, relTime, skeleton } from '../ui.js';

export async function render(root, ws) {
  mount(root, skeleton('rows', 6));
  let data;
  const selected = new Set();

  const load = async () => {
    try { data = await api.get(`/api/audio/${ws.id}/chapters`); draw(); } catch (err) { mount(root, errorBox(err, { retry: load })); }
  };
  const apply = async (promise, msg) => {
    try { data = await promise; selected.clear(); draw(); await ws.refreshTimeline(); ws.refreshAudio(); if (msg) toast(msg, 'success'); } catch (err) { toastError(err); }
  };

  function draw() {
    const chapters = data.chapters;
    const total = ws.audio.duration || 1;
    const cur = ws.player.currentChapter();
    const head = h('div', { class: 'panel-head' },
      h('div', {}, h('h3', {}, `${chapters.length} chapitre${chapters.length > 1 ? 's' : ''}`),
        h('div', { class: 'caption', text: 'Cliquez sur un horodatage pour écouter. Toutes les modifications sont historisées.' })),
      h('div', { class: 'btn-group' },
        selected.size >= 2 ? button(`Fusionner (${selected.size})`, { size: 'btn-sm', icon: 'merge', onClick: () => apply(api.post(`/api/audio/${ws.id}/chapters/merge`, { ids: [...selected] }), 'Chapitres fusionnés') }) : null,
        button('Nouveau chapitre ici', { size: 'btn-sm', icon: 'plus', onClick: createHere }),
        button('Réorganiser avec l’IA', { size: 'btn-sm', variant: 'btn-soft', icon: 'sparkle', onClick: reorganize }),
        data.history.length > 1 ? iconButton('clock', 'Historique', (e) => popMenu(e.currentTarget, [{ title: 'Versions des chapitres' }, ...data.history.slice(0, 15).map((v) => ({
          icon: v.is_current ? 'check' : 'clock', label: `Version ${v.version} — ${v.source === 'user' ? 'manuelle' : 'IA'}`, hint: relTime(v.created_at),
          onClick: () => apply(api.post(`/api/audio/${ws.id}/chapters/restore/${v.id}`), `Version ${v.version} restaurée`),
        }))]), 'btn-sm') : null));

    const parts = [];
    if (data.proposal) parts.push(proposalBox(data.proposal));
    if (!chapters.length) {
      parts.push(h('div', { class: 'panel' }, head, empty({
        icon: 'bookmark', title: 'Aucun chapitre', text: "Les chapitres sont créés automatiquement par l'analyse IA. Vous pouvez aussi les créer vous-même à la position de lecture.",
        action: button('Créer un chapitre ici', { variant: 'btn-primary', icon: 'plus', onClick: createHere }),
      })));
      mount(root, parts);
      return;
    }
    const list = h('div', { class: 'chapter-list' }, chapters.map((c, i) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': `Sélectionner ${c.title}`, style: { accentColor: 'var(--color-primary)' } });
      cb.checked = selected.has(c.id);
      cb.onchange = () => { cb.checked ? selected.add(c.id) : selected.delete(c.id); draw(); };
      return h('div', { class: `chapter-row ${cur && cur.id === c.id ? 'is-current' : ''}` },
        h('div', { class: 'col', style: { gap: '6px', alignItems: 'center' } }, h('span', { class: 'num', text: String(i + 1).padStart(2, '0') }), cb),
        h('button', { class: 'ch-time', type: 'button', title: 'Écouter ce chapitre', onclick: () => ws.seek(c.start) }, fmtTime(c.start), h('br'), h('span', { class: 'caption', text: fmtTime(c.end - c.start) })),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'row gap-2' }, h('span', { class: 'ch-title', text: c.title }), c.source === 'user' ? h('span', { class: 'badge', text: 'modifié' }) : null, stars(c.importance)),
          c.summary ? h('div', { class: 'ch-summary', text: c.summary }) : null,
          c.topics.length ? h('div', { class: 'row-wrap mt-2' }, c.topics.map((t) => h('span', { class: 'tag', text: t }))) : null,
          h('div', { class: 'ch-bar' }, h('span', { style: { width: `${((c.end - c.start) / total) * 100}%`, marginLeft: `${(c.start / total) * 100}%` } }))),
        h('div', { class: 'li-actions' },
          iconButton('playSm', 'Écouter', () => ws.seek(c.start), 'btn-sm'),
          iconButton('edit', 'Renommer / déplacer', () => edit(c), 'btn-sm'),
          iconButton('more', 'Plus', (e) => popMenu(e.currentTarget, [
            { icon: 'split', label: `Diviser à la position de lecture (${fmtTime(ws.player.time)})`, onClick: () => apply(api.post(`/api/chapters/${c.id}/split`, { time: ws.player.time }), 'Chapitre divisé') },
            i + 1 < chapters.length ? { icon: 'merge', label: 'Fusionner avec le suivant', onClick: () => apply(api.post(`/api/audio/${ws.id}/chapters/merge`, { ids: [c.id, chapters[i + 1].id] }), 'Chapitres fusionnés') } : null,
            { icon: 'arrowRight', label: `Faire commencer à ${fmtTime(ws.player.time)}`, onClick: () => apply(api.patch(`/api/chapters/${c.id}`, { start: ws.player.time }), 'Chapitre déplacé') },
            '-',
            { title: 'Exporter ce chapitre' },
            { icon: 'download', label: 'Audio (MP3)', onClick: () => api.download(`/api/chapters/${c.id}/export?fmt=mp3`) },
            { icon: 'download', label: 'Audio (WAV)', onClick: () => api.download(`/api/chapters/${c.id}/export?fmt=wav`) },
            { icon: 'fileText', label: 'Transcription (Markdown)', onClick: () => api.download(`/api/chapters/${c.id}/export?fmt=md`) },
            { icon: 'fileText', label: 'Transcription (TXT)', onClick: () => api.download(`/api/chapters/${c.id}/export?fmt=txt`) },
            { icon: 'file', label: 'Fiche PDF', onClick: () => api.download(`/api/chapters/${c.id}/export?fmt=pdf`) },
            '-',
            { icon: 'trash', label: 'Supprimer', danger: true, onClick: async () => { if (await confirmDialog('Supprimer ce chapitre ?', 'Le passage sera rattaché au chapitre précédent. Vous pourrez revenir à une version antérieure.', { confirmLabel: 'Supprimer' })) apply(api.del(`/api/chapters/${c.id}`), 'Chapitre supprimé'); } },
          ].filter(Boolean)), 'btn-sm')));
    }));
    parts.push(h('div', { class: 'panel' }, head, list));
    mount(root, parts);
  }

  function proposalBox(p) {
    return h('div', { class: 'panel proposal mb-6' },
      h('div', { class: 'panel-body' },
        h('div', { class: 'row between', style: { flexWrap: 'wrap' } },
          h('div', {}, h('div', { class: 'kicker', text: 'Proposition de l’IA' }), h('h3', { style: { fontWeight: 500 }, text: `${p.chapters.length} chapitres proposés` }),
            p.rationale ? h('p', { class: 'muted', style: { margin: '4px 0 0' }, text: p.rationale }) : null),
          h('div', { class: 'btn-group' },
            button('Ignorer', { size: 'btn-sm', variant: 'btn-ghost', onClick: () => apply(api.post(`/api/audio/${ws.id}/chapters/proposal/dismiss`)) }),
            button('Appliquer la proposition', { size: 'btn-sm', variant: 'btn-primary', icon: 'check', onClick: () => apply(api.post(`/api/audio/${ws.id}/chapters/proposal/apply`), 'Nouvelle organisation appliquée — l’ancienne reste dans l’historique.') }))),
        h('ol', { class: 'mt-4', style: { margin: '16px 0 0', paddingLeft: '1.4em' } }, p.chapters.map((c) => h('li', { style: { padding: '3px 0' } },
          h('span', { class: 'mono caption', text: `${fmtTime(c.start)}  ` }), h('b', { text: c.title }), c.summary ? h('span', { class: 'muted', text: ` — ${c.summary}` }) : null)))));
  }

  async function createHere() {
    const v = await formDialog('Nouveau chapitre', [
      { name: 'title', label: 'Titre', placeholder: 'Budget' },
      { name: 'start', label: 'Début', value: fmtTime(ws.player.time, ws.audio.duration >= 3600), hint: 'Par défaut : la position de lecture actuelle.' },
      { name: 'summary', label: 'Résumé (optionnel)', type: 'textarea', rows: 2 },
    ], { submitLabel: 'Créer', kicker: 'Chapitrage manuel' });
    if (!v) return;
    const start = parseTime(v.start);
    if (start === null) { toast('Horodatage invalide.', 'error'); return; }
    apply(api.post(`/api/audio/${ws.id}/chapters`, { title: v.title || 'Nouveau chapitre', start, summary: v.summary }), 'Chapitre créé');
  }

  async function edit(c) {
    const v = await formDialog('Modifier le chapitre', [
      { name: 'title', label: 'Titre', value: c.title },
      { name: 'start', label: 'Début', value: fmtTime(c.start, ws.audio.duration >= 3600) },
      { name: 'summary', label: 'Résumé', type: 'textarea', value: c.summary, rows: 3 },
    ], { kicker: `Chapitre · ${fmtTime(c.start)}` });
    if (!v) return;
    const start = parseTime(v.start);
    if (start === null) { toast('Horodatage invalide.', 'error'); return; }
    apply(api.patch(`/api/chapters/${c.id}`, { title: v.title, start, summary: v.summary }), 'Chapitre enregistré');
  }

  async function reorganize() {
    try {
      const r = await api.post(`/api/audio/${ws.id}/chapters/reorganize`);
      toast("L'IA prépare une proposition. Vous pourrez l'accepter ou l'ignorer.", 'success');
      ws.watchJob(r.job_id);
    } catch (err) { toastError(err); }
  }

  const onTime = () => { const c = ws.player.currentChapter(); if (c && c.id !== lastCur) { lastCur = c.id; if (data) draw(); } };
  let lastCur = null;
  ws.player.addEventListener('state', onTime);
  await load();
  if (!ws.audio.has_summary && !data.chapters.length && ws.audio.transcription?.status === 'completed') {
    root.prepend(h('div', { class: 'mb-4' }, alertBox('info', null, "Astuce : l'analyse IA crée les chapitres automatiquement. Lancez-la depuis le bouton en haut de page.")));
  }
  return () => ws.player.removeEventListener('state', onTime);
}
