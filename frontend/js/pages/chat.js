// Chat multi-documents : sélection d'un ou plusieurs audios, historique des conversations.
import { api } from '../api.js';
import { h, ic, mount, fmtDuration, relTime, iconButton, empty, button } from '../ui.js';
import { chatBox } from '../chatbox.js';
import { navigate } from '../app.js';

export async function render(root, params) {
  let audios = [], sessions = [];
  try {
    [audios, sessions] = await Promise.all([
      api.get('/api/audio?limit=500&sort=recorded&order=asc').then((r) => r.items.filter((a) => a.status === 'analyzed' || a.status === 'transcribed')),
      api.get('/api/chat/sessions'),
    ]);
  } catch { /* affichage vide */ }
  const selected = new Set((params.ids || '').split(',').map(Number).filter(Boolean));
  if (!selected.size && audios.length) selected.add(audios[audios.length - 1].id);

  if (!audios.length) {
    mount(root, h('div', { class: 'page' }, h('div', { class: 'panel' }, empty({ icon: 'chat', title: 'Aucun audio à interroger', text: 'Importez et transcrivez un audio pour pouvoir discuter avec son contenu.', action: button('Importer un audio', { variant: 'btn-primary', icon: 'upload', onClick: () => navigate('#/import') }) }))));
    return;
  }

  const chat = chatBox({
    getAudioIds: () => [...selected],
    onSource: (s) => navigate(`#/audio/${s.audio_id}/transcript?t=${s.start}`),
    onSession: async () => { sessions = await api.get('/api/chat/sessions'); drawSide(); },
  });
  const side = h('aside', { class: 'chat-side' });
  mount(root, h('div', { class: 'chat' }, side, chat.el));

  function drawSide() {
    const pick = h('div', { class: 'audio-pick' }, audios.slice().reverse().map((a) => {
      const cb = h('input', { type: 'checkbox', checked: selected.has(a.id) ? true : null });
      cb.onchange = () => { cb.checked ? selected.add(a.id) : selected.delete(a.id); chat.reset(); drawSide(); };
      return h('label', {}, cb, h('span', {}, h('span', { style: { display: 'block', fontWeight: 500 }, text: a.title }), h('span', { class: 'caption', text: `${fmtDuration(a.duration)} · ${relTime(a.recorded_at || a.created_at)}` })));
    }));
    mount(side,
      h('div', {}, h('div', { class: 'kicker', text: 'Sources' }), h('div', { class: 'caption mb-2', text: `${selected.size} audio${selected.size > 1 ? 's' : ''} sélectionné${selected.size > 1 ? 's' : ''}` }), pick),
      h('div', {}, h('div', { class: 'row between' }, h('div', { class: 'kicker', text: 'Conversations' }), iconButton('plus', 'Nouvelle conversation', () => chat.reset(), 'btn-sm')),
        sessions.length ? h('div', { class: 'col', style: { gap: '2px' } }, sessions.slice(0, 30).map((s) => h('div', { class: 'row', style: { gap: '4px' } },
          h('button', { class: 'nav-link grow', type: 'button', style: { border: 0, background: 'none', textAlign: 'left' }, onclick: () => { selected.clear(); s.audio_ids.forEach((i) => selected.add(i)); drawSide(); chat.loadSession(s.id); } },
            ic('chat'), h('span', { class: 'truncate', text: s.title })),
          iconButton('trash', 'Supprimer', async () => { await api.del(`/api/chat/sessions/${s.id}`); sessions = sessions.filter((x) => x.id !== s.id); drawSide(); }, 'btn-sm'))))
          : h('div', { class: 'caption', text: 'Aucune conversation.' })));
  }
  drawSide();
  chat.focus();
}
