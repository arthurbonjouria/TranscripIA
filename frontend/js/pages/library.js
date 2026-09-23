import { api } from '../api.js';
import { h, ic, mount, skeleton, empty, errorBox, fmtDuration, fmtBytes, fmtDate, audioStatus, button, iconButton, popMenu, confirmDialog, toast, toastError, debounce, pageHead, formDialog } from '../ui.js';
import { navigate } from '../app.js';

const STATUS_FILTERS = [
  ['', 'Tous'], ['analyzed', 'Analysés'], ['transcribed', 'Transcrits'], ['processing', 'En cours'], ['queued', 'En attente'], ['failed', 'En échec'],
];

export async function render(root, params) {
  const state = { q: params.q || '', status: '', tag: '', category: '', favorite: params.favorite === '1', archived: params.archived === '1', sort: 'created', order: 'desc', selected: new Set() };
  const page = h('div', { class: 'page' });
  mount(root, page);
  const listBox = h('div');
  const bulk = h('div');
  let tags = [];
  let data = { items: [], total: 0, categories: [] };

  const toolbar = h('div', { class: 'toolbar' });
  const headerEl = pageHead({
    kicker: 'Bibliothèque', title: 'Vos', accent: 'enregistrements',
    lede: 'Retrouvez, organisez et exploitez tous vos audios analysés.',
    actions: [button('Importer', { variant: 'btn-primary', icon: 'upload', onClick: () => navigate('#/import') })],
  });
  mount(page, headerEl, toolbar, h('div', { class: 'panel' }, listBox), bulk);

  function drawToolbar() {
    const search = h('div', { class: 'search-input' }, ic('search'));
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher un titre, une description, un participant…', value: state.q, 'aria-label': 'Rechercher' });
    input.addEventListener('input', debounce(() => { state.q = input.value.trim(); load(); }, 250));
    search.appendChild(input);
    const statusSel = h('select', { class: 'select select-sm', style: { width: 'auto' }, 'aria-label': 'Statut' }, STATUS_FILTERS.map(([v, l]) => h('option', { value: v, text: l })));
    statusSel.value = state.status;
    statusSel.onchange = () => { state.status = statusSel.value; load(); };
    const tagSel = h('select', { class: 'select select-sm', style: { width: 'auto' }, 'aria-label': 'Tag' }, h('option', { value: '', text: 'Tous les tags' }), tags.map((t) => h('option', { value: t.id, text: `${t.name} (${t.count})` })));
    tagSel.value = state.tag;
    tagSel.onchange = () => { state.tag = tagSel.value; load(); };
    const catSel = h('select', { class: 'select select-sm', style: { width: 'auto' }, 'aria-label': 'Catégorie' }, h('option', { value: '', text: 'Toutes les catégories' }), data.categories.map((c) => h('option', { value: c, text: c })));
    catSel.value = state.category;
    catSel.onchange = () => { state.category = catSel.value; load(); };
    const fav = h('button', { class: `chip ${state.favorite ? 'is-active' : ''}`, type: 'button' }, ic('star'), 'Favoris');
    fav.onclick = () => { state.favorite = !state.favorite; load(); };
    const arch = h('button', { class: `chip ${state.archived ? 'is-active' : ''}`, type: 'button' }, ic('archive'), 'Archives');
    arch.onclick = () => { state.archived = !state.archived; load(); };
    mount(toolbar, search, statusSel, catSel, tagSel, fav, arch, h('span', { class: 'grow' }), h('span', { class: 'meta', text: `${data.total} audio${data.total > 1 ? 's' : ''}` }));
  }

  function sortHead(label, key, cls = '') {
    const active = state.sort === key;
    const th = h('th', { class: `sortable ${cls}`, 'aria-sort': active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none' },
      label, active ? (state.order === 'asc' ? ' ↑' : ' ↓') : '');
    th.onclick = () => { if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc'; else { state.sort = key; state.order = key === 'title' ? 'asc' : 'desc'; } load(); };
    return th;
  }

  function drawList() {
    if (!data.items.length) {
      const filtered = state.q || state.status || state.tag || state.category || state.favorite || state.archived;
      mount(listBox, filtered
        ? empty({ icon: 'search', title: 'Aucun résultat', text: 'Aucun audio ne correspond à ces critères.', action: button('Effacer les filtres', { onClick: () => { Object.assign(state, { q: '', status: '', tag: '', category: '', favorite: false, archived: false }); drawToolbar(); load(); } }) })
        : empty({ icon: 'wave', title: 'Aucun audio', text: 'Importez votre premier fichier audio pour commencer.', action: button('Importer un audio', { variant: 'btn-primary', icon: 'upload', onClick: () => navigate('#/import') }) }));
      return;
    }
    const allCb = h('input', { type: 'checkbox', 'aria-label': 'Tout sélectionner' });
    allCb.checked = data.items.every((a) => state.selected.has(a.id));
    allCb.onchange = () => { data.items.forEach((a) => (allCb.checked ? state.selected.add(a.id) : state.selected.delete(a.id))); drawList(); drawBulk(); };
    const table = h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', { style: { width: '36px' } }, allCb),
        sortHead('Titre', 'title'), h('th', { text: 'Statut' }), sortHead('Durée', 'duration', 'num'), sortHead('Date', 'recorded'),
        h('th', { class: 'num', text: 'Chapitres' }), h('th', { class: 'num', text: 'Highlights' }), h('th', { class: 'num', text: 'Personnes' }),
        sortHead('Taille', 'size', 'num'), h('th', {}))),
      h('tbody', {}, data.items.map(row)));
    mount(listBox, h('div', { style: { overflowX: 'auto' } }, table));
  }

  function row(a) {
    const cb = h('input', { type: 'checkbox', 'aria-label': `Sélectionner ${a.title}` });
    cb.checked = state.selected.has(a.id);
    cb.onchange = () => { cb.checked ? state.selected.add(a.id) : state.selected.delete(a.id); drawBulk(); };
    const fav = iconButton('star', a.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', async () => {
      await api.patch(`/api/audio/${a.id}`, { favorite: !a.favorite }); a.favorite = !a.favorite; drawList();
    }, `btn-sm fav-btn ${a.favorite ? 'is-on' : ''}`);
    const more = iconButton('more', 'Plus d’actions', (e) => popMenu(e.currentTarget, [
      { icon: 'arrowRight', label: 'Ouvrir', onClick: () => navigate(`#/audio/${a.id}`) },
      { icon: 'edit', label: 'Modifier les informations', onClick: () => editInfo(a) },
      { icon: 'download', label: 'Exporter le rapport (PDF)', onClick: () => api.download(`/api/audio/${a.id}/export?fmt=pdf`) },
      { icon: 'fileText', label: 'Exporter en Markdown', onClick: () => api.download(`/api/audio/${a.id}/export?fmt=md`) },
      { icon: 'archive', label: a.archived ? 'Désarchiver' : 'Archiver', onClick: async () => { await api.patch(`/api/audio/${a.id}`, { archived: !a.archived }); toast(a.archived ? 'Audio restauré' : 'Audio archivé', 'success'); load(); } },
      '-',
      { icon: 'trash', label: 'Supprimer', danger: true, onClick: () => remove([a.id]) },
    ]), 'btn-sm');
    return h('tr', {},
      h('td', {}, cb),
      h('td', {}, h('div', { class: 'lib-title' }, h('div', { class: 'lib-icon' }, ic('wave')),
        h('div', { style: { minWidth: 0 } },
          h('a', { href: `#/audio/${a.id}`, class: 'truncate', style: { display: 'block', maxWidth: '380px' }, text: a.title }),
          h('div', { class: 'row-wrap', style: { gap: '4px', marginTop: '2px' } },
            h('span', { class: 'meta', text: `${a.ext.toUpperCase()}${a.language ? ` · ${a.language.toUpperCase()}` : ''}${a.category ? ` · ${a.category}` : ''}` }),
            a.tags.map((t) => h('span', { class: 'tag', text: t.name })))))),
      h('td', {}, audioStatus(a.status)),
      h('td', { class: 'num', text: fmtDuration(a.duration) }),
      h('td', { class: 'nowrap', text: fmtDate(a.recorded_at || a.created_at) }),
      h('td', { class: 'num', text: a.chapter_count }),
      h('td', { class: 'num', text: a.highlight_count }),
      h('td', { class: 'num', text: a.people_count }),
      h('td', { class: 'num nowrap', text: fmtBytes(a.size_bytes) }),
      h('td', { class: 'nowrap' }, fav, more));
  }

  function drawBulk() {
    const n = state.selected.size;
    if (!n) { mount(bulk); return; }
    const ids = [...state.selected];
    mount(bulk, h('div', { class: 'bulkbar' },
      h('span', { text: `${n} sélectionné${n > 1 ? 's' : ''}` }),
      button('Discuter', { size: 'btn-sm', icon: 'chat', onClick: () => navigate(`#/chat?ids=${ids.join(',')}`) }),
      n > 1 ? button('Comparer', { size: 'btn-sm', icon: 'compare', onClick: () => navigate(`#/compare?ids=${ids.join(',')}`) }) : null,
      button(state.archived ? 'Désarchiver' : 'Archiver', { size: 'btn-sm', icon: 'archive', onClick: async () => { await Promise.all(ids.map((id) => api.patch(`/api/audio/${id}`, { archived: !state.archived }))); state.selected.clear(); load(); } }),
      button('Supprimer', { size: 'btn-sm', icon: 'trash', onClick: () => remove(ids) }),
      iconButton('close', 'Annuler la sélection', () => { state.selected.clear(); drawList(); drawBulk(); })));
  }

  async function editInfo(a) {
    const v = await formDialog('Informations de l’audio', [
      { name: 'title', label: 'Titre', value: a.title },
      { name: 'description', label: 'Description', type: 'textarea', value: a.description, rows: 3 },
      { name: 'category', label: 'Catégorie', value: a.category, placeholder: 'Réunion client, Comité, Entretien…' },
      { name: 'participants', label: 'Participants', value: a.participants },
      { name: 'recorded_at', label: "Date de l'enregistrement", type: 'date', value: (a.recorded_at || '').slice(0, 10) },
      { name: 'tags', label: 'Tags', value: a.tags.map((t) => t.name).join(', '), hint: 'Séparés par des virgules' },
    ], { kicker: 'Bibliothèque' });
    if (!v) return;
    try {
      await api.patch(`/api/audio/${a.id}`, { ...v, recorded_at: v.recorded_at || null, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean) });
      toast('Informations enregistrées', 'success');
      load();
    } catch (err) { toastError(err); }
  }

  async function remove(ids) {
    const ok = await confirmDialog(ids.length > 1 ? `Supprimer ${ids.length} audios ?` : 'Supprimer cet audio ?',
      'Le fichier audio, sa transcription, ses analyses, clips et annotations seront définitivement supprimés de cette machine. Cette action est irréversible.',
      { confirmLabel: 'Supprimer définitivement', danger: true });
    if (!ok) return;
    try {
      for (const id of ids) await api.del(`/api/audio/${id}`);
      ids.forEach((id) => state.selected.delete(id));
      toast(ids.length > 1 ? 'Audios supprimés' : 'Audio supprimé', 'success');
      load();
      drawBulk();
    } catch (err) { toastError(err); }
  }

  async function load() {
    if (!data.items.length) mount(listBox, h('div', { class: 'panel-body' }, skeleton('rows', 5)));
    try {
      [data, tags] = await Promise.all([
        api.get('/api/audio' + api.qs({ q: state.q, status: state.status, tag: state.tag, category: state.category, favorite: state.favorite ? 'true' : '', archived: state.archived, sort: state.sort, order: state.order, limit: 200 })),
        api.get('/api/tags'),
      ]);
      drawToolbar();
      drawList();
    } catch (err) {
      mount(listBox, h('div', { class: 'panel-body' }, errorBox(err, { title: "La bibliothèque n'a pas pu être chargée.", retry: load })));
    }
  }

  drawToolbar();
  await load();
}
