// Bookmarks, annotations et clips.
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtTime, parseTime, button, iconButton, toast, toastError, formDialog, popMenu, confirmDialog, listenButton, fmtDate, skeleton } from '../ui.js';

const COLORS = [['#E83967', 'Rose'], ['#2D2D2D', 'Anthracite'], ['#3B6A8F', 'Bleu'], ['#2E7D55', 'Vert'], ['#B7791F', 'Ocre'], ['#7A5C8E', 'Prune']];

export async function quickBookmark(ws) {
  const t = ws.player.time;
  try {
    await api.post('/api/bookmarks', { audio_id: ws.id, time: t, label: 'Point à reprendre' });
    toast(`Bookmark ajouté à ${fmtTime(t)}`, 'success', { label: 'Renommer', onClick: () => ws.open('notes') });
    ws.refreshTimeline();
    if (ws.section === 'notes') ws.reloadSection();
  } catch (err) { toastError(err); }
}

export async function createClip(ws, start, end, title = '') {
  const v = await formDialog('Créer un clip', [
    { name: 'title', label: 'Titre', value: title || `Extrait ${fmtTime(start)}` },
    { name: 'start', label: 'Début', value: fmtTime(start, ws.audio.duration >= 3600), hint: 'hh:mm:ss ou mm:ss' },
    { name: 'end', label: 'Fin', value: fmtTime(end, ws.audio.duration >= 3600) },
    { name: 'description', label: 'Description', type: 'textarea', rows: 2 },
    { name: 'tags', label: 'Tags', placeholder: 'client, budget', hint: 'Séparés par des virgules' },
  ], { submitLabel: 'Créer le clip', kicker: 'Clip audio' });
  if (!v) return false;
  const s = parseTime(v.start), e = parseTime(v.end);
  if (s === null || e === null || e <= s) { toast('Horodatages invalides.', 'error'); return false; }
  try {
    await api.post('/api/clips', { audio_id: ws.id, start: s, end: e, title: v.title, description: v.description, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean) });
    toast('Clip créé — extrait audio généré par FFmpeg', 'success', { label: 'Voir', onClick: () => ws.open('notes') });
    ws.refreshTimeline();
    if (ws.section === 'notes') ws.reloadSection();
    return true;
  } catch (err) { toastError(err); return false; }
}

export async function createAnnotation(ws, start, end = null, segmentId = null) {
  const v = await formDialog(`Annotation à ${fmtTime(start)}`, [
    { name: 'text', label: 'Note', type: 'textarea', rows: 3, placeholder: 'À vérifier avec l’avocat.' },
    { name: 'category', label: 'Catégorie', placeholder: 'Juridique, Client, À vérifier…' },
    { name: 'color', label: 'Couleur', type: 'select', value: '#E83967', options: COLORS.map(([value, label]) => ({ value, label })) },
  ], { submitLabel: 'Ajouter', kicker: 'Annotation' });
  if (!v || !v.text.trim()) return false;
  try {
    await api.post('/api/annotations', { audio_id: ws.id, time: start, end, text: v.text, category: v.category, color: v.color, segment_id: segmentId });
    toast('Annotation ajoutée', 'success');
    ws.refreshTimeline();
    if (ws.section === 'notes') ws.reloadSection();
    return true;
  } catch (err) { toastError(err); return false; }
}

export async function createRangeHighlight(ws, start, end) {
  const cats = await api.get('/api/highlight-categories');
  const segs = (await api.get(`/api/audio/${ws.id}/context?time=${(start + end) / 2}&radius=${(end - start) / 2 + 1}`)).filter((s) => s.end > start && s.start < end);
  const v = await formDialog('Surligner ce passage', [
    { name: 'category', label: 'Catégorie', type: 'select', value: cats[0] && cats[0].name, options: cats.map((c) => ({ value: c.name, label: c.name })) },
    { name: 'note', label: 'Note (optionnel)', type: 'textarea', rows: 2 },
  ], { submitLabel: 'Surligner', kicker: `${fmtTime(start)} → ${fmtTime(end)}` });
  if (!v) return false;
  try {
    await api.post('/api/highlights', { audio_id: ws.id, start, end, text: segs.map((s) => s.text).join(' ') || `Passage ${fmtTime(start)}`, category: v.category, note: v.note, segment_id: segs[0] && segs[0].id });
    toast('Passage surligné', 'success');
    ws.refreshTimeline();
    return true;
  } catch (err) { toastError(err); return false; }
}

export async function render(root, ws) {
  mount(root, skeleton('lines', 8));
  let bookmarks, annotations, clips, favs;
  const load = async () => {
    try {
      [bookmarks, annotations, clips, favs] = await Promise.all([
        api.get(`/api/audio/${ws.id}/bookmarks`), api.get(`/api/audio/${ws.id}/annotations`),
        api.get(`/api/audio/${ws.id}/clips`), api.get(`/api/audio/${ws.id}/highlights?source=user`),
      ]);
      draw();
    } catch (err) { mount(root, errorBox(err, { retry: load })); }
  };

  function draw() {
    const bm = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Bookmarks ', h('span', { class: 'caption', text: bookmarks.length })),
        button('Ajouter ici', { size: 'btn-sm', icon: 'bookmark', onClick: () => quickBookmark(ws).then(load) })),
      bookmarks.length ? h('div', { class: 'panel-body list' }, bookmarks.map((b) => h('div', { class: 'list-item' },
        h('span', { style: { color: 'var(--cat-bookmark)' } }, ic('star')),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: b.label || 'Point à reprendre' }), h('div', { class: 'meta', text: fmtDate(b.created_at, true) })),
        listenButton(b.time, (t) => ws.seek(t)),
        h('div', { class: 'li-actions' },
          iconButton('edit', 'Renommer', async () => { const v = await formDialog('Renommer le bookmark', [{ name: 'label', label: 'Libellé', value: b.label }]); if (v) { await api.patch(`/api/bookmarks/${b.id}`, v); load(); ws.refreshTimeline(); } }, 'btn-sm'),
          iconButton('trash', 'Supprimer', async () => { await api.del(`/api/bookmarks/${b.id}`); load(); ws.refreshTimeline(); }, 'btn-sm')))))
        : empty({ icon: 'bookmark', title: 'Aucun bookmark', text: 'Appuyez sur B pendant la lecture pour marquer un moment à reprendre.', small: true }));

    const an = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Annotations ', h('span', { class: 'caption', text: annotations.length })),
        button('Annoter ici', { size: 'btn-sm', icon: 'note', onClick: () => createAnnotation(ws, ws.player.time).then((ok) => ok && load()) })),
      annotations.length ? h('div', { class: 'panel-body list' }, annotations.map((n) => h('div', { class: 'list-item' },
        h('span', { style: { width: '4px', alignSelf: 'stretch', borderRadius: '4px', background: n.color } }),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: n.text, style: { whiteSpace: 'pre-wrap' } }),
          h('div', { class: 'meta', text: [n.category, fmtDate(n.created_at, true)].filter(Boolean).join(' · ') })),
        listenButton(n.time, (t) => ws.seek(t)),
        h('div', { class: 'li-actions' },
          iconButton('edit', 'Modifier', async () => { const v = await formDialog('Modifier l’annotation', [{ name: 'text', label: 'Note', type: 'textarea', value: n.text }, { name: 'category', label: 'Catégorie', value: n.category }]); if (v) { await api.patch(`/api/annotations/${n.id}`, v); load(); } }, 'btn-sm'),
          iconButton('trash', 'Supprimer', async () => { await api.del(`/api/annotations/${n.id}`); load(); ws.refreshTimeline(); }, 'btn-sm')))))
        : empty({ icon: 'note', title: 'Aucune annotation', text: 'Sélectionnez un passage de la transcription ou une plage de la waveform pour l’annoter.', small: true }));

    const cl = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Clips audio ', h('span', { class: 'caption', text: clips.length })),
        button('Nouveau clip', { size: 'btn-sm', icon: 'scissors', onClick: () => createClip(ws, ws.player.time, Math.min(ws.audio.duration, ws.player.time + 30)).then((ok) => ok && load()) })),
      clips.length ? h('div', { class: 'panel-body list' }, clips.map((c) => h('div', { class: 'list-item' },
        h('span', { style: { color: 'var(--cat-clip)' } }, ic('scissors')),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title', text: c.title }),
          h('div', { class: 'meta', text: `${fmtTime(c.start)} → ${fmtTime(c.end)} · ${fmtTime(c.end - c.start)}` }),
          c.description ? h('div', { class: 'caption mt-2', text: c.description }) : null,
          c.tags.length ? h('div', { class: 'row-wrap mt-2' }, c.tags.map((t) => h('span', { class: 'tag', text: t }))) : null),
        listenButton(c.start, (t) => ws.seek(t)),
        iconButton('download', 'Exporter', (e) => popMenu(e.currentTarget, [
          { icon: 'download', label: 'MP3', onClick: () => api.download(`/api/clips/${c.id}/download?fmt=mp3`) },
          { icon: 'download', label: 'WAV', onClick: () => api.download(`/api/clips/${c.id}/download?fmt=wav`) },
          { icon: 'fileText', label: 'Transcription (TXT)', onClick: () => api.download(`/api/clips/${c.id}/download?fmt=txt`) },
          { icon: 'fileText', label: 'Markdown', onClick: () => api.download(`/api/clips/${c.id}/download?fmt=md`) },
        ]), 'btn-sm'),
        iconButton('trash', 'Supprimer', async () => { if (await confirmDialog('Supprimer ce clip ?', "L'extrait audio généré sera supprimé.", { danger: true, confirmLabel: 'Supprimer' })) { await api.del(`/api/clips/${c.id}`); load(); ws.refreshTimeline(); } }, 'btn-sm'))))
        : empty({ icon: 'scissors', title: 'Aucun clip', text: 'Glissez sur la waveform pour sélectionner une plage, puis « Créer un clip ».', small: true }));

    const fv = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Mes surlignages ', h('span', { class: 'caption', text: favs.length }))),
      favs.length ? h('div', { class: 'panel-body list' }, favs.map((f) => h('div', { class: 'list-item' },
        h('span', { style: { color: f.favorite ? 'var(--color-primary)' : 'var(--color-accent)' } }, ic(f.favorite ? 'star' : 'highlighter')),
        h('div', { class: 'li-main' }, h('span', { class: 'tag', text: f.category }), h('div', { class: 'mt-2 reading', style: { fontSize: '1rem' }, text: f.text }), f.note ? h('div', { class: 'caption mt-2', text: f.note }) : null),
        listenButton(f.start, (t) => ws.seek(t)),
        h('div', { class: 'li-actions' },
          iconButton('star', f.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', async () => { await api.patch(`/api/highlights/${f.id}`, { favorite: !f.favorite }); load(); }, 'btn-sm'),
          iconButton('trash', 'Supprimer', async () => { await api.del(`/api/highlights/${f.id}`); load(); ws.refreshTimeline(); }, 'btn-sm')))))
        : empty({ icon: 'highlighter', title: 'Aucun surlignage', text: 'Sélectionnez du texte dans la transcription pour le surligner, le classer ou l’ajouter aux favoris.', small: true }));

    mount(root, h('div', { class: 'grid grid-2' }, bm, an, cl, fv));
  }

  await load();
}
