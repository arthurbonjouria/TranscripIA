// Espace de travail d'un audio : en-tête, lecteur + waveform (centre visuel), sections.
import { api } from '../api.js';
import { h, ic, mount, clear, skeleton, errorBox, fmtDuration, fmtDate, audioStatus, button, iconButton, popMenu, toast, toastError, confirmDialog, formDialog, isActiveJob, alertBox, modal } from '../ui.js';
import { Player, controlsBar, bindShortcuts, SHORTCUTS } from '../player.js';
import { Waveform } from '../waveform.js';
import { navigate } from '../app.js';
import { progressPanel } from '../audio/progress.js';

export const SECTIONS = [
  { key: 'overview', label: 'Fiche de synthèse', icon: 'fileText' },
  { key: 'transcript', label: 'Transcription', icon: 'list' },
  { key: 'chapters', label: 'Chapitres', icon: 'bookmark', count: 'chapter_count' },
  { key: 'insights', label: 'Insights', icon: 'sparkle' },
  { key: 'moments', label: 'Moments clés', icon: 'flame', count: 'highlight_count' },
  { key: 'actions', label: 'Actions', icon: 'checkSquare', count: 'action_count' },
  { key: 'decisions', label: 'Décisions', icon: 'check', count: 'decision_count' },
  { key: 'questions', label: 'Questions & risques', icon: 'question' },
  { key: 'people', label: 'Personnes', icon: 'users', count: 'people_count' },
  { key: 'topics', label: 'Sujets & entités', icon: 'tag' },
  { key: 'notes', label: 'Bookmarks, notes & clips', icon: 'note' },
  { key: 'chat', label: 'Chat avec l’audio', icon: 'chat' },
  { key: 'stats', label: 'Statistiques', icon: 'chart' },
  { key: 'report', label: 'Rapport & exports', icon: 'download' },
];

const LOADERS = {
  overview: () => import('../audio/overview.js'),
  transcript: () => import('../audio/transcript.js'),
  chapters: () => import('../audio/chapters.js'),
  insights: () => import('../audio/insights.js'),
  moments: () => import('../audio/insights.js'),
  actions: () => import('../audio/insights.js'),
  decisions: () => import('../audio/insights.js'),
  questions: () => import('../audio/insights.js'),
  people: () => import('../audio/insights.js'),
  topics: () => import('../audio/insights.js'),
  notes: () => import('../audio/notes.js'),
  chat: () => import('../audio/chat.js'),
  stats: () => import('../audio/report.js'),
  report: () => import('../audio/report.js'),
};

let active = null; // instance courante, pour onSection()

export async function onSection(section, params = {}) {
  if (!active) return;
  active.open(section);
  if (params.t) active.seek(Number(params.t));
}

export async function render(root, params, ctx) {
  const id = Number(params.id);
  const shell = h('div', { class: 'ws' });
  mount(root, shell);
  mount(shell, h('div', { class: 'page' }, skeleton('page')));

  let audio;
  try {
    audio = await api.get(`/api/audio/${id}?touch=true`);
  } catch (err) {
    mount(shell, h('div', { class: 'page' }, errorBox(err, { title: "Cet audio n'a pas pu être ouvert.", retry: () => render(root, params, ctx) })));
    return;
  }
  document.title = `${audio.title} · BONJOUR IA`;

  const player = new Player(`/api/audio/${id}/stream`);
  const wave = new Waveform(player, { duration: audio.duration });
  const ws = {
    id, audio, player, wave, timeline: {}, section: null, ctx,
    seek(t, play = true) { player.seek(Number(t)); if (play) player.play(); },
    async refreshAudio() { ws.audio = await api.get(`/api/audio/${id}`); drawHead(); drawSidebar(); return ws.audio; },
    async refreshTimeline() {
      try {
        ws.timeline = await api.get(`/api/audio/${id}/timeline`);
        player.chapters = ws.timeline.chapters;
        wave.setData(ws.timeline);
      } catch { /* timeline indisponible */ }
      return ws.timeline;
    },
    open: (s) => open(s),
    reloadSection: () => open(ws.section, true),
    job: null,
  };
  active = ws;

  const head = h('header', { class: 'ws-head' });
  const tabs = h('div', { class: 'ws-tabs sidebar-driven' });
  const playerBox = h('section', { class: 'player', 'aria-label': 'Lecteur audio' }, wave.el, controlsBar(player));
  const progressBox = h('div');
  const body = h('div', { class: 'ws-body' });
  mount(shell, head, tabs, playerBox, h('div', { class: 'ws-body', style: { paddingBottom: 0 } }, progressBox), body);

  // ------------------------------------------------------------ en-tête
  function drawHead() {
    const a = ws.audio;
    const title = h('h1', { text: a.title, title: 'Double-cliquez pour renommer' });
    title.ondblclick = () => renameInline(title);
    const meta = h('div', { class: 'ws-meta' },
      h('span', { text: fmtDuration(a.duration) }),
      h('span', { text: fmtDate(a.recorded_at || a.created_at) }),
      a.participants ? h('span', { class: 'truncate', style: { maxWidth: '420px' }, text: a.participants }) : null,
      a.language ? h('span', { text: a.language.toUpperCase() }) : null,
      h('span', {}, audioStatus(a.status)),
      a.analysis_stale ? h('span', {}, h('span', { class: 'badge badge-warning', title: 'La transcription a été corrigée depuis la dernière analyse.', text: 'Analyse à actualiser' })) : null);
    const fav = iconButton('star', a.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', async () => {
      await api.patch(`/api/audio/${id}`, { favorite: !a.favorite }); await ws.refreshAudio();
    }, `fav-btn ${a.favorite ? 'is-on' : ''}`);
    const hasTr = a.transcription && a.transcription.status === 'completed';
    const actions = h('div', { class: 'ws-actions' },
      fav,
      button('Chat', { icon: 'chat', onClick: () => navigate(`#/audio/${id}/chat`) }),
      button('Exporter', { icon: 'download', onClick: (e) => exportMenu(e.currentTarget) }),
      hasTr ? button(a.has_summary ? 'Régénérer' : "Lancer l'analyse IA", { icon: 'sparkle', variant: a.has_summary ? '' : 'btn-primary', onClick: regenerate }) : null,
      iconButton('more', 'Plus d’actions', (e) => popMenu(e.currentTarget, [
        { icon: 'edit', label: 'Modifier les informations', onClick: editInfo },
        { icon: 'refresh', label: 'Retranscrire avec d’autres réglages', onClick: retranscribe },
        { icon: 'info', label: 'Raccourcis clavier', onClick: showShortcuts },
        { icon: 'archive', label: a.archived ? 'Désarchiver' : 'Archiver', onClick: async () => { await api.patch(`/api/audio/${id}`, { archived: !a.archived }); await ws.refreshAudio(); toast('Enregistré', 'success'); } },
        '-',
        { icon: 'trash', label: 'Supprimer', danger: true, onClick: remove },
      ])));
    mount(head, h('div', { class: 'row between', style: { alignItems: 'flex-start', gap: '24px', flexWrap: 'wrap' } },
      h('div', { class: 'grow' }, h('div', { class: 'kicker', text: a.category || 'Audio' }), title, meta), actions));
  }

  function renameInline(el) {
    el.contentEditable = 'true';
    el.classList.add('editable');
    el.focus();
    document.getSelection().selectAllChildren(el);
    const done = async (save) => {
      el.contentEditable = 'false';
      el.classList.remove('editable');
      const v = el.textContent.trim();
      if (save && v && v !== ws.audio.title) {
        try { await api.patch(`/api/audio/${id}`, { title: v }); await ws.refreshAudio(); toast('Titre enregistré', 'success'); } catch (err) { toastError(err); }
      } else el.textContent = ws.audio.title;
    };
    el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } if (e.key === 'Escape') { el.textContent = ws.audio.title; el.blur(); } };
    el.onblur = () => done(true);
  }

  function exportMenu(anchor) {
    const dl = (fmt, transcript = true) => api.download(`/api/audio/${id}/export?fmt=${fmt}&transcript=${transcript}`);
    popMenu(anchor, [
      { title: 'Rapport complet' },
      { icon: 'file', label: 'PDF', hint: 'rapport', onClick: () => dl('pdf') },
      { icon: 'fileText', label: 'Word (DOCX)', onClick: () => dl('docx') },
      { icon: 'fileText', label: 'Markdown', onClick: () => dl('md') },
      { icon: 'fileText', label: 'Texte brut (TXT)', onClick: () => dl('txt') },
      { icon: 'database', label: 'JSON (données)', onClick: () => dl('json') },
      '-',
      { title: 'Sous-titres' },
      { icon: 'list', label: 'SRT', onClick: () => dl('srt') },
      { icon: 'list', label: 'WebVTT', onClick: () => dl('vtt') },
      '-',
      { icon: 'settings', label: 'Rapport personnalisé…', onClick: () => navigate(`#/audio/${id}/report`) },
    ]);
  }

  async function regenerate() {
    const a = ws.audio;
    if (a.has_summary) {
      const ok = await confirmDialog('Régénérer l’analyse IA ?', "Les chapitres, la synthèse, les moments clés, décisions et actions seront recalculés à partir de la transcription actuelle. Les versions précédentes restent disponibles dans l'historique ; vos éléments ajoutés manuellement sont conservés.", { confirmLabel: 'Régénérer' });
      if (!ok) return;
    }
    try {
      const r = await api.post(`/api/audio/${id}/regenerate`, { force: true });
      toast('Analyse IA lancée', 'success');
      watchJob(r.job_id);
    } catch (err) { toastError(err); }
  }

  async function retranscribe() {
    const v = await formDialog('Retranscrire l’audio', [
      { name: 'profile', label: 'Vitesse / qualité', type: 'select', value: 'precis', options: [{ value: 'rapide', label: 'Rapide (base)' }, { value: 'equilibre', label: 'Équilibré (small)' }, { value: 'precis', label: 'Précis (small, beam 5)' }] },
      { name: 'language', label: 'Langue', type: 'select', value: ws.audio.language || '', options: [{ value: '', label: 'Détection automatique' }, { value: 'fr', label: 'Français' }, { value: 'en', label: 'Anglais' }, { value: 'es', label: 'Espagnol' }, { value: 'de', label: 'Allemand' }, { value: 'it', label: 'Italien' }] },
    ], { submitLabel: 'Retranscrire', kicker: 'Transcription' });
    if (!v) return;
    try {
      const r = await api.post(`/api/audio/${id}/process`, { language: v.language, profile: v.profile, retranscribe: true, force: true });
      toast('Nouvelle transcription lancée. La précédente reste dans l’historique.', 'success');
      watchJob(r.job_id);
    } catch (err) { toastError(err); }
  }

  async function editInfo() {
    const a = ws.audio;
    const v = await formDialog('Informations de l’audio', [
      { name: 'title', label: 'Titre', value: a.title },
      { name: 'description', label: 'Description', type: 'textarea', value: a.description, rows: 3 },
      { name: 'category', label: 'Catégorie', value: a.category },
      { name: 'participants', label: 'Participants', value: a.participants },
      { name: 'recorded_at', label: "Date de l'enregistrement", type: 'date', value: (a.recorded_at || '').slice(0, 10) },
      { name: 'tags', label: 'Tags', value: (a.tags || []).map((t) => t.name).join(', '), hint: 'Séparés par des virgules' },
    ]);
    if (!v) return;
    try {
      await api.patch(`/api/audio/${id}`, { ...v, recorded_at: v.recorded_at || null, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean) });
      await ws.refreshAudio();
      toast('Informations enregistrées', 'success');
    } catch (err) { toastError(err); }
  }

  async function remove() {
    const ok = await confirmDialog('Supprimer cet audio ?', 'Le fichier, sa transcription et toutes ses analyses seront définitivement supprimés de cette machine.', { confirmLabel: 'Supprimer définitivement', danger: true });
    if (!ok) return;
    await api.del(`/api/audio/${id}`);
    toast('Audio supprimé', 'success');
    navigate('#/library');
  }

  function showShortcuts() {
    modal({ title: 'Raccourcis clavier', kicker: 'Lecteur', body: h('table', { class: 'table' }, h('tbody', {}, SHORTCUTS.map(([k, v]) => h('tr', {}, h('td', {}, k.split(' / ').map((x, i) => [i ? ' / ' : '', h('span', { class: 'kbd', text: x })])), h('td', { text: v }))))) });
  }

  // ------------------------------------------------------------ navigation interne
  function drawSidebar() {
    const a = ws.audio;
    const nav = h('div', { class: 'nav-section' },
      h('a', { class: 'nav-link nav-back', href: '#/library' }, ic('arrowLeft'), h('span', { text: 'Bibliothèque' })),
      h('div', { class: 'nav-title', text: 'Cet audio' }),
      SECTIONS.map((s) => {
        const link = h('a', { class: `nav-link ${ws.section === s.key ? 'is-active' : ''}`, href: `#/audio/${id}/${s.key}` }, ic(s.icon), h('span', { text: s.label }));
        if (s.count && a[s.count]) link.appendChild(h('span', { class: 'nav-count', text: String(a[s.count]) }));
        return link;
      }));
    ctx.setSidebar(nav);
    mount(tabs, h('div', { class: 'tabs' }, SECTIONS.map((s) => h('a', { class: `tab ${ws.section === s.key ? 'is-active' : ''}`, href: `#/audio/${id}/${s.key}`, text: s.label }))));
  }

  let sectionCleanup = null;
  async function open(section, force = false) {
    const key = SECTIONS.some((s) => s.key === section) ? section : (ws.audio.has_summary ? 'overview' : 'transcript');
    if (key === ws.section && !force) return;
    if (sectionCleanup) { try { sectionCleanup(); } catch { /* */ } sectionCleanup = null; }
    ws.section = key;
    drawSidebar();
    mount(body, skeleton('lines', 8));
    try {
      const mod = await LOADERS[key]();
      if (ws.section !== key) return;
      const res = await mod.render(body, ws, key);
      if (typeof res === 'function') sectionCleanup = res;
    } catch (err) {
      console.error(err);
      mount(body, errorBox(err, { title: "Cette section n'a pas pu être chargée.", retry: () => open(key, true) }));
    }
  }

  // ------------------------------------------------------------ suivi du traitement
  let jobTimer = null;
  async function watchJob(jobId) {
    clearTimeout(jobTimer);
    const tick = async () => {
      let job;
      try { job = await api.get(`/api/jobs/${jobId}`); } catch { jobTimer = setTimeout(tick, 4000); return; }
      ws.job = job;
      mount(progressBox, progressPanel(job, { onCancel: async () => { await api.post(`/api/jobs/${jobId}/cancel`); tick(); }, onRetry: async () => { const r = await api.post(`/api/jobs/${jobId}/retry`); watchJob(r.job_id); } }));
      if (isActiveJob(job.status)) {
        jobTimer = setTimeout(tick, 2000);
        const tr = job.steps.find((s) => s.key === 'transcribe');
        const mark = tr && tr.status === 'running' ? tr.message : null;
        if (mark && mark !== ws._lastChunkMsg) {
          const first = ws._lastChunkMsg === undefined;
          ws._lastChunkMsg = mark;
          if (!first && ws.section === 'transcript') open('transcript', true);
        }
        // la transcription s'affiche dès qu'elle est prête
        if (!ws._peaksLoaded && job.steps.find((s) => s.key === 'prepare' && s.status === 'done')) loadPeaks();
      } else {
        await ws.refreshAudio();
        await ws.refreshTimeline();
        loadPeaks();
        if (job.status === 'COMPLETED') {
          toast(job.error ? 'Traitement terminé, avec des avertissements.' : 'Analyse terminée.', job.error ? 'info' : 'success');
          if (!job.error) setTimeout(() => { if (ws.job && ws.job.id === job.id && !isActiveJob(ws.job.status)) clear(progressBox); }, 6000);
        }
        open(ws.section, true);
      }
    };
    tick();
  }

  async function loadPeaks() {
    try {
      const p = await api.get(`/api/audio/${id}/peaks`);
      if (p && p.peaks) { wave.setPeaks(p.peaks); wave.setDuration(p.duration); ws._peaksLoaded = true; }
    } catch { /* pas encore prêt */ }
  }

  // ------------------------------------------------------------ interactions waveform
  wave.addEventListener('selection-action', async (e) => {
    const { kind, start, end } = e.detail;
    const sec = await import('../audio/notes.js');
    if (kind === 'play') ws.seek(start);
    else if (kind === 'zoom') wave.setView(start, end);
    else if (kind === 'clip') { if (await sec.createClip(ws, start, end)) wave.clearSelection(); }
    else if (kind === 'annotation') { if (await sec.createAnnotation(ws, start, end)) wave.clearSelection(); }
    else if (kind === 'highlight') { if (await sec.createRangeHighlight(ws, start, end)) wave.clearSelection(); }
  });
  const unbind = bindShortcuts(player, {
    b: async () => (await import('../audio/notes.js')).quickBookmark(ws),
    B: async () => (await import('../audio/notes.js')).quickBookmark(ws),
  });

  // ------------------------------------------------------------ démarrage
  drawHead();
  drawSidebar();
  await ws.refreshTimeline();
  if (audio.peaks_ready) loadPeaks();
  const activeJob = (audio.jobs || []).find((j) => isActiveJob(j.status));
  const lastJob = (audio.jobs || [])[0];
  if (activeJob) watchJob(activeJob.id);
  else if (lastJob && (lastJob.status === 'FAILED' || (lastJob.status === 'COMPLETED' && lastJob.error && !audio.has_summary))) {
    mount(progressBox, progressPanel(lastJob, { onRetry: async () => { const r = await api.post(`/api/jobs/${lastJob.id}/retry`); watchJob(r.job_id); } }));
  } else if (!audio.transcription) {
    mount(progressBox, alertBox('info', 'Cet audio n’a pas encore été traité.', 'Lancez la transcription et l’analyse pour exploiter son contenu.',
      h('div', { class: 'mt-2' }, button('Lancer le traitement', { variant: 'btn-primary', size: 'btn-sm', icon: 'sparkle', onClick: async () => { const r = await api.post(`/api/audio/${id}/process`, {}); watchJob(r.job_id); } }))));
  }
  ws.watchJob = watchJob;
  await open(params.section);
  if (params.t) player.addEventListener('ready', () => player.seek(Number(params.t)), { once: true });
  if (params.t && player.duration) player.seek(Number(params.t));

  return () => {
    clearTimeout(jobTimer);
    if (sectionCleanup) sectionCleanup();
    unbind();
    wave.destroy();
    player.destroy();
    active = null;
    ctx.renderDefaultSidebar();
  };
}
