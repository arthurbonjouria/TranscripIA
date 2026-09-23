// Transcription synchronisée : lecture, recherche, correction, surlignage, notes, panneau d'insights.
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtTime, button, iconButton, toast, toastError, popMenu, formDialog, skeleton, debounce } from '../ui.js';
import { category } from '../icons.js';
import { createAnnotation, createClip } from './notes.js';

export async function render(root, ws) {
  mount(root, skeleton('lines', 12));
  let tr, cats = [], highlights = [], annotations = [];
  try {
    [tr, cats, highlights, annotations] = await Promise.all([
      api.get(`/api/audio/${ws.id}/transcription`),
      api.get('/api/highlight-categories'),
      api.get(`/api/audio/${ws.id}/highlights`),
      api.get(`/api/audio/${ws.id}/annotations`),
    ]);
  } catch (err) { mount(root, errorBox(err)); return; }
  const segs = tr.segments;
  if (!segs.length) {
    const running = ws.job && ['QUEUED', 'PROCESSING', 'TRANSCRIBING'].includes(ws.job.status);
    mount(root, h('div', { class: 'panel' }, empty({
      icon: 'list', title: running ? 'Transcription en cours…' : 'Pas encore de transcription',
      text: running ? 'Les segments apparaîtront ici à la fin de la transcription.' : 'Lancez le traitement de cet audio pour obtenir sa transcription.',
    })));
    return;
  }

  const state = { follow: true, edit: false, query: '', hits: [], hit: -1, lowConf: false };
  const segEls = new Map();
  const chapters = ws.timeline.chapters || [];
  const catColor = Object.fromEntries(cats.map((c) => [c.name, c.color]));

  const list = h('div', { class: 'transcript', role: 'list' });
  const searchInput = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Rechercher', style: { width: '190px' }, 'aria-label': 'Rechercher dans la transcription' });
  const hitInfo = h('span', { class: 'caption tnum' });
  const followBtn = h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { state.follow = e.target.checked; } }), h('span', { class: 'track' }), 'Suivre la lecture');
  const editBtn = button('Corriger', { size: 'btn-sm', icon: 'edit', onClick: () => { state.edit = !state.edit; editBtn.classList.toggle('btn-dark', state.edit); toast(state.edit ? 'Mode correction : cliquez sur un passage pour le modifier.' : 'Mode correction désactivé', 'info'); } });
  const tools = h('div', { class: 'tr-tools' },
    h('div', { class: 'search-input' }, ic('search'), searchInput),
    iconButton('chevronLeft', 'Résultat précédent', () => jump(-1), 'btn-sm'), iconButton('chevronRight', 'Résultat suivant', () => jump(1), 'btn-sm'), hitInfo,
    h('span', { class: 'grow' }),
    followBtn, editBtn,
    iconButton('replace', 'Rechercher et remplacer', replaceAll, 'btn-sm'),
    iconButton('more', 'Options', (e) => popMenu(e.currentTarget, [
      { icon: 'eye', label: state.lowConf ? 'Masquer les passages incertains' : 'Signaler les passages incertains', onClick: () => { state.lowConf = !state.lowConf; drawSegments(); } },
      { icon: 'download', label: 'Exporter la transcription (TXT)', onClick: () => api.download(`/api/audio/${ws.id}/export?fmt=txt`) },
      { icon: 'list', label: 'Exporter les sous-titres (SRT)', onClick: () => api.download(`/api/audio/${ws.id}/export?fmt=srt`) },
    ]), 'btn-sm'));

  const side = h('aside', { class: 'panel side-sticky', 'aria-label': 'Insights' });
  const meta = tr.transcription;
  const info = h('div', { class: 'caption', style: { padding: '10px 24px', borderTop: '1px solid var(--color-border)' } },
    `${segs.length} segments · ${meta.word_count} mots · modèle Whisper ${meta.model} (${meta.device}) · langue ${meta.language.toUpperCase()}`,
    tr.versions.length > 1 ? ` · version ${meta.version}` : '');
  mount(root, h('div', { class: 'ws-grid' }, h('div', { class: 'panel' }, tools, list, info), side));

  // ------------------------------------------------------------ rendu des segments
  function drawSegments() {
    list.replaceChildren();
    segEls.clear();
    let ci = -1;
    const hlBySeg = new Map();
    highlights.forEach((hl) => {
      segs.forEach((s) => { if (s.end > hl.start && s.start < hl.end + 0.01) { if (!hlBySeg.has(s.id)) hlBySeg.set(s.id, []); hlBySeg.get(s.id).push(hl); } });
    });
    const notesBySeg = new Map();
    annotations.forEach((n) => {
      const s = segs.find((x) => x.start <= n.time + 0.01 && x.end >= n.time - 0.01) || segs.reduce((a, b) => (Math.abs(b.start - n.time) < Math.abs(a.start - n.time) ? b : a));
      if (!notesBySeg.has(s.id)) notesBySeg.set(s.id, []);
      notesBySeg.get(s.id).push(n);
    });
    const frag = document.createDocumentFragment();
    segs.forEach((s) => {
      while (ci + 1 < chapters.length && chapters[ci + 1].start <= s.start + 0.01) {
        ci++;
        const ch = chapters[ci];
        const sep = h('div', { class: 'chapter-sep' }, h('span', { class: 'kicker', text: `Chapitre ${ci + 1}` }), h('h3', { text: ch.title }),
          h('button', { class: 'btn-link caption', type: 'button', text: fmtTime(ch.start), onclick: () => ws.seek(ch.start) }));
        frag.appendChild(sep);
      }
      const hls = hlBySeg.get(s.id) || [];
      const userHl = hls.find((x) => x.source === 'user');
      const aiHl = hls.find((x) => x.source !== 'user' && x.importance >= 0.6);
      const cls = ['seg', s.edited ? 'is-edited' : '', userHl ? 'is-hl' : '', aiHl ? 'is-ai-hl' : '', state.lowConf && s.confidence !== null && s.confidence < 0.55 ? 'is-low' : ''].join(' ');
      const style = {};
      if (userHl) style['--hl-color'] = hexAlpha(catColor[userHl.category] || '#E83967', 0.28);
      if (aiHl && !userHl) style['--hl-color'] = category(aiHl.category).color;
      const text = h('div', { class: 'seg-text', dataset: { id: s.id } });
      if (s.speaker) text.appendChild(h('span', { class: 'speaker', text: s.speaker_name || s.speaker }));
      text.appendChild(textWithHits(s.text));
      (notesBySeg.get(s.id) || []).forEach((n) => text.appendChild(h('span', { class: 'seg-note', style: { '--note-color': n.color } }, ic('note'), ' ', n.text)));
      const title = [s.edited ? `Corrigé — original : « ${s.original} »` : '', s.confidence !== null ? `Confiance ${Math.round(s.confidence * 100)} %` : '', aiHl ? `${category(aiHl.category).label} : ${aiHl.text}` : ''].filter(Boolean).join('\n');
      const row = h('div', { class: cls, style, role: 'listitem', title: title || null },
        h('button', { class: 'seg-time', type: 'button', text: fmtTime(s.start), title: `Écouter à ${fmtTime(s.start)}`, onclick: () => ws.seek(s.start) }),
        text);
      text.addEventListener('click', () => { if (state.edit) editSegment(s, text); });
      text.addEventListener('dblclick', () => { if (!state.edit) ws.seek(s.start); });
      segEls.set(s.id, row);
      frag.appendChild(row);
    });
    list.appendChild(frag);
    lastActive = null;
    sync();
  }

  function textWithHits(text) {
    if (!state.query) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    const q = normalize(state.query);
    const nt = normalize(text);
    let i = 0, pos;
    while (q && (pos = nt.indexOf(q, i)) !== -1) {
      frag.appendChild(document.createTextNode(text.slice(i, pos)));
      frag.appendChild(h('mark', { class: 'search-hit', text: text.slice(pos, pos + q.length) }));
      i = pos + q.length;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }

  // ------------------------------------------------------------ synchronisation avec la lecture
  let lastActive = null;
  function activeIndex(t) {
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function sync() {
    const i = activeIndex(ws.player.time);
    const s = segs[i];
    if (!s || s.id === lastActive) return;
    if (lastActive && segEls.get(lastActive)) segEls.get(lastActive).classList.remove('is-active');
    const el = segEls.get(s.id);
    if (el) {
      el.classList.add('is-active');
      if (state.follow && ws.player.playing && !state.editingNow) {
        const r = el.getBoundingClientRect();
        const topLimit = 320, bottomLimit = window.innerHeight - 80;
        if (r.top < topLimit || r.bottom > bottomLimit) window.scrollBy({ top: r.top - window.innerHeight * 0.45, behavior: 'smooth' });
      }
    }
    lastActive = s.id;
  }
  const onTime = () => sync();
  ws.player.addEventListener('time', onTime);

  // ------------------------------------------------------------ recherche dans la transcription
  const normalize = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  searchInput.addEventListener('input', debounce(() => {
    state.query = searchInput.value.trim();
    state.hits = state.query ? segs.filter((s) => normalize(s.text).includes(normalize(state.query))) : [];
    state.hit = state.hits.length ? 0 : -1;
    hitInfo.textContent = state.query ? `${state.hits.length} résultat${state.hits.length > 1 ? 's' : ''}` : '';
    drawSegments();
    if (state.hits.length) focusHit();
  }, 250));
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } });
  function jump(d) {
    if (!state.hits.length) return;
    state.hit = (state.hit + d + state.hits.length) % state.hits.length;
    focusHit();
  }
  function focusHit() {
    const s = state.hits[state.hit];
    hitInfo.textContent = `${state.hit + 1} / ${state.hits.length}`;
    const el = segEls.get(s.id);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ws.player.seek(s.start);
  }

  // ------------------------------------------------------------ correction
  function editSegment(s, el) {
    if (el.isContentEditable) return;
    state.editingNow = true;
    const original = s.text;
    el.textContent = s.text;
    el.contentEditable = 'true';
    el.classList.add('editable');
    el.focus();
    const finish = async (save) => {
      el.contentEditable = 'false';
      el.classList.remove('editable');
      state.editingNow = false;
      const v = el.textContent.replace(/\s+/g, ' ').trim();
      if (save && v && v !== original) {
        try {
          const r = await api.patch(`/api/segments/${s.id}`, { text: v });
          s.text = r.text; s.edited = r.edited;
          toast('Correction enregistrée. Les prochaines analyses utiliseront cette version.', 'success');
          ws.refreshAudio();
        } catch (err) { toastError(err); }
      }
      drawSegments();
    };
    el.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.onblur = null; finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); el.onblur = null; finish(false); }
    };
    el.onblur = () => finish(true);
  }

  async function replaceAll() {
    const v = await formDialog('Rechercher et remplacer', [
      { name: 'find', label: 'Rechercher', placeholder: 'Apple play' },
      { name: 'replace', label: 'Remplacer par', placeholder: 'Apple Pay' },
    ], { submitLabel: 'Remplacer partout', kicker: 'Correction de transcription' });
    if (!v || !v.find.trim()) return;
    try {
      const r = await api.post(`/api/audio/${ws.id}/transcription/replace`, { find: v.find, replace: v.replace });
      toast(`${r.updated} passage${r.updated > 1 ? 's' : ''} corrigé${r.updated > 1 ? 's' : ''}. L'original reste conservé.`, 'success');
      const fresh = await api.get(`/api/audio/${ws.id}/transcription`);
      segs.splice(0, segs.length, ...fresh.segments);
      drawSegments();
      ws.refreshAudio();
    } catch (err) { toastError(err); }
  }

  // ------------------------------------------------------------ sélection de texte → surligner / noter / clip
  let selBar = null;
  const hideSel = () => { if (selBar) { selBar.remove(); selBar = null; } };
  function selectionInfo() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const segOf = (node) => { const el = (node.nodeType === 1 ? node : node.parentElement)?.closest('.seg-text'); return el ? segs.find((s) => String(s.id) === el.dataset.id) : null; };
    const a = segOf(sel.anchorNode), b = segOf(sel.focusNode);
    if (!a || !b) return null;
    const [s1, s2] = a.start <= b.start ? [a, b] : [b, a];
    return { text, start: s1.start, end: s2.end, segment: s1, rect: sel.getRangeAt(0).getBoundingClientRect() };
  }
  const onMouseUp = () => setTimeout(() => {
    if (state.edit) return;
    const info = selectionInfo();
    hideSel();
    if (!info) return;
    const act = (label, icoName, fn) => h('button', { type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { hideSel(); fn(info); } }, ic(icoName), label);
    selBar = h('div', { class: 'sel-toolbar', role: 'toolbar', 'aria-label': 'Actions sur la sélection' },
      act('Surligner', 'highlighter', (i) => pickCategory(i)),
      act('Note', 'note', async (i) => { if (await createAnnotation(ws, i.start, i.end, i.segment.id)) reloadMarks(); }),
      act('Favori', 'star', (i) => saveHighlight(i, 'Important', true)),
      act('Clip', 'scissors', (i) => createClip(ws, i.start, i.end, i.text.slice(0, 80))),
      act('Écouter', 'playSm', (i) => ws.seek(i.start)));
    document.body.appendChild(selBar);
    const r = info.rect;
    selBar.style.left = `${Math.max(8, Math.min(window.innerWidth - selBar.offsetWidth - 8, r.left + r.width / 2 - selBar.offsetWidth / 2))}px`;
    selBar.style.top = `${Math.max(8, r.top - selBar.offsetHeight - 10)}px`;
  }, 10);
  list.addEventListener('mouseup', onMouseUp);
  const onDocDown = (e) => { if (selBar && !selBar.contains(e.target)) hideSel(); };
  document.addEventListener('mousedown', onDocDown);

  function pickCategory(info) {
    const anchor = h('span', { style: { position: 'fixed', left: `${info.rect.left + info.rect.width / 2}px`, top: `${info.rect.bottom}px` } });
    document.body.appendChild(anchor);
    popMenu(anchor, [{ title: 'Catégorie' }, ...cats.map((c) => ({ icon: 'highlighter', label: c.name, onClick: () => saveHighlight(info, c.name) })),
      '-', { icon: 'plus', label: 'Nouvelle catégorie…', onClick: async () => {
        const v = await formDialog('Nouvelle catégorie', [{ name: 'name', label: 'Nom', placeholder: 'Juridique' }, { name: 'color', label: 'Couleur', type: 'color', value: '#E83967' }]);
        if (!v || !v.name.trim()) return;
        const c = await api.post('/api/highlight-categories', v);
        cats.push(c); catColor[c.name] = c.color;
        saveHighlight(info, c.name);
      } }]);
    setTimeout(() => anchor.remove(), 100);
  }

  async function saveHighlight(info, cat, favorite = false) {
    try {
      await api.post('/api/highlights', { audio_id: ws.id, start: info.start, end: info.end, text: info.text, category: cat, favorite, segment_id: info.segment.id, importance: favorite ? 0.8 : 0.6 });
      toast(favorite ? 'Ajouté aux favoris' : `Surligné · ${cat}`, 'success');
      document.getSelection().removeAllRanges();
      reloadMarks();
    } catch (err) { toastError(err); }
  }

  async function reloadMarks() {
    [highlights, annotations] = await Promise.all([api.get(`/api/audio/${ws.id}/highlights`), api.get(`/api/audio/${ws.id}/annotations`)]);
    drawSegments();
    ws.refreshTimeline();
  }

  // ------------------------------------------------------------ panneau d'insights
  async function drawSide() {
    let ins;
    try { ins = await api.get(`/api/audio/${ws.id}/insights`); } catch { mount(side, h('div', { class: 'panel-body caption', text: 'Insights indisponibles.' })); return; }
    const group = (title, items, ico, color, fmt, target) => {
      if (!items.length) return null;
      return h('div', { class: 'insight-group' },
        h('h4', {}, title, h('span', { class: 'n', text: items.length })),
        items.slice(0, 6).map((it) => {
          const t = it.time ?? it.start;
          return h('div', { class: 'insight', role: 'button', tabindex: '0', onclick: () => goTo(t), onkeydown: (e) => { if (e.key === 'Enter') goTo(t); } },
            h('span', { class: 'i-ico', style: { '--c': color } }, ic(ico)),
            h('div', {}, h('span', { class: `i-text ${it.kind === 'inference' ? 'inference' : ''}`, text: fmt(it) }), h('span', { class: 'i-meta', text: t != null ? fmtTime(t) : '' })));
        }),
        items.length > 6 ? h('a', { class: 'btn-link caption', href: `#/audio/${ws.id}/${target}`, text: `Voir les ${items.length}` }) : null);
    };
    const body = [
      group('Moments clés', ins.key_moments, 'flame', 'var(--color-primary)', (x) => x.text, 'moments'),
      group('Décisions', ins.decisions, 'check', 'var(--cat-decision)', (x) => x.text, 'decisions'),
      group('Actions', ins.actions, 'arrowRight', 'var(--cat-action)', (x) => x.text + (x.owner ? ` — ${x.owner}` : ''), 'actions'),
      group('Questions', ins.questions, 'question', 'var(--cat-question)', (x) => x.text, 'questions'),
      group('Risques', ins.risks, 'alert', 'var(--cat-risk)', (x) => x.text, 'questions'),
    ].filter(Boolean);
    mount(side, h('div', { class: 'panel-head' }, h('h3', {}, 'Insights'), h('a', { class: 'btn btn-sm btn-ghost', href: `#/audio/${ws.id}/insights`, text: 'Tout voir' })),
      body.length ? body : h('div', { class: 'panel-body' }, empty({ icon: 'sparkle', title: 'Pas encore d’insights', text: "Ils apparaîtront après l'analyse IA.", small: true })));
  }
  function goTo(t) {
    ws.seek(t);
    const i = activeIndex(t);
    const el = segs[i] && segEls.get(segs[i].id);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  drawSegments();
  drawSide();
  // aller au segment courant à l'ouverture
  setTimeout(() => { const i = activeIndex(ws.player.time); if (i > 0 && segEls.get(segs[i].id)) segEls.get(segs[i].id).scrollIntoView({ block: 'center' }); }, 50);

  return () => {
    ws.player.removeEventListener('time', onTime);
    document.removeEventListener('mousedown', onDocDown);
    hideSel();
  };
}

function hexAlpha(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return `rgba(232,57,103,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
