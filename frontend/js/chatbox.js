// Composant de chat RAG (un ou plusieurs audios), réponses streamées et sources horodatées cliquables.
import { api } from './api.js';
import { h, ic, mount, fmtTime, renderMarkdown, listenButton, toastError, alertBox } from './ui.js';

export const SUGGESTIONS_ONE = [
  'Quel est le sujet principal ?', 'Quelles décisions ont été prises ?', 'Qui doit faire quoi ?',
  'Quels problèmes ont été identifiés ?', 'Quelles sont les prochaines étapes ?',
];
export const SUGGESTIONS_MULTI = [
  "Qu'est-ce qui a changé depuis la première réunion ?", 'Quelles actions sont toujours ouvertes ?',
  'Quelles décisions ont été prises au fil des réunions ?', 'Quels sujets reviennent le plus souvent ?',
];

export function chatBox({ getAudioIds, sessionId = null, embedded = false, onSource, onSession }) {
  let session = sessionId;
  let busy = false;
  let controller = null;
  const scroll = h('div', { class: 'chat-scroll' });
  const inner = h('div', { class: 'chat-inner' });
  scroll.appendChild(inner);
  const ta = h('textarea', { rows: 1, placeholder: 'Posez une question sur le contenu…', 'aria-label': 'Votre question' });
  const send = h('button', { class: 'play-btn', type: 'submit', title: 'Envoyer', 'aria-label': 'Envoyer', style: { width: '38px', height: '38px' } }, ic('send'));
  const form = h('form', {}, ta, send);
  const box = h('div', { class: `chat ${embedded ? 'embedded' : ''}` }, h('div', { class: 'chat-main' }, scroll, h('div', { class: 'chat-input' }, form)));

  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(180, ta.scrollHeight)}px`; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { if (controller) controller.abort(); return; }
    const q = ta.value.trim();
    if (q) ask(q);
  });

  function welcome() {
    const multi = getAudioIds().length > 1;
    const sugg = multi ? SUGGESTIONS_MULTI : SUGGESTIONS_ONE;
    mount(inner, h('div', { class: 'col', style: { alignItems: 'center', textAlign: 'center', padding: '24px 0', gap: '14px' } },
      h('div', { class: 'kicker', text: multi ? `Chat multi-documents · ${getAudioIds().length} audios` : 'Chat avec l’audio' }),
      h('h2', {}, 'Que voulez-vous ', h('span', { class: 'accent', text: 'savoir' }), ' ?'),
      h('p', { class: 'muted', style: { maxWidth: '520px', margin: 0 }, text: 'Les réponses s’appuient uniquement sur le contenu réel des enregistrements, avec leurs sources horodatées.' }),
      h('div', { class: 'suggestions mt-2' }, sugg.map((s) => h('button', { class: 'chip', type: 'button', text: s, onclick: () => ask(s) })))));
  }

  function userMsg(text) { return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble', text })); }

  function aiMsg() {
    const bubble = h('div', { class: 'bubble' }, h('div', { class: 'typing', 'aria-label': 'Réponse en cours' }, h('span'), h('span'), h('span')));
    const el = h('div', { class: 'msg msg-ai' }, h('div', { class: 'ai-mark' }, h('img', { src: '/static/img/favicon.png', alt: '' })), bubble);
    return { el, bubble };
  }

  function renderAnswer(bubble, text, sources, final) {
    const byLabel = Object.fromEntries((sources || []).map((s) => [s.label, s]));
    const cite = (label) => {
      const s = byLabel[label];
      const b = h('button', { class: 'cite', type: 'button', text: label.replace('S', ''), title: s ? `${s.audio_title} — ${fmtTime(s.start)}` : label });
      if (s) b.onclick = () => onSource(s);
      return b;
    };
    const parts = [renderMarkdown(text, cite)];
    if (final) {
      const cited = [...new Set((text.match(/\[S\d+\]/g) || []).map((x) => x.slice(1, -1)))];
      const list = (sources || []).filter((s) => cited.includes(s.label));
      if (list.length) {
        parts.push(h('div', { class: 'sources' }, h('div', { class: 'kicker', text: 'Sources' }), list.map((s) => h('div', { class: 'source' },
          h('span', { class: 's-label', text: s.label.replace('S', '') }),
          h('div', { style: { minWidth: 0 } }, h('span', { class: 's-title', text: `${s.audio_title} · ${fmtTime(s.start)}` }), h('div', { class: 's-text clamp-2', text: s.text })),
          listenButton(s.start, () => onSource(s))))));
      } else if (sources && sources.length) {
        parts.push(h('div', { class: 'caption mt-2', text: 'Aucune source citée explicitement pour cette réponse.' }));
      }
    }
    mount(bubble, parts);
  }

  async function ask(question) {
    const ids = getAudioIds();
    if (!ids.length) { toastError(null, 'Sélectionnez au moins un audio.'); return; }
    if (!session && inner.querySelector('.suggestions')) inner.replaceChildren();
    inner.querySelector('.suggestions')?.closest('.col')?.remove();
    ta.value = '';
    ta.style.height = 'auto';
    inner.appendChild(userMsg(question));
    const { el, bubble } = aiMsg();
    inner.appendChild(el);
    scroll.scrollTop = scroll.scrollHeight;
    busy = true;
    mount(send, ic('stop'));
    send.title = 'Arrêter';
    controller = new AbortController();
    let text = '';
    let sources = [];
    let raf = null;
    try {
      await api.stream('/api/chat', { question, audio_ids: ids, session_id: session }, (ev) => {
        if (ev.type === 'session') { session = ev.session_id; onSession && onSession(session); }
        else if (ev.type === 'sources') sources = ev.sources;
        else if (ev.type === 'token') {
          text += ev.text;
          if (!raf) raf = requestAnimationFrame(() => { raf = null; renderAnswer(bubble, text, sources, false); if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160) scroll.scrollTop = scroll.scrollHeight; });
        } else if (ev.type === 'done') { cancelAnimationFrame(raf); raf = null; renderAnswer(bubble, ev.text || text, sources, true); }
        else if (ev.type === 'error') mount(bubble, alertBox('danger', "La réponse n'a pas pu être générée.", ev.error));
      }, controller.signal);
      if (!text && !bubble.querySelector('.alert') && bubble.querySelector('.typing')) mount(bubble, h('p', { class: 'muted', text: 'Réponse interrompue.' }));
    } catch (err) {
      mount(bubble, alertBox('danger', "La réponse n'a pas pu être générée.", err.message));
    } finally {
      busy = false;
      controller = null;
      mount(send, ic('send'));
      send.title = 'Envoyer';
      scroll.scrollTop = scroll.scrollHeight;
    }
  }

  async function loadSession(id) {
    session = id;
    if (!id) { welcome(); return; }
    try {
      const d = await api.get(`/api/chat/sessions/${id}`);
      inner.replaceChildren();
      d.messages.forEach((m, i) => {
        if (m.role === 'user') {
          inner.appendChild(userMsg(m.content));
          const next = d.messages[i + 1];
          if (!next || next.role !== 'assistant') {
            const { el, bubble } = aiMsg();
            mount(bubble, h('p', { class: 'muted', text: 'Réponse interrompue. Posez de nouveau la question si besoin.' }));
            inner.appendChild(el);
          }
        } else { const { el, bubble } = aiMsg(); inner.appendChild(el); renderAnswer(bubble, m.content, m.sources, true); }
      });
      scroll.scrollTop = scroll.scrollHeight;
    } catch (err) { toastError(err); welcome(); }
  }

  if (session) loadSession(session); else welcome();
  return { el: box, loadSession, reset: () => loadSession(null), ask, focus: () => ta.focus() };
}
