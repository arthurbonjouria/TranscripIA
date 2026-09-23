// Paramètres : Whisper, Ollama, audio, jobs, IA, modèles, apparence.
import { api } from '../api.js';
import { h, ic, mount, errorBox, pageHead, button, toast, toastError, skeleton, fmtBytes, confirmDialog, formDialog, alertBox } from '../ui.js';

export async function render(root) {
  const page = h('div', { class: 'page' });
  mount(root, page);
  mount(page, skeleton('page'));
  let cfg, models, prompts;
  try {
    [cfg, models, prompts] = await Promise.all([api.get('/api/settings'), api.get('/api/models'), api.get('/api/prompts')]);
  } catch (err) { mount(page, errorBox(err)); return; }
  const v = cfg.values;
  const inputs = {};

  const field = (key, label, { type = 'text', options, hint, min, max, step } = {}) => {
    let el;
    if (options) el = h('select', { class: 'select' }, options.map(([val, l]) => h('option', { value: val, text: l })));
    else if (type === 'bool') el = h('input', { type: 'checkbox' });
    else el = h('input', { class: 'input', type, min, max, step });
    if (type === 'bool') el.checked = !!v[key]; else el.value = v[key] ?? '';
    inputs[key] = { el, type };
    if (type === 'bool') return h('label', { class: 'switch' }, el, h('span', { class: 'track' }), h('span', {}, h('b', { text: label }), hint ? [h('br'), h('span', { class: 'caption', text: hint })] : null));
    return h('div', { class: 'field' }, h('label', { text: label }), el, hint ? h('div', { class: 'field-hint', text: hint }) : null);
  };
  const group = (id, title, lede, ...fields) => h('section', { class: 'settings-group', id }, h('h3', { text: title }), lede ? h('p', { class: 'muted', style: { margin: 0 }, text: lede }) : null, h('div', { class: 'form-grid' }, fields));

  const whisperModels = cfg.whisper_models.map((m) => [m.name, `${m.name} — ~${m.size_mb} Mo${m.downloaded ? ' · installé' : ' · à télécharger'}`]);
  const ollamaModels = (models.ollama.models || []).filter((m) => !m.is_embedding).map((m) => [m.name, `${m.name} · ${m.parameters} · ${fmtBytes(m.size)}`]);
  if (!ollamaModels.some(([n]) => n === v['ollama.model'])) ollamaModels.unshift([v['ollama.model'], `${v['ollama.model']} (non installé)`]);
  const embedModels = [[v['ollama.embed_model'], v['ollama.embed_model']], ...(models.ollama.models || []).filter((m) => m.is_embedding && m.name !== v['ollama.embed_model']).map((m) => [m.name, m.name])];

  const groups = [
    group('whisper', 'Transcription (Whisper)', `Accélération GPU : ${cfg.cuda.available ? 'disponible' : 'indisponible — ' + (cfg.cuda.reason || '').slice(0, 120)}`,
      field('whisper.profile', 'Profil de vitesse', { options: [['equilibre', 'Équilibré — small par lots (~6 min pour 45 min)'], ['rapide', 'Rapide — base par lots (~2 min pour 45 min)'], ['precis', 'Précis — small, beam 5 (~16 min pour 45 min)'], ['perso', 'Personnalisé (réglages ci-dessous)']], hint: 'Les réglages détaillés ne s’appliquent qu’au profil « Personnalisé ».' }),
      field('whisper.batched', 'Inférence par lots', { type: 'bool', hint: 'Décode plusieurs passages en parallèle : 2 à 3 fois plus rapide.' }),
      field('whisper.batch_size', 'Taille des lots', { type: 'number', min: 1, max: 64 }),
      field('whisper.model', 'Modèle', { options: whisperModels, hint: 'small : bon équilibre sur CPU. medium / large-v3-turbo : plus précis, plus lent.' }),
      field('whisper.language', 'Langue par défaut', { options: [['', 'Détection automatique'], ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien']] }),
      field('whisper.device', 'Processeur', { options: [['auto', 'Automatique'], ['cpu', 'CPU'], ['cuda', 'GPU (CUDA)']] }),
      field('whisper.compute_type', 'Précision de calcul', { options: [['auto', 'Automatique'], ['int8', 'int8 (CPU, rapide)'], ['int8_float16', 'int8_float16 (GPU)'], ['float16', 'float16 (GPU)'], ['float32', 'float32 (lent)']] }),
      field('audio.chunk_duration', 'Durée des chunks (secondes)', { type: 'number', min: 60, max: 3600, step: 30, hint: 'Les longs fichiers sont découpés sur un silence proche de cette durée.' }),
      field('whisper.beam_size', 'Beam size', { type: 'number', min: 1, max: 10, hint: '5 = qualité ; 1 = plus rapide.' }),
      field('whisper.vad', 'Filtrer les silences (VAD)', { type: 'bool', hint: 'Recommandé : évite les hallucinations sur les silences.' })),
    group('ollama', 'Intelligence (Ollama · Qwen)', models.ollama.available ? `Ollama ${models.ollama.version} actif.` : 'Ollama ne répond pas : la transcription reste disponible, pas l’analyse IA.',
      field('ollama.url', 'URL d’Ollama', { hint: 'Doit rester locale (127.0.0.1).' }),
      field('ollama.model', 'Modèle de langage', { options: ollamaModels }),
      field('ollama.temperature', 'Température', { type: 'number', min: 0, max: 1.5, step: 0.05, hint: 'Bas = factuel et stable (recommandé : 0,2).' }),
      field('ollama.num_ctx', 'Contexte (tokens)', { type: 'number', min: 2048, max: 131072, step: 1024, hint: 'Plus grand = plus de mémoire. 8192 recommandé sur cette machine.' }),
      field('ollama.max_tokens', 'Longueur maximale des réponses', { type: 'number', min: 256, max: 8192, step: 128 }),
      field('ollama.timeout', 'Délai maximal par appel (secondes)', { type: 'number', min: 60, max: 7200, step: 30 }),
      field('ollama.embed_model', 'Modèle d’embeddings (recherche sémantique)', { options: embedModels, hint: 'Optionnel. Exemple : nomic-embed-text.' })),
    group('ia', 'Analyse', 'Les prompts sont des fichiers modifiables dans le dossier prompts/.',
      field('analysis.auto_run', 'Analyser automatiquement après la transcription', { type: 'bool' }),
      field('analysis.use_cache', 'Réutiliser les analyses existantes (cache)', { type: 'bool', hint: 'Une analyse n’est recalculée que via « Régénérer » ou après une correction.' }),
      field('analysis.block_minutes', 'Taille des passages analysés (minutes)', { type: 'number', min: 2, max: 30, hint: 'Plus petit = plus précis, mais plus long.' })),
    group('audio', 'Audio & stockage', `Données : ${cfg.paths.data}${cfg.paths.cloud_synced ? ' — attention, dossier synchronisé dans le cloud !' : ' (local, hors cloud)'}`,
      field('audio.max_upload_mb', 'Taille maximale d’un fichier (Mo)', { type: 'number', min: 10, max: 20480 }),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Formats acceptés' }), h('div', { class: 'row-wrap' }, cfg.allowed_extensions.map((e) => h('span', { class: 'badge badge-outline', text: e.slice(1).toUpperCase() }))))),
    group('jobs', 'Traitements', 'Sur cette machine, un traitement à la fois est recommandé (mémoire partagée entre Whisper et Qwen).',
      field('jobs.concurrency', 'Traitements simultanés', { type: 'number', min: 1, max: 4, hint: 'Pris en compte au prochain démarrage.' }),
      field('jobs.timeout_min', 'Délai maximal d’un traitement (minutes)', { type: 'number', min: 10, max: 2880 }),
      field('jobs.retries', 'Nouvelles tentatives automatiques', { type: 'number', min: 0, max: 5 })),
  ];

  const save = async () => {
    const values = {};
    Object.entries(inputs).forEach(([k, { el, type }]) => { values[k] = type === 'bool' ? el.checked : el.value; });
    const wm = cfg.whisper_models.find((m) => m.name === values['whisper.model']);
    let confirmDownload = false;
    if (wm && !wm.downloaded && values['whisper.model'] !== v['whisper.model']) {
      confirmDownload = await confirmDialog('Télécharger un nouveau modèle Whisper ?', `Le modèle « ${wm.name} » (~${wm.size_mb} Mo) sera téléchargé depuis Hugging Face au prochain traitement, puis utilisé hors ligne.`, { confirmLabel: 'Confirmer le téléchargement' });
      if (!confirmDownload) return;
    }
    try { await api.put('/api/settings', { values, confirm_download: confirmDownload }); toast('Paramètres enregistrés', 'success'); } catch (err) { toastError(err); }
  };

  // Modèles Ollama
  const modelsBox = h('section', { class: 'settings-group', id: 'models' }, h('h3', { text: 'Modèles installés' }),
    h('p', { class: 'muted', text: 'Aucun modèle n’est téléchargé sans votre confirmation explicite.' }),
    (models.ollama.models || []).length ? h('table', { class: 'table mt-4' }, h('thead', {}, h('tr', {}, ['Modèle', 'Paramètres', 'Quantification', 'Taille', 'Statut'].map((t) => h('th', { text: t })))),
      h('tbody', {}, models.ollama.models.map((m) => h('tr', {}, h('td', {}, h('b', { text: m.name }), m.name === v['ollama.model'] ? h('span', { class: 'badge badge-primary', style: { marginLeft: '8px' }, text: 'utilisé' }) : null),
        h('td', { text: m.parameters || '—' }), h('td', { text: m.quantization || '—' }), h('td', { class: 'tnum', text: fmtBytes(m.size) }),
        h('td', {}, h('span', { class: `badge ${m.loaded ? 'badge-success' : ''}`, text: m.loaded ? 'en mémoire' : 'installé' }))))))
      : alertBox('warning', 'Aucun modèle Ollama détecté', models.ollama.available ? 'Installez un modèle, par exemple : ollama pull qwen3:8b' : 'Ollama ne répond pas.'),
    h('div', { class: 'row mt-4' },
      button('Tester le modèle', { icon: 'activity', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; try { const r = await api.post('/api/models/test'); toast(r.detail, r.status === 'ok' ? 'success' : 'error'); } catch (err) { toastError(err); } b.disabled = false; } }),
      button('Télécharger un modèle…', { icon: 'download', onClick: pull })),
    h('div', { class: 'divider-label', text: 'Whisper' }),
    h('div', { class: 'row-wrap' }, models.whisper.models.map((m) => h('span', { class: `badge ${m.downloaded ? 'badge-success' : 'badge-outline'}`, text: `${m.name}${m.downloaded ? ' · installé' : ''}` }))),
    h('p', { class: 'caption mt-2', text: `Actuel : ${models.whisper.current} (${models.whisper.device}) · dossier ${cfg.paths.models}` }));

  async function pull() {
    const f = await formDialog('Télécharger un modèle Ollama', [{ name: 'name', label: 'Nom du modèle', placeholder: 'nomic-embed-text, qwen3:4b…', hint: 'Le téléchargement se fait depuis la bibliothèque officielle Ollama.' }], { submitLabel: 'Continuer' });
    if (!f || !f.name.trim()) return;
    const ok = await confirmDialog(`Télécharger « ${f.name.trim()} » ?`, 'Ce téléchargement nécessite une connexion Internet et peut peser plusieurs gigaoctets. Le modèle fonctionnera ensuite entièrement hors ligne.', { confirmLabel: 'Télécharger' });
    if (!ok) return;
    const status = h('div', { class: 'caption mt-2', text: 'Démarrage…' });
    modelsBox.appendChild(status);
    try {
      await api.stream('/api/models/pull', { name: f.name.trim(), confirm: true }, (ev) => {
        if (ev.error) status.textContent = `Erreur : ${ev.error}`;
        else status.textContent = ev.total ? `${ev.status} — ${Math.round((ev.completed || 0) / ev.total * 100)} %` : ev.status;
      });
      toast('Téléchargement terminé', 'success');
    } catch (err) { toastError(err); }
  }

  const promptsBox = h('section', { class: 'settings-group', id: 'prompts' }, h('h3', { text: 'Prompts IA' }),
    h('p', { class: 'muted', text: 'Modifiables dans le dossier prompts/ (sans toucher au code). Chaque analyse enregistre la version du prompt utilisée.' }),
    h('div', { class: 'row-wrap mt-4' }, prompts.map((p) => h('span', { class: 'tag', title: p.path, text: `${p.name} · v${p.version}` }))));

  const theme = document.documentElement.dataset.theme || 'light';
  const themeBox = h('section', { class: 'settings-group', id: 'appearance' }, h('h3', { text: 'Apparence' }),
    h('p', { class: 'muted', text: 'Le mode clair est la direction artistique BONJOUR IA. Un mode sombre chaleureux est disponible en aperçu.' }),
    h('div', { class: 'segmented mt-4' }, [['light', 'Clair (BONJOUR IA)'], ['dark', 'Sombre (aperçu)']].map(([k, l]) => h('button', { type: 'button', class: theme === k ? 'is-active' : '', text: l, onclick: () => { document.documentElement.dataset.theme = k; try { localStorage.setItem('bj.theme', k); } catch { /* */ } render(root); } }))));

  const nav = h('nav', { class: 'settings-nav' }, [['whisper', 'Transcription'], ['ollama', 'Intelligence'], ['ia', 'Analyse'], ['audio', 'Audio & stockage'], ['jobs', 'Traitements'], ['models', 'Modèles'], ['prompts', 'Prompts'], ['appearance', 'Apparence']]
    .map(([id, l]) => h('a', { class: 'nav-link', href: '#/settings', onclick: (e) => { e.preventDefault(); document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); }, text: l })));

  mount(page,
    pageHead({ kicker: 'Configuration', title: 'Paramètres', lede: 'Réglez la transcription, le modèle de langage et les traitements. Tout reste local.', actions: [button('Enregistrer', { variant: 'btn-primary', icon: 'check', onClick: save })] }),
    h('div', { class: 'settings-layout' }, nav, h('div', { class: 'panel' }, groups, modelsBox, promptsBox, themeBox,
      h('div', { class: 'panel-foot row', style: { justifyContent: 'flex-end' } }, button('Enregistrer les paramètres', { variant: 'btn-primary', icon: 'check', onClick: save })))));
}
