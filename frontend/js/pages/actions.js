// Toutes les actions de tous les audios.
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, pageHead, listenButton, skeleton } from '../ui.js';
import { navigate } from '../app.js';

const STATUS = { todo: 'À faire', doing: 'En cours', done: 'Terminé' };

export async function render(root) {
  const page = h('div', { class: 'page' });
  const box = h('div');
  let filter = 'open';
  let items = [];
  const chips = h('div', { class: 'row-wrap mb-4' });
  mount(root, page);
  mount(page, pageHead({ kicker: 'Suivi', title: 'Actions', accent: 'à mener', lede: 'Toutes les tâches détectées dans vos enregistrements, avec leur responsable, leur échéance et leur source.' }), chips, box);

  const drawChips = () => mount(chips, [['open', 'Ouvertes'], ['todo', 'À faire'], ['doing', 'En cours'], ['done', 'Terminées'], ['all', 'Toutes']].map(([k, l]) => {
    const n = items.filter((a) => (k === 'all' ? true : k === 'open' ? a.status !== 'done' : a.status === k)).length;
    return h('button', { class: `chip ${filter === k ? 'is-active' : ''}`, type: 'button', onclick: () => { filter = k; draw(); } }, l, h('span', { class: 'count', text: n }));
  }));

  function draw() {
    drawChips();
    const list = items.filter((a) => (filter === 'all' ? true : filter === 'open' ? a.status !== 'done' : a.status === filter));
    if (!list.length) { mount(box, h('div', { class: 'panel' }, empty({ icon: 'checkSquare', title: filter === 'done' ? 'Aucune action terminée' : 'Aucune action', text: 'Les actions détectées par l’analyse de vos audios apparaîtront ici.' }))); return; }
    mount(box, h('div', { class: 'panel' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', { text: 'Action' }), h('th', { text: 'Responsable' }), h('th', { text: 'Échéance' }), h('th', { text: 'Statut' }), h('th', { text: 'Source' }))),
      h('tbody', {}, list.map((a) => {
        const check = h('button', { class: `check ${a.status === 'done' ? 'on' : ''}`, type: 'button', 'aria-label': 'Terminé' }, a.status === 'done' ? ic('check') : null);
        check.onclick = async () => { a.status = a.status === 'done' ? 'todo' : 'done'; await api.patch(`/api/items/actions/${a.id}`, { status: a.status }); draw(); };
        const sel = h('select', { class: `status-select status-${a.status}` }, Object.entries(STATUS).map(([k, l]) => h('option', { value: k, text: l })));
        sel.value = a.status;
        sel.onchange = async () => { a.status = sel.value; await api.patch(`/api/items/actions/${a.id}`, { status: a.status }); draw(); };
        return h('tr', { class: a.status === 'done' ? 'action-done' : '' },
          h('td', {}, check),
          h('td', {}, h('div', { class: 'li-title', text: a.text }), h('a', { class: 'caption', href: `#/audio/${a.audio_id}/actions`, text: a.audio_title })),
          h('td', { text: a.owner || '—' }), h('td', { text: a.deadline || '—' }), h('td', {}, sel),
          h('td', {}, a.time != null ? listenButton(a.time, () => navigate(`#/audio/${a.audio_id}/actions?t=${a.time}`)) : '—'));
      })))));
  }

  mount(box, h('div', { class: 'panel panel-pad' }, skeleton('rows', 5)));
  try { items = await api.get('/api/items/actions'); draw(); } catch (err) { mount(box, errorBox(err)); }
}
