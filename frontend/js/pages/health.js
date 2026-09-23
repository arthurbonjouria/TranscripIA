// SYSTEM HEALTH — tests réels des composants.
import { api } from '../api.js';
import { h, ic, mount, errorBox, pageHead, button, skeleton, fmtBytes, relTime, fmtDate } from '../ui.js';

const ICON = { ok: 'check', warning: 'alert', error: 'close', info: 'info' };
const STATUS_LABEL = { ok: 'Opérationnel', warning: 'À surveiller', error: 'Indisponible', info: 'Information' };

export async function render(root) {
  const page = h('div', { class: 'page', style: { maxWidth: '1100px' } });
  const box = h('div');
  const storageBox = h('div');
  const logsBox = h('div');
  mount(root, page);
  mount(page, pageHead({
    kicker: 'System health', title: 'Diagnostic', accent: 'du système',
    lede: 'Chaque composant est réellement testé : conversion FFmpeg, chargement Whisper, réponse de Qwen, intégrité de la base, espace disque.',
    actions: [button('Relancer', { icon: 'refresh', onClick: () => run(false) }), button('Test approfondi', { variant: 'btn-primary', icon: 'activity', onClick: () => run(true) })],
  }), box, h('div', { class: 'grid grid-2 mt-6' }, storageBox, logsBox));

  async function run(deep) {
    mount(box, h('div', { class: 'panel panel-pad' }, deep ? h('p', { class: 'muted', text: 'Test approfondi en cours : transcription d’un fichier de test et génération d’une réponse par Qwen (jusqu’à une minute)…' }) : null, skeleton('rows', 6)));
    try {
      const r = await api.get(`/api/health?deep=${deep}`);
      const s = r.system;
      const global = { ok: ['success', 'Tous les composants essentiels fonctionnent.'], warning: ['warning', 'L’application fonctionne, certains points méritent votre attention.'], error: ['danger', 'Un composant essentiel est indisponible.'] }[r.status];
      mount(box,
        h('div', { class: `alert alert-${global[0]} mb-6` }, ic(r.status === 'ok' ? 'check' : 'alert'), h('div', {}, h('div', { class: 'alert-title', text: global[1] }), h('div', { text: `Vérifié ${relTime(r.checked_at)} · ${s.os} · ${s.cpu} · ${s.cpu_count} threads · RAM ${s.ram_total_gb ?? '?'} Go (${s.ram_free_gb ?? '?'} Go libres)` }))),
        h('div', { class: 'panel' }, r.items.map((it) => h('div', { class: 'health-row' },
          h('span', { class: `health-ico ${it.status}` }, ic(ICON[it.status])),
          h('div', { class: 'li-title', text: it.label }),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'small', style: { wordBreak: 'break-word' }, text: it.detail }), it.hint && it.status !== 'ok' ? h('div', { class: 'h-hint', text: `→ ${it.hint}` }) : null),
          h('span', { class: `badge ${{ ok: 'badge-success', warning: 'badge-warning', error: 'badge-danger', info: 'badge-info' }[it.status]}`, text: STATUS_LABEL[it.status] })))));
    } catch (err) { mount(box, errorBox(err, { title: 'Le diagnostic n’a pas pu être effectué.', retry: () => run(deep) })); }
  }

  async function side() {
    try {
      const [st, logs] = await Promise.all([api.get('/api/storage'), api.get('/api/logs?limit=30')]);
      const row = (l, v) => h('div', { class: 'row between', style: { padding: '6px 0', borderBottom: '1px solid var(--color-border)' } }, h('span', { class: 'muted', text: l }), h('span', { class: 'tnum', text: v }));
      mount(storageBox, h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Stockage local' })),
        h('div', { class: 'panel-body' }, row('Espace libre', fmtBytes(st.free)), row('Audios', fmtBytes(st.audio)), row('Fichiers de travail', fmtBytes(st.work)),
          row('Clips', fmtBytes(st.clips)), row('Exports', fmtBytes(st.exports)), row('Modèles Whisper', fmtBytes(st.models)))));
      mount(logsBox, h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Journal (avertissements et erreurs)' })),
        logs.length ? h('div', { class: 'panel-body', style: { maxHeight: '320px', overflow: 'auto' } }, logs.map((l) => h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--color-border)' } },
          h('div', { class: 'row gap-2' }, h('span', { class: `badge ${l.level === 'ERROR' || l.level === 'CRITICAL' ? 'badge-danger' : 'badge-warning'}`, text: l.level }), h('span', { class: 'caption', text: `${l.logger} · ${fmtDate(l.created_at, true)}` })),
          h('div', { class: 'caption mt-2', style: { wordBreak: 'break-word' }, text: l.message }))))
          : h('div', { class: 'panel-body caption', text: 'Aucun avertissement récent. Le journal complet se trouve dans le dossier logs.' })));
    } catch { /* */ }
  }

  run(false);
  side();
}
