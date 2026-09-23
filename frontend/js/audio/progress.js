// Progression réelle d'un traitement (étapes, pourcentage, erreurs lisibles).
import { h, ic, button, jobStatus, isActiveJob } from '../ui.js';

export function stepsList(job) {
  const steps = [{ key: 'upload', label: 'Import', status: 'done', progress: 100 }, ...(job.steps || [])];
  const icoFor = (s) => (s.status === 'done' ? ic('check') : s.status === 'failed' ? ic('close') : s.status === 'skipped' ? ic('minus') : null);
  return h('div', { class: 'steps' }, steps.map((s) => {
    const pct = s.status === 'done' ? '✓' : s.status === 'running' ? `${Math.round(s.progress || 0)} %` : s.status === 'skipped' ? 'ignorée' : s.status === 'failed' ? 'échec' : '…';
    return [
      h('div', { class: `step ${s.status}` },
        h('span', { class: 'ico' }, icoFor(s)),
        h('span', { class: 'name', text: s.label }),
        h('div', { class: `progress ${s.status === 'running' && !s.progress ? 'indeterminate' : ''}` },
          h('span', { style: { width: `${s.status === 'done' ? 100 : s.status === 'running' ? s.progress || 0 : 0}%`, background: s.status === 'failed' ? 'var(--color-danger)' : s.status === 'skipped' ? 'var(--color-accent)' : null } })),
        h('span', { class: 'pct', text: pct })),
      s.message && s.status !== 'done' ? h('div', { class: `step ${s.status}`, style: { paddingTop: 0 } }, h('span'), h('span'), h('div', { class: 'step-msg', text: s.message })) : null,
    ];
  }));
}

export function progressPanel(job, { onCancel, onRetry } = {}) {
  const active = isActiveJob(job.status);
  let title = 'Analyse en cours';
  let text = 'Vous pouvez continuer à naviguer : le traitement se poursuit en arrière-plan.';
  let kind = 'neutral';
  if (job.status === 'QUEUED') { title = 'En attente de traitement'; text = "D'autres fichiers sont en cours de traitement. Celui-ci démarrera automatiquement."; }
  if (job.status === 'FAILED') { title = job.message || "L'analyse n'a pas pu être terminée."; text = humanError(job); kind = 'danger'; }
  if (job.status === 'CANCELLED') { title = 'Traitement annulé'; text = 'Les étapes déjà terminées sont conservées. Vous pouvez relancer à tout moment.'; }
  if (job.status === 'COMPLETED') {
    title = job.error ? 'Transcription disponible — analyse partielle' : 'Analyse terminée';
    text = job.error ? humanError(job) : 'Toutes les étapes ont abouti.';
    kind = job.error ? 'warning' : 'success';
  }
  return h('div', { class: `panel mb-6`, style: { borderColor: kind === 'danger' ? 'var(--color-danger)' : kind === 'warning' ? 'var(--color-warning)' : null } },
    h('div', { class: 'panel-body' },
      h('div', { class: 'row between', style: { alignItems: 'flex-start', flexWrap: 'wrap' } },
        h('div', { class: 'grow' },
          h('div', { class: 'row gap-2' }, jobStatus(job.status), h('span', { class: 'meta', text: job.label })),
          h('h3', { class: 'mt-2', style: { fontWeight: 500 }, text: title }),
          h('p', { class: 'muted', style: { margin: '2px 0 0' }, text })),
        h('div', { class: 'btn-group' },
          active && onCancel ? button('Annuler', { size: 'btn-sm', icon: 'close', onClick: onCancel }) : null,
          !active && job.status !== 'COMPLETED' && onRetry ? button('Relancer', { size: 'btn-sm', variant: 'btn-primary', icon: 'refresh', onClick: onRetry }) : null)),
      h('div', { class: 'mt-4' }, stepsList(job)),
      job.error_detail || (job.error && job.status === 'FAILED')
        ? h('details', { class: 'tech mt-4' }, h('summary', { text: 'Voir les détails techniques' }), h('pre', { text: [job.error, job.error_detail].filter(Boolean).join('\n\n') }))
        : null));
}

function humanError(job) {
  const e = (job.error || '').toLowerCase();
  if (e.includes('ollama')) return "Qwen (via Ollama) n'était pas disponible : la transcription est prête, l'analyse IA pourra être relancée dès qu'Ollama sera démarré.";
  if (e.includes('whisper')) return 'Whisper a rencontré un problème pendant la transcription.';
  if (e.includes('ffmpeg')) return "Le fichier n'a pas pu être converti. Il est peut-être endommagé ou dans un format inhabituel.";
  if (e.includes('délai')) return 'Le traitement a pris plus de temps que la limite configurée dans les paramètres.';
  return job.error ? job.error.split('\n')[0] : "Une étape n'a pas abouti.";
}
