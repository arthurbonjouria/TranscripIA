// Fiche de synthèse : TL;DR, résumés multiples, décisions, actions, questions… — modifiable.
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtDuration, fmtDate, fmtTime, listenButton, button, toast, toastError, renderMarkdown, popMenu, relTime, alertBox, skeleton } from '../ui.js';

const SUMMARY_TABS = [
  { key: 'short', label: 'Résumé court' },
  { key: 'executive', label: 'Résumé exécutif' },
  { key: 'summary_detailed', label: 'Détaillé', extra: true },
  { key: 'summary_chronological', label: 'Chronologique', extra: true },
  { key: 'summary_thematic', label: 'Par thème', extra: true },
];

export async function render(root, ws) {
  let data;
  let tab = 'short';
  let editing = false;

  const load = async () => {
    try {
      data = await api.get(`/api/audio/${ws.id}/summary`);
      draw();
    } catch (err) { mount(root, errorBox(err, { retry: load })); }
  };

  function draw() {
    const s = data.summary;
    const a = ws.audio;
    if (!s) {
      const trReady = a.transcription && a.transcription.status === 'completed';
      mount(root, h('div', { class: 'panel' }, empty({
        icon: 'fileText', title: 'La fiche de synthèse n’est pas encore prête',
        text: trReady ? "La transcription est disponible. Lancez l'analyse IA pour obtenir la fiche, les chapitres, les décisions et les actions."
          : "Elle sera générée automatiquement à la fin de l'analyse.",
        action: trReady ? button("Lancer l'analyse IA", { variant: 'btn-primary', icon: 'sparkle', onClick: async () => { try { const r = await api.post(`/api/audio/${ws.id}/regenerate`, { force: false }); ws.watchJob(r.job_id); } catch (e) { toastError(e); } } })
          : button('Voir la transcription', { onClick: () => ws.open('transcript') }),
      })));
      return;
    }
    if (editing) return drawEdit(s);

    const sheet = h('article', { class: 'panel sheet' });
    const meta = data.meta;
    const versionInfo = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, ic('clock'), `Version ${meta.version} · ${meta.source === 'user' ? 'modifiée' : 'IA'} · ${relTime(meta.created_at)}`);
    versionInfo.onclick = (e) => popMenu(e.currentTarget, [{ title: 'Historique des versions' }, ...data.history.map((v) => ({
      icon: v.is_current ? 'check' : 'clock', label: `Version ${v.version} — ${v.source === 'user' ? 'modifiée' : v.model || 'IA'}`, hint: relTime(v.created_at),
      onClick: async () => { if (v.is_current) return; await api.post(`/api/analyses/${v.id}/restore`); toast(`Version ${v.version} restaurée`, 'success'); load(); },
    }))]);

    const cover = h('header', { class: 'sheet-cover' },
      h('div', { class: 'row between', style: { flexWrap: 'wrap' } },
        h('div', { class: 'kicker', text: 'Fiche de synthèse' }),
        h('div', { class: 'btn-group' }, versionInfo,
          button('Modifier', { size: 'btn-sm', icon: 'edit', onClick: () => { editing = true; draw(); } }),
          button(data.briefing ? 'Actualiser mon briefing' : 'Générer mon briefing', { size: 'btn-sm', variant: 'btn-soft', icon: 'briefcase', onClick: briefing }))),
      h('h2', { text: s.title || a.title }),
      h('dl', { class: 'sheet-meta' },
        h('div', {}, h('dt', { text: 'Date' }), h('dd', { text: fmtDate(a.recorded_at || a.created_at) })),
        h('div', {}, h('dt', { text: 'Durée' }), h('dd', { text: fmtDuration(a.duration) })),
        h('div', {}, h('dt', { text: 'Participants' }), h('dd', { text: (s.participants || []).join(', ') || a.participants || '—' })),
        h('div', {}, h('dt', { text: 'Langue' }), h('dd', { text: (a.language || '—').toUpperCase() }))),
      s.tldr ? h('p', { class: 'tldr' }, h('span', { class: 'sr-only', text: 'TL;DR : ' }), s.tldr) : null);

    const sections = [cover];
    if (data.stale) sections.push(h('div', { class: 'sheet-section', style: { paddingBottom: 0 } }, alertBox('warning', 'La transcription a été corrigée depuis cette synthèse.', 'Régénérez l’analyse pour qu’elle prenne en compte vos corrections.')));
    if (data.briefing) sections.push(briefingSection(data.briefing));

    // Résumés multiples
    const tabsEl = h('div', { class: 'summary-tabs' }, SUMMARY_TABS.map((t) => {
      const b = h('button', { class: `chip ${tab === t.key ? 'is-active' : ''}`, type: 'button', text: t.label });
      b.onclick = () => { tab = t.key; draw(); };
      return b;
    }));
    let content;
    const cur = SUMMARY_TABS.find((t) => t.key === tab);
    if (!cur.extra) content = h('div', { class: 'prose' }, (s[tab] || '').split(/\n+/).filter(Boolean).map((p) => h('p', { text: p })));
    else if (data.extras[tab]) content = renderMarkdown(data.extras[tab]);
    else {
      const running = ws.job && ['QUEUED', 'PROCESSING'].includes(ws.job.status) && ws.job.type === 'summary_extra';
      content = h('div', { class: 'row', style: { padding: '12px 0' } },
        h('p', { class: 'muted grow', style: { margin: 0 }, text: `Le ${cur.label.toLowerCase()} est généré à la demande à partir de l'analyse existante (quelques minutes).` }),
        button(running ? 'Génération…' : 'Générer', { variant: 'btn-primary', size: 'btn-sm', icon: 'sparkle', disabled: running, onClick: () => generateExtra(tab) }));
    }
    const regen = cur.extra && data.extras[tab] ? button('Régénérer', { size: 'btn-sm', variant: 'btn-ghost', icon: 'refresh', onClick: () => generateExtra(tab) }) : null;
    sections.push(h('section', { class: 'sheet-section' }, h('div', { class: 'row between' }, h('h3', { text: 'Résumé' }), regen), tabsEl, content));

    if (s.key_points && s.key_points.length) sections.push(listSection('À retenir', s.key_points, 'sparkle'));
    sections.push(itemsSection('Décisions', data.decisions, 'check', 'var(--cat-decision)', (d) => [d.text, null], 'decisions'));
    sections.push(itemsSection('Actions', data.actions, 'arrowRight', 'var(--cat-action)', (x) => [x.text, [x.owner && `Responsable : ${x.owner}`, x.deadline && `Échéance : ${x.deadline}`, statusLabel(x.status)].filter(Boolean).join(' · ')], 'actions'));
    sections.push(itemsSection('Questions ouvertes', data.questions.filter((q) => !q.resolved), 'question', 'var(--cat-question)', (q) => [q.text, null], 'questions'));
    if (data.risks.length) sections.push(itemsSection('Risques', data.risks, 'alert', 'var(--cat-risk)', (r) => [r.text, r.kind === 'inference' ? 'Interprétation IA — à confirmer' : 'Mentionné dans l’enregistrement'], 'questions'));
    if (s.problems && s.problems.length) sections.push(listSection('Problèmes', s.problems, 'alert'));
    if (data.topics.length) sections.push(h('section', { class: 'sheet-section' }, h('h3', {}, 'Sujets ', h('span', { class: 'n', text: data.topics.length })),
      h('div', { class: 'row-wrap' }, data.topics.map((t) => h('a', { class: 'chip', href: `#/audio/${ws.id}/topics` }, t.name, h('span', { class: 'count', text: fmtDuration(t.duration) }))))));
    const facts = [];
    if (s.figures && s.figures.length) facts.push(h('div', {}, h('h3', { text: 'Chiffres' }), bullets(s.figures)));
    if (s.dates && s.dates.length) facts.push(h('div', {}, h('h3', { text: 'Dates' }), bullets(s.dates)));
    if (facts.length) sections.push(h('section', { class: 'sheet-section grid grid-2' }, facts));
    if (data.people.length) sections.push(h('section', { class: 'sheet-section' }, h('h3', {}, 'Personnes ', h('span', { class: 'n', text: data.people.length })),
      h('div', { class: 'row-wrap' }, data.people.map((p) => h('a', { class: 'chip', href: `#/audio/${ws.id}/people` }, h('span', { class: 'avatar avatar-sm', text: p.name.slice(0, 1) }), p.name, p.role ? h('span', { class: 'count', text: p.role }) : null)))));
    if (data.quotes.length) sections.push(h('section', { class: 'sheet-section' }, h('h3', { text: 'Citations importantes' }),
      data.quotes.map((q) => h('div', { class: 'row', style: { alignItems: 'flex-start' } }, h('blockquote', { class: 'quote grow', text: `« ${q.text.replace(/^[«"]\s*|\s*[»"]$/g, '')} »` }), listenButton(q.start, (t) => ws.seek(t))))));

    sheet.append(...sections);
    mount(root, sheet);
  }

  const statusLabel = (s) => ({ todo: 'À faire', doing: 'En cours', done: 'Terminé' }[s] || s);
  const bullets = (items) => h('ul', { class: 'bullets' }, items.map((x) => h('li', { text: x })));

  function listSection(title, items) {
    return h('section', { class: 'sheet-section' }, h('h3', {}, title, ' ', h('span', { class: 'n', text: items.length })), bullets(items));
  }

  function itemsSection(title, items, ico, color, fmt, target) {
    const sec = h('section', { class: 'sheet-section' }, h('div', { class: 'row between' }, h('h3', {}, title, ' ', h('span', { class: 'n', text: items.length })),
      h('a', { class: 'btn btn-sm btn-ghost', href: `#/audio/${ws.id}/${target}`, text: 'Gérer' })));
    if (!items.length) { sec.appendChild(h('p', { class: 'muted', style: { margin: 0 }, text: 'Rien de détecté.' })); return sec; }
    items.forEach((it) => {
      const [main, sub] = fmt(it);
      sec.appendChild(h('div', { class: 'row-item' },
        h('span', { class: 'ri-ico', style: { '--c': color } }, ic(ico)),
        h('div', {}, h('div', { class: it.kind === 'inference' ? 'inference' : '', text: main }), sub ? h('div', { class: 'ri-sub', text: sub }) : null),
        it.time != null ? listenButton(it.time, (t) => ws.seek(t)) : h('span')));
    });
    return sec;
  }

  function briefingSection(b) {
    const block = (title, items, ico) => items && items.length ? h('div', {}, h('h4', { class: 'row gap-2', style: { marginBottom: '6px' } }, ic(ico), title), bullets(items)) : null;
    return h('section', { class: 'sheet-section', style: { background: 'var(--color-surface-alt)' } },
      h('div', { class: 'row between' }, h('h3', {}, ic('briefcase'), 'Mon briefing'), button('Régénérer', { size: 'btn-sm', variant: 'btn-ghost', icon: 'refresh', onClick: briefing })),
      h('div', { class: 'grid grid-2 mt-2' },
        block("Ce qu'il faut retenir", b.remember, 'sparkle'), block('Ce qui a été décidé', b.decided, 'check'),
        block("Ce qu'il faut faire", b.todo, 'arrowRight'), block('Ce qui reste à résoudre', b.unresolved, 'question'),
        block('Points sensibles', b.sensitive, 'alert')));
  }

  function drawEdit(s) {
    const f = {};
    const field = (key, label, rows = 3, list = false) => {
      const el = h('textarea', { class: 'textarea', rows });
      el.value = list ? (s[key] || []).join('\n') : s[key] || '';
      f[key] = { el, list };
      return h('div', { class: 'field' }, h('label', { text: label }), el, list ? h('div', { class: 'field-hint', text: 'Un élément par ligne.' }) : null);
    };
    const titleEl = h('input', { class: 'input', value: s.title || '' });
    f.title = { el: titleEl, list: false };
    mount(root, h('div', { class: 'panel sheet sheet-edit' },
      h('div', { class: 'sheet-cover' }, h('div', { class: 'kicker', text: 'Modifier la fiche de synthèse' }),
        h('p', { class: 'muted', text: 'Vos modifications créent une nouvelle version. La version générée par l’IA reste disponible dans l’historique.' })),
      h('div', { class: 'sheet-section col gap-4' },
        h('div', { class: 'field' }, h('label', { text: 'Titre' }), titleEl),
        field('tldr', 'TL;DR', 2), field('short', 'Résumé court', 6), field('executive', 'Résumé exécutif', 8),
        field('key_points', 'À retenir', 6, true), field('problems', 'Problèmes', 4, true),
        field('figures', 'Chiffres', 4, true), field('dates', 'Dates', 4, true), field('participants', 'Participants', 3, true)),
      h('div', { class: 'panel-foot row', style: { justifyContent: 'flex-end' } },
        button('Annuler', { variant: 'btn-ghost', onClick: () => { editing = false; draw(); } }),
        button('Enregistrer la fiche', { variant: 'btn-primary', icon: 'check', onClick: async () => {
          const content = Object.fromEntries(Object.entries(f).map(([k, { el, list }]) => [k, list ? el.value.split('\n').map((x) => x.trim()).filter(Boolean) : el.value.trim()]));
          try { data = await api.put(`/api/audio/${ws.id}/summary`, { content }); editing = false; toast('Fiche enregistrée (nouvelle version)', 'success'); draw(); } catch (err) { toastError(err); }
        } }))));
  }

  async function generateExtra(kind) {
    try {
      const r = await api.post(`/api/audio/${ws.id}/summary/${kind}`);
      toast('Rédaction lancée — elle apparaîtra ici dans quelques minutes.', 'success');
      ws.watchJob(r.job_id);
    } catch (err) { toastError(err); }
  }

  async function briefing() {
    try {
      const r = await api.post(`/api/audio/${ws.id}/briefing`);
      toast('Briefing en préparation…', 'success');
      ws.watchJob(r.job_id);
    } catch (err) { toastError(err); }
  }

  mount(root, skeleton('lines', 10));
  await load();
}
