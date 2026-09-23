import { api } from '../api.js';
import { h, ic, mount, fmtBytes, fmtDuration, button, pageHead, jobStatus, isActiveJob, alertBox } from '../ui.js';
import { navigate } from '../app.js';

const FORMATS = ['MP3', 'WAV', 'M4A', 'FLAC', 'AAC', 'OGG', 'WEBM', 'MP4 audio'];
const ACCEPT = '.mp3,.wav,.m4a,.flac,.aac,.ogg,.oga,.opus,.webm,.mp4,audio/*';
const PROFILES = [['equilibre', 'Équilibré — bonne qualité (~6 min pour 45 min)'], ['rapide', 'Rapide — brouillon express (~2 min pour 45 min)'], ['precis', 'Précis — qualité maximale (~16 min pour 45 min)']];
const LANGS = [['', 'Détection automatique'], ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien'], ['pt', 'Portugais'], ['nl', 'Néerlandais']];

export async function render(root, _params, ctx) {
  const items = [];
  const page = h('div', { class: 'page', style: { maxWidth: '980px' } });
  const list = h('div', { class: 'upload-list' });
  const fileInput = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'sr-only', id: 'file-input' });
  const lang = h('select', { class: 'select', id: 'lang' }, LANGS.map(([v, l]) => h('option', { value: v, text: l })));
  const auto = h('input', { type: 'checkbox', checked: true });
  const profile = h('select', { class: 'select', id: 'profile' }, PROFILES.map(([v, l]) => h('option', { value: v, text: l })));
  api.get('/api/settings').then((c) => { profile.value = c.values['whisper.profile'] in { equilibre: 1, rapide: 1, precis: 1 } ? c.values['whisper.profile'] : 'equilibre'; }).catch(() => {});

  const dz = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Déposer des fichiers audio ou cliquer pour parcourir' },
    h('div', { class: 'dz-icon' }, ic('upload')),
    h('h2', { style: { fontSize: '1.5rem' } }, 'Déposez vos ', h('span', { class: 'accent', text: 'enregistrements' }), ' ici'),
    h('p', { class: 'muted', style: { margin: 0 }, text: 'ou cliquez pour parcourir vos fichiers. Plusieurs fichiers à la fois, même très longs.' }),
    h('div', { class: 'formats mt-2' }, FORMATS.map((f) => h('span', { class: 'badge badge-outline', text: f }))),
    fileInput);
  dz.onclick = () => fileInput.click();
  dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };

  const options = h('div', { class: 'panel panel-pad mt-6' },
    h('div', { class: 'grid grid-3', style: { alignItems: 'end' } },
      h('div', { class: 'field' }, h('label', { for: 'lang', text: "Langue de l'enregistrement" }), lang,
        h('div', { class: 'field-hint', text: 'La détection automatique convient dans la plupart des cas.' })),
      h('div', { class: 'field' }, h('label', { for: 'profile', text: 'Vitesse de transcription' }), profile,
        h('div', { class: 'field-hint', text: 'Durées mesurées sur cette machine (processeur).' })),
      h('label', { class: 'switch' }, auto, h('span', { class: 'track' }),
        h('span', {}, h('b', { text: "Lancer l'analyse complète" }), h('br'), h('span', { class: 'caption', text: 'Transcription, chapitres, synthèse, décisions, actions…' })))));

  mount(root, page);
  mount(page,
    pageHead({ kicker: 'Import', title: 'Importer des', accent: 'audios', lede: "Vos fichiers restent sur cette machine : ils ne sont envoyés à aucun service en ligne." }),
    dz, options, list,
    h('div', { class: 'mt-6' }, alertBox('neutral', 'Bon à savoir',
      "Le traitement se poursuit en arrière-plan : vous pouvez fermer cette page ou importer d'autres fichiers. Les longs enregistrements sont découpés automatiquement et la progression est conservée en cas d'interruption.")));

  function addFiles(files) {
    [...files].forEach((file) => {
      const item = { file, progress: 0, state: 'uploading', el: h('div', { class: 'upload-item' }) };
      items.unshift(item);
      list.prepend(item.el);
      drawItem(item);
      upload(item);
    });
  }

  async function upload(item) {
    try {
      const fields = { auto_process: auto.checked ? 'true' : 'false', language: lang.value, profile: profile.value };
      item.res = await api.upload(item.file, fields, (p) => { item.progress = p; drawItem(item); });
      item.state = item.res.job_id ? 'queued' : 'done';
    } catch (err) {
      item.state = 'error';
      item.error = err;
    }
    drawItem(item);
  }

  function drawItem(it) {
    const f = it.file;
    const right = [];
    const meta = [h('span', { text: fmtBytes(f.size) })];
    let status;
    if (it.state === 'uploading') {
      status = h('div', { style: { width: '200px' } }, h('div', { class: 'row between caption' }, h('span', { text: 'Envoi local' }), h('span', { class: 'tnum', text: `${Math.round(it.progress * 100)} %` })),
        h('div', { class: 'progress mt-2' }, h('span', { style: { width: `${it.progress * 100}%` } })));
    } else if (it.state === 'error') {
      status = h('span', { class: 'badge badge-danger', text: 'Refusé' });
      meta.push(h('span', { style: { color: 'var(--color-danger)' }, text: it.error.message }));
    } else {
      const r = it.res;
      meta.push(h('span', {}, 'Durée ', h('b', { text: fmtDuration(r.duration) })),
        h('span', {}, 'Codec ', h('b', { text: r.codec })),
        h('span', {}, 'Fréquence ', h('b', { text: `${(r.sample_rate / 1000).toString().replace('.', ',')} kHz` })),
        h('span', {}, 'Canaux ', h('b', { text: r.channels === 1 ? 'mono' : r.channels === 2 ? 'stéréo' : String(r.channels) })));
      status = it.job ? h('div', { class: 'row' }, jobStatus(it.job.status), isActiveJob(it.job.status) ? h('span', { class: 'caption tnum', text: `${Math.round(it.job.progress)} %` }) : null)
        : jobStatus(it.state === 'queued' ? 'QUEUED' : 'COMPLETED');
      right.push(button('Ouvrir', { size: 'btn-sm', onClick: () => navigate(`#/audio/${r.id}`) }));
    }
    mount(it.el,
      h('div', { class: 'lib-icon' }, ic(it.state === 'error' ? 'alert' : 'wave')),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'truncate', style: { fontWeight: 500 }, text: f.name }),
        h('div', { class: 'ui-meta' }, meta),
        it.job && isActiveJob(it.job.status) ? h('div', { class: 'progress mt-2' }, h('span', { style: { width: `${it.job.progress}%` } })) : null,
        it.job && it.job.message ? h('div', { class: 'caption mt-2', text: it.job.message }) : null),
      h('div', { class: 'row' }, status, right));
  }

  // Suivi de la file de traitement (par lot)
  const onJobs = async () => {
    const pending = items.filter((i) => i.res && i.res.job_id && (!i.job || isActiveJob(i.job.status)));
    for (const it of pending) {
      try { it.job = await api.get(`/api/jobs/${it.res.job_id}`); drawItem(it); } catch { /* */ }
    }
  };
  ctx.bus.addEventListener('jobs', onJobs);
  return () => ctx.bus.removeEventListener('jobs', onJobs);
}
