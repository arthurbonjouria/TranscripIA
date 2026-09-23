// Comparaison de réunions et briefing avant réunion (multi-audios).
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtDuration, fmtDate, button, pageHead, toast, toastError, relTime, skeleton } from '../ui.js';
import { stepsList } from '../audio/progress.js';

export async function render(root, params, ctx) {
  const page = h('div', { class: 'page' });
  mount(root, page);
  let audios = [];
  try { audios = (await api.get('/api/audio?limit=500&sort=recorded&order=asc')).items.filter((a) => a.status === 'analyzed'); } catch { /* */ }
  const selected = new Set((params.ids || '').split(',').map(Number).filter(Boolean));
  let mode = params.mode === 'prep' ? 'prep_briefing' : 'comparison';
  let job = null;
  const result = h('div');
  const pick = h('div', { class: 'panel' });

  mount(page, pageHead({ kicker: 'Intelligence multi-réunions', title: 'Comparer &', accent: 'préparer', lede: 'Suivez l’évolution des décisions et des actions d’une réunion à l’autre, et préparez la prochaine en quelques minutes.' }));
  if (!audios.length) {
    page.appendChild(h('div', { class: 'panel' }, empty({ icon: 'compare', title: 'Aucun audio analysé', text: 'Cette fonctionnalité utilise les analyses de plusieurs réunions. Analysez au moins un audio pour commencer.' })));
    return;
  }
  const tabs = h('div', { class: 'segmented mb-6' });
  const drawTabs = () => mount(tabs, [['comparison', 'Comparaison de réunions'], ['prep_briefing', 'Briefing avant réunion']].map(([k, l]) => {
    const b = h('button', { type: 'button', class: mode === k ? 'is-active' : '', text: l });
    b.onclick = () => { mode = k; drawTabs(); drawPick(); loadResult(); };
    return b;
  }));
  drawTabs();
  page.append(tabs, h('div', { class: 'grid grid-main-side', style: { alignItems: 'start' } }, result, pick));

  function drawPick() {
    const min = mode === 'comparison' ? 2 : 1;
    mount(pick,
      h('div', { class: 'panel-head' }, h('h3', { text: 'Réunions' }), h('span', { class: 'caption', text: `${selected.size} sélectionnée${selected.size > 1 ? 's' : ''}` })),
      h('div', { class: 'panel-body audio-pick', style: { maxHeight: '460px' } }, audios.map((a) => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(a.id) ? true : null });
        cb.onchange = () => { cb.checked ? selected.add(a.id) : selected.delete(a.id); drawPick(); loadResult(); };
        return h('label', {}, cb, h('span', {}, h('span', { style: { display: 'block', fontWeight: 500 }, text: a.title }), h('span', { class: 'caption', text: `${fmtDate(a.recorded_at || a.created_at)} · ${fmtDuration(a.duration)}` })));
      })),
      h('div', { class: 'panel-foot' }, button(mode === 'comparison' ? 'Comparer' : 'Préparer le briefing', {
        variant: 'btn-primary', icon: 'sparkle', disabled: selected.size < min || (job && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)), onClick: launch,
      }), h('div', { class: 'caption mt-2', text: mode === 'comparison' ? 'Sélectionnez au moins deux réunions. Elles sont ordonnées par date.' : 'Sélectionnez les réunions précédentes à prendre en compte.' })));
  }

  async function launch() {
    try {
      const r = await api.post(mode === 'comparison' ? '/api/compare' : '/api/prep-briefing', { audio_ids: [...selected] });
      toast('Analyse lancée — quelques minutes avec Qwen en local.', 'success');
      watch(r.job_id);
    } catch (err) { toastError(err); }
  }

  let timer = null;
  async function watch(id) {
    clearTimeout(timer);
    job = await api.get(`/api/jobs/${id}`);
    drawPick();
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      mount(result, h('div', { class: 'panel panel-pad' }, h('h3', { class: 'mb-4', style: { fontWeight: 500 }, text: 'Analyse en cours…' }), stepsList(job)));
      timer = setTimeout(() => watch(id), 2500);
    } else if (job.status === 'FAILED') {
      mount(result, errorBox({ message: job.error || 'La tâche a échoué.', detail: job.error_detail }, { title: "L'analyse n'a pas pu être terminée.", retry: launch }));
    } else loadResult();
  }

  async function loadResult() {
    const ids = [...selected];
    if (!ids.length || (mode === 'comparison' && ids.length < 2)) {
      mount(result, h('div', { class: 'panel' }, empty({ icon: 'compare', title: mode === 'comparison' ? 'Choisissez les réunions à comparer' : 'Choisissez les réunions précédentes', text: 'Sélectionnez-les dans la liste à droite.' })));
      return;
    }
    mount(result, h('div', { class: 'panel panel-pad' }, skeleton('lines', 6)));
    try {
      const row = await api.get(`/api/multi/${mode}?ids=${ids.join(',')}`);
      if (!row) { mount(result, h('div', { class: 'panel' }, empty({ icon: 'sparkle', title: 'Pas encore généré', text: 'Lancez l’analyse pour cette sélection.' }))); return; }
      mount(result, mode === 'comparison' ? drawComparison(row) : drawPrep(row));
    } catch (err) { mount(result, errorBox(err)); }
  }

  const block = (title, items, ico, color) => h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, h('span', { style: { color } }, ic(ico)), ' ', title, h('span', { class: 'caption', text: `  ${items.length}` }))),
    items.length ? h('div', { class: 'panel-body' }, h('ul', { class: 'bullets' }, items.map((x) => h('li', { text: x })))) : h('div', { class: 'panel-body caption', text: 'Rien à signaler.' }));

  function header(row) {
    const c = row.content;
    return h('div', { class: 'panel panel-pad mb-6' },
      h('div', { class: 'kicker', text: `Généré ${relTime(row.created_at)} · ${c.audios.length} réunions` }),
      h('ol', { style: { margin: '10px 0 0', paddingLeft: '1.3em' } }, c.audios.map((a) => h('li', {}, h('a', { href: `#/audio/${a.id}`, text: a.title }), h('span', { class: 'caption', text: ` — ${fmtDate(a.date)}` })))),
      c.overview ? h('p', { class: 'reading mt-4', style: { margin: '16px 0 0', fontSize: '1.1rem' }, text: c.overview }) : null);
  }

  function drawComparison(row) {
    const c = row.content;
    return h('div', {}, header(row), h('div', { class: 'compare-cols' },
      block('Nouveaux sujets', c.new_topics, 'plus', 'var(--color-primary)'), block('Décisions modifiées', c.changed_decisions, 'refresh', 'var(--cat-decision)'),
      block('Actions terminées', c.completed_actions, 'check', 'var(--color-success)'), block('Actions toujours ouvertes', c.open_actions, 'arrowRight', 'var(--cat-action)'),
      block('Évolutions', c.evolutions, 'activity', 'var(--cat-question)'), block('Contradictions éventuelles', c.contradictions, 'alert', 'var(--cat-risk)')),
      h('p', { class: 'caption mt-4', text: 'Analyse produite par Qwen à partir des synthèses de chaque réunion. Vérifiez les contradictions signalées en écoutant les passages concernés.' }));
  }

  function drawPrep(row) {
    const c = row.content;
    return h('div', {}, header(row), h('div', { class: 'compare-cols' },
      block('Points à aborder', c.agenda, 'flag', 'var(--color-primary)'), block('Actions en attente', c.pending_actions, 'arrowRight', 'var(--cat-action)'),
      block('Décisions précédentes', c.previous_decisions, 'check', 'var(--cat-decision)'), block('Questions ouvertes', c.open_questions, 'question', 'var(--cat-question)'),
      block('Évolutions', c.evolutions, 'activity', 'var(--cat-info)'), block('Sujets récurrents', c.recurring_topics, 'tag', 'var(--cat-idea)')));
  }

  drawPick();
  loadResult();
  return () => clearTimeout(timer);
}
