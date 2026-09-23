// Chat avec l'audio courant — cliquer une source positionne le lecteur au bon endroit.
import { api } from '../api.js';
import { h, mount, button, popMenu, relTime, alertBox } from '../ui.js';
import { chatBox } from '../chatbox.js';
import { navigate } from '../app.js';

export async function render(root, ws) {
  let sessions = [];
  try { sessions = await api.get(`/api/chat/sessions?audio_id=${ws.id}`); } catch { /* */ }
  const chat = chatBox({
    getAudioIds: () => [ws.id],
    sessionId: sessions[0] ? sessions[0].id : null,
    embedded: true,
    onSource: (s) => (s.audio_id === ws.id ? ws.seek(s.start) : navigate(`#/audio/${s.audio_id}/transcript?t=${s.start}`)),
  });
  const histBtn = button('Conversations', { size: 'btn-sm', icon: 'clock', onClick: (e) => popMenu(e.currentTarget, [
    { icon: 'plus', label: 'Nouvelle conversation', onClick: () => chat.reset() },
    ...(sessions.length ? ['-', { title: 'Précédentes' }] : []),
    ...sessions.slice(0, 12).map((s) => ({ icon: 'chat', label: s.title, hint: relTime(s.updated_at), onClick: () => chat.loadSession(s.id) })),
  ]) });
  const notice = ws.audio.has_summary ? null : h('div', { class: 'mb-4' }, alertBox('info', null, "L'analyse IA n'est pas encore terminée : le chat s'appuie sur la transcription seule, les réponses peuvent être moins complètes."));
  mount(root, notice, h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', {}, h('h3', { text: 'Chat avec l’audio' }), h('div', { class: 'caption', text: 'Qwen, en local. Chaque réponse cite ses sources horodatées.' })), histBtn),
    chat.el));
  chat.focus();
}
