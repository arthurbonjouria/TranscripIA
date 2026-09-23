// File des traitements (traitement par lot, progression réelle, annulation, relance).
import { api } from '../api.js';
import { h, mount, empty, errorBox, pageHead, jobStatus, isActiveJob, relTime, button, toast, toastError, skeleton } from '../ui.js';
import { stepsList } from '../audio/progress.js';

export async function render(root, _params, ctx) {
  const page = h('div', { class: 'page', style: { maxWidth: '1080px' } });
  const box = h('div');
  mount(root, page);
  mount(page, pageHead({ kicker: 'Système', title: 'Traitements', lede: 'Chaque fichier est traité en arrière-plan, l’un après l’autre. Les traitements survivent au rechargement de la page et reprennent après un redémarrage.' }), box);
  mount(box, h('div', { class: 'panel panel-pad' }, skeleton('rows', 4)));

  const draw = (jobs) => {
    if (!jobs.length) { mount(box, h('div', { class: 'panel' }, empty({ icon: 'layers', title: 'Aucun traitement', text: 'Les imports et analyses apparaîtront ici.' }))); return; }
    const active = jobs.filter((j) => isActiveJob(j.status));
    const done = jobs.filter((j) => !isActiveJob(j.status));
    const card = (j) => h('div', { class: 'job' },
      h('div', { class: 'job-head' }, jobStatus(j.status),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          j.audio_id ? h('a', { href: `#/audio/${j.audio_id}`, style: { fontWeight: 600 }, text: j.audio_title || `Audio ${j.audio_id}` }) : h('b', { text: j.label }),
          h('div', { class: 'meta', text: `${j.label} · ${j.message || ''} · ${relTime(j.updated_at)}${j.attempts > 1 ? ` · tentative ${j.attempts}` : ''}` })),
        isActiveJob(j.status) ? h('span', { class: 'tnum', style: { fontWeight: 600 }, text: `${Math.round(j.progress)} %` }) : null,
        isActiveJob(j.status) ? button('Annuler', { size: 'btn-sm', onClick: async () => { await api.post(`/api/jobs/${j.id}/cancel`); toast('Annulation demandée', 'info'); refresh(); } }) : null,
        ['FAILED', 'CANCELLED'].includes(j.status) ? button('Relancer', { size: 'btn-sm', variant: 'btn-primary', onClick: async () => { try { await api.post(`/api/jobs/${j.id}/retry`); refresh(); } catch (e) { toastError(e); } } }) : null),
      isActiveJob(j.status) ? h('div', { class: 'mt-4' }, stepsList(j)) : null,
      j.status === 'FAILED' || (j.status === 'COMPLETED' && j.error) ? h('details', { class: 'tech mt-2' }, h('summary', { text: j.status === 'FAILED' ? 'Voir les détails de l’erreur' : 'Voir les avertissements' }), h('pre', { text: [j.error, j.error_detail].filter(Boolean).join('\n\n') })) : null);
    mount(box,
      active.length ? h('div', { class: 'section' }, h('div', { class: 'divider-label', text: `En cours et en attente · ${active.length}` }), h('div', { class: 'panel' }, active.map(card))) : null,
      h('div', { class: 'section' }, h('div', { class: 'divider-label', text: 'Historique' }), done.length ? h('div', { class: 'panel' }, done.map(card)) : h('p', { class: 'muted', text: 'Aucun traitement terminé.' })));
  };
  const refresh = async () => { try { draw(await api.get('/api/jobs?limit=100')); } catch (err) { mount(box, errorBox(err)); } };
  await refresh();
  const onJobs = () => refresh();
  ctx.bus.addEventListener('jobs', onJobs);
  return () => ctx.bus.removeEventListener('jobs', onJobs);
}
