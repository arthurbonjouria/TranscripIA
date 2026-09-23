// Insights, moments clés, actions, décisions, questions & risques, personnes, sujets & entités.
import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtTime, fmtDuration, button, iconButton, toast, toastError, formDialog, listenButton, stars, initials, skeleton, parseTime } from '../ui.js';
import { category, CATEGORY } from '../icons.js';

const STATUS = { todo: 'À faire', doing: 'En cours', done: 'Terminé' };
const ENTITY_LABELS = { person: 'Personnes', company: 'Entreprises', product: 'Produits', place: 'Lieux', date: 'Dates', amount: 'Montants', percentage: 'Pourcentages', technology: 'Technologies', email: 'Emails', url: 'URLs' };

export async function render(root, ws, section) {
  mount(root, skeleton('lines', 10));
  let ins;
  const load = async () => {
    try { ins = await api.get(`/api/audio/${ws.id}/insights`); draw(); } catch (err) { mount(root, errorBox(err, { retry: load })); }
  };
  const refresh = async () => { await load(); ws.refreshTimeline(); ws.refreshAudio(); };
  const seek = (t) => ws.seek(t);
  const noAnalysis = () => h('div', { class: 'panel' }, empty({
    icon: 'sparkle', title: 'Aucune analyse pour le moment',
    text: ws.audio.transcription?.status === 'completed' ? "Lancez l'analyse IA pour détecter automatiquement ces éléments. Vous pouvez aussi les ajouter vous-même." : "Ces éléments apparaîtront à la fin de l'analyse.",
  }));

  function draw() {
    const fn = { insights: drawInsights, moments: drawMoments, actions: drawActions, decisions: drawDecisions, questions: drawQuestions, people: drawPeople, topics: drawTopics }[section];
    mount(root, fn());
  }

  // ------------------------------------------------------------ Insights (vue de synthèse rapide)
  function drawInsights() {
    const card = (title, ico, color, items, fmt, target) => h('div', { class: 'panel ins-card' },
      h('div', { class: 'panel-head' }, h('h3', {}, h('span', { class: 'ico', style: { '--c': color } }, ic(ico)), title, h('span', { class: 'caption', text: ` ${items.length}` })),
        target ? h('a', { class: 'btn btn-sm btn-ghost', href: `#/audio/${ws.id}/${target}`, text: 'Détail' }) : null),
      items.length ? h('div', { class: 'panel-body list' }, items.slice(0, 5).map((it) => h('div', { class: 'list-item' },
        h('div', { class: 'li-main' }, fmt(it)), (it.time ?? it.start) != null ? listenButton(it.time ?? it.start, seek) : null)))
        : h('div', { class: 'panel-body caption', text: 'Rien de détecté.' }));
    const s = ins.summary;
    const top = s ? h('div', { class: 'panel panel-pad mb-6' }, h('div', { class: 'kicker', text: 'En une phrase' }),
      h('p', { class: 'reading', style: { fontSize: '1.2rem', margin: '6px 0 0' }, text: s.tldr || s.short })) : null;
    if (!s && !ins.highlights.length) return noAnalysis();
    return h('div', {}, top, h('div', { class: 'insights-grid' },
      card('Points majeurs', 'flame', 'var(--color-primary)', ins.key_moments, (x) => [h('div', { class: 'row gap-2' }, h('span', { class: 'cat', style: { '--c': category(x.category).color }, text: category(x.category).label }), stars(x.importance)), h('div', { class: 'mt-2', text: x.text })], 'moments'),
      card('Décisions', 'check', 'var(--cat-decision)', ins.decisions, (x) => h('div', { text: x.text }), 'decisions'),
      card('Actions', 'arrowRight', 'var(--cat-action)', ins.actions, (x) => [h('div', { class: 'li-title', text: x.text }), h('div', { class: 'meta', text: [x.owner, x.deadline, STATUS[x.status]].filter(Boolean).join(' · ') })], 'actions'),
      card('Questions', 'question', 'var(--cat-question)', ins.questions, (x) => h('div', { text: x.text }), 'questions'),
      card('Risques', 'alert', 'var(--cat-risk)', ins.risks, (x) => [h('div', { class: x.kind === 'inference' ? 'inference' : '', text: x.text }), h('div', { class: 'meta', text: x.kind === 'inference' ? 'Interprétation IA' : 'Mentionné' })], 'questions'),
      card('Idées & opportunités', 'lightbulb', 'var(--cat-idea)', ins.ideas, (x) => h('div', { text: x.text }), 'moments')));
  }

  // ------------------------------------------------------------ Moments clés
  let filter = '';
  let minImp = 0;
  function drawMoments() {
    const cats = [...new Set(ins.highlights.map((x) => x.category))];
    const items = ins.highlights.filter((x) => (!filter || x.category === filter) && x.importance >= minImp).sort((a, b) => b.importance - a.importance || a.start - b.start);
    const chips = h('div', { class: 'row-wrap mb-4' },
      chip('Tous', !filter, () => { filter = ''; draw(); }, ins.highlights.length),
      cats.map((c) => chip(category(c).label, filter === c, () => { filter = c; draw(); }, ins.highlights.filter((x) => x.category === c).length, category(c).color)),
      h('span', { class: 'grow' }),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Importance minimale' }, [[0, 'Tous'], [0.6, '★★★+'], [0.8, '★★★★+']].map(([v, l]) => {
        const b = h('button', { type: 'button', class: minImp === v ? 'is-active' : '', text: l });
        b.onclick = () => { minImp = v; draw(); };
        return b;
      })));
    if (!ins.highlights.length) return noAnalysis();
    return h('div', {}, chips, h('div', { class: 'panel' }, items.length ? items.map((x) => {
      const c = category(x.category);
      return h('div', { class: 'moment' },
        h('div', {}, h('div', { class: 'm-time', text: fmtTime(x.start, ws.audio.duration >= 3600) }), h('div', { class: 'mt-2' }, stars(x.importance))),
        h('div', {},
          h('div', { class: 'row gap-2' }, h('span', { class: 'cat', style: { '--c': c.color }, text: c.label }), x.source === 'user' ? h('span', { class: 'badge', text: 'manuel' }) : h('span', { class: 'badge badge-outline', text: 'IA' }), x.favorite ? h('span', { class: 'badge badge-primary', text: 'favori' }) : null),
          h('div', { class: 'm-text', text: x.text }),
          x.note ? h('div', { class: 'm-src', text: x.note }) : null),
        h('div', { class: 'col', style: { alignItems: 'flex-end' } },
          button('Écouter', { size: 'btn-sm', variant: 'btn-primary', icon: 'playSm', onClick: () => seek(x.start) }),
          h('div', { class: 'row gap-1' },
            iconButton('star', x.favorite ? 'Retirer des favoris' : 'Favori', async () => { await api.patch(`/api/highlights/${x.id}`, { favorite: !x.favorite }); refresh(); }, 'btn-sm'),
            iconButton('trash', 'Supprimer', async () => { await api.del(`/api/highlights/${x.id}`); refresh(); }, 'btn-sm'))));
    }) : empty({ icon: 'filter', title: 'Aucun moment pour ce filtre', small: true })));
  }

  function chip(label, active, onClick, count, color) {
    return h('button', { class: `chip ${active ? 'is-active' : ''}`, type: 'button', onclick: onClick },
      color ? h('span', { class: 'swatch', style: { background: color } }) : null, label, count != null ? h('span', { class: 'count', text: count }) : null);
  }

  // ------------------------------------------------------------ Éléments éditables (actions, décisions, questions, risques)
  async function addItem(kind, fields, title) {
    const v = await formDialog(title, [...fields, { name: 'time', label: 'Horodatage', value: fmtTime(ws.player.time, ws.audio.duration >= 3600), hint: 'Position de lecture par défaut' }], { submitLabel: 'Ajouter' });
    if (!v || !v.text) return;
    try { await api.post(`/api/items/${kind}`, { ...v, audio_id: ws.id, time: parseTime(v.time) }); toast('Ajouté', 'success'); refresh(); } catch (err) { toastError(err); }
  }
  async function editItem(kind, item, fields) {
    const v = await formDialog('Modifier', fields.map((f) => ({ ...f, value: item[f.name] ?? '' })));
    if (!v) return;
    try { await api.patch(`/api/items/${kind}/${item.id}`, v); refresh(); } catch (err) { toastError(err); }
  }
  const delItem = async (kind, item) => { await api.del(`/api/items/${kind}/${item.id}`); refresh(); };
  const sourceBadge = (x) => (x.source === 'user' ? h('span', { class: 'badge', text: 'manuel' }) : null);

  function drawActions() {
    const fields = [{ name: 'text', label: 'Action' }, { name: 'owner', label: 'Responsable' }, { name: 'deadline', label: 'Échéance', placeholder: 'vendredi, 12/11…' }];
    const groups = ['todo', 'doing', 'done'].map((st) => [st, ins.actions.filter((a) => a.status === st)]);
    const head = h('div', { class: 'row between mb-4' }, h('div', { class: 'meta', text: `${ins.actions.length} actions · ${ins.actions.filter((a) => a.status !== 'done').length} ouvertes` }),
      button('Ajouter une action', { size: 'btn-sm', icon: 'plus', onClick: () => addItem('actions', fields, 'Nouvelle action') }));
    if (!ins.actions.length) return h('div', {}, head, h('div', { class: 'panel' }, empty({ icon: 'checkSquare', title: 'Aucune action', text: "Les actions (qui fait quoi, pour quand) sont détectées par l'analyse IA. Vous pouvez en ajouter.", small: true })));
    return h('div', {}, head, h('div', { class: 'grid grid-3' }, groups.map(([st, items]) => h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, STATUS[st], h('span', { class: 'caption', text: `  ${items.length}` }))),
      items.length ? h('div', { class: 'panel-body list' }, items.map((a) => {
        const check = h('button', { class: `check ${a.status === 'done' ? 'on' : ''}`, type: 'button', title: a.status === 'done' ? 'Rouvrir' : 'Marquer comme terminé', 'aria-label': 'Terminé' }, a.status === 'done' ? ic('check') : null);
        check.onclick = async () => { await api.patch(`/api/items/actions/${a.id}`, { status: a.status === 'done' ? 'todo' : 'done' }); refresh(); };
        const sel = h('select', { class: `status-select status-${a.status}`, 'aria-label': 'Statut' }, Object.entries(STATUS).map(([k, l]) => h('option', { value: k, text: l })));
        sel.value = a.status;
        sel.onchange = async () => { await api.patch(`/api/items/actions/${a.id}`, { status: sel.value }); refresh(); };
        return h('div', { class: `list-item ${a.status === 'done' ? 'action-done' : ''}` }, check,
          h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: a.text }),
            h('div', { class: 'meta' }, a.owner ? [h('b', { text: 'Responsable : ' }), a.owner] : 'Responsable non précisé', a.deadline ? [' · ', h('b', { text: 'Échéance : ' }), a.deadline] : ''),
            a.context ? h('div', { class: 'caption mt-2 inference', text: `« ${a.context} »` }) : null,
            h('div', { class: 'row gap-2 mt-2' }, sel, a.time != null ? listenButton(a.time, seek) : null, sourceBadge(a))),
          h('div', { class: 'li-actions', style: { flexDirection: 'column' } },
            iconButton('edit', 'Modifier', () => editItem('actions', a, fields), 'btn-sm'), iconButton('trash', 'Supprimer', () => delItem('actions', a), 'btn-sm')));
      })) : h('div', { class: 'panel-body caption', text: 'Aucune.' })))));
  }

  function simpleList(kind, items, ico, color, fields, title, addTitle, extra) {
    const head = h('div', { class: 'row between mb-4' }, h('h3', {}, title, h('span', { class: 'caption', text: `  ${items.length}` })),
      button(addTitle, { size: 'btn-sm', icon: 'plus', onClick: () => addItem(kind, fields, addTitle) }));
    return h('div', { class: 'mb-6' }, head, h('div', { class: 'panel' }, items.length ? h('div', { class: 'panel-body list' }, items.map((x) => h('div', { class: 'list-item' },
      h('span', { class: 'ri-ico', style: { color } }, ic(ico)),
      h('div', { class: 'li-main' }, h('div', { class: `li-title ${x.kind === 'inference' ? 'inference' : ''}`, text: x.text }), extra ? extra(x) : null,
        x.context ? h('div', { class: 'caption mt-2 inference', text: `« ${x.context} »` }) : null, sourceBadge(x)),
      x.time != null ? listenButton(x.time, seek) : null,
      h('div', { class: 'li-actions' }, iconButton('edit', 'Modifier', () => editItem(kind, x, fields), 'btn-sm'), iconButton('trash', 'Supprimer', () => delItem(kind, x), 'btn-sm')))))
      : empty({ icon: ico, title: 'Rien de détecté', small: true })));
  }

  function drawDecisions() {
    return simpleList('decisions', ins.decisions, 'check', 'var(--cat-decision)', [{ name: 'text', label: 'Décision' }], 'Décisions', 'Ajouter une décision');
  }

  function drawQuestions() {
    const q = simpleList('questions', ins.questions, 'question', 'var(--cat-question)', [{ name: 'text', label: 'Question' }], 'Questions ouvertes', 'Ajouter une question', (x) => {
      const cb = h('label', { class: 'checkbox caption mt-2' }, h('input', { type: 'checkbox', checked: x.resolved ? true : null, onchange: async (e) => { await api.patch(`/api/items/questions/${x.id}`, { resolved: e.target.checked }); refresh(); } }), 'Résolue');
      return cb;
    });
    const r = simpleList('risks', ins.risks, 'alert', 'var(--cat-risk)', [{ name: 'text', label: 'Risque' }, { name: 'kind', label: 'Nature (fact / inference)', value: 'fact' }], 'Risques', 'Ajouter un risque', (x) => h('div', { class: 'row gap-2 mt-2' },
      h('span', { class: `badge ${x.kind === 'inference' ? 'badge-warning' : 'badge-danger'}`, text: x.kind === 'inference' ? 'Interprétation IA — à vérifier' : 'Fait mentionné dans la source' }),
      h('span', { class: 'badge badge-outline', text: { low: 'Faible', medium: 'Moyen', high: 'Élevé' }[x.severity] || x.severity })));
    return h('div', {}, q, r, h('p', { class: 'caption', text: "Les risques marqués « Interprétation IA » sont des déductions du modèle : ils ne figurent pas explicitement dans l'enregistrement." }));
  }

  // ------------------------------------------------------------ Personnes
  function drawPeople() {
    if (!ins.people.length) return h('div', { class: 'panel' }, empty({ icon: 'users', title: 'Aucune personne détectée', text: "Les personnes mentionnées apparaîtront après l'analyse. La diarisation (qui parle quand) pourra s'y ajouter ultérieurement." }));
    const dur = ws.audio.duration || 1;
    return h('div', { class: 'people-grid' }, ins.people.map((p) => h('div', { class: 'panel person' },
      h('div', { class: 'row' }, h('span', { class: 'avatar', text: initials(p.name) }),
        h('div', { class: 'grow' }, h('div', { class: 'li-title', text: p.name }), h('div', { class: 'meta', text: p.role || 'Rôle non précisé' })),
        iconButton('edit', 'Modifier', async () => { const v = await formDialog('Personne', [{ name: 'name', label: 'Nom', value: p.name }, { name: 'role', label: 'Rôle', value: p.role }]); if (v) { await api.patch(`/api/people/${p.id}`, v); refresh(); } }, 'btn-sm')),
      h('div', { class: 'meta mt-4', text: `${p.mentions} mention${p.mentions > 1 ? 's' : ''}` }),
      h('div', { class: 'mini-timeline', 'aria-label': 'Mentions dans le temps' }, p.times.map((t) => h('button', { type: 'button', title: fmtTime(t), style: { left: `${(t / dur) * 100}%` }, onclick: () => seek(t) }))),
      p.topics.length ? h('div', { class: 'row-wrap mt-4' }, p.topics.map((t) => h('span', { class: 'tag', text: t }))) : null,
      p.quotes.length ? h('div', { class: 'mt-4' }, p.quotes.slice(0, 3).map((q) => h('div', { class: 'row', style: { alignItems: 'flex-start', marginBottom: '6px' } },
        h('div', { class: 'grow caption reading', style: { fontSize: '0.92rem', lineHeight: 1.6 }, text: q.text }), listenButton(q.time, seek)))) : null)));
  }

  // ------------------------------------------------------------ Sujets & entités
  function drawTopics() {
    const dur = ws.audio.duration || 1;
    const maxDur = Math.max(1, ...ins.topics.map((t) => t.duration));
    const chapters = Object.fromEntries((ws.timeline.chapters || []).map((c, i) => [c.id, i + 1]));
    const topics = h('div', { class: 'panel mb-6' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Sujets' }), h('span', { class: 'caption', text: 'Durée · occurrences · chapitres · moments clés' })),
      ins.topics.length ? ins.topics.map((t) => h('div', { class: 'topic-row' },
        h('div', {}, h('div', { class: 'li-title', text: t.name }), h('div', { class: 'topic-bar' }, h('span', { style: { width: `${(t.duration / maxDur) * 100}%` } })),
          h('div', { class: 'mini-timeline' }, t.times.map((x) => h('button', { type: 'button', title: fmtTime(x), style: { left: `${(x / dur) * 100}%` }, onclick: () => seek(x) })))),
        h('div', { class: 'tnum', text: fmtDuration(t.duration) }),
        h('div', { class: 'tnum', text: `${t.occurrences} occ.` }),
        h('div', { class: 'caption', text: t.chapter_ids.length ? `Ch. ${t.chapter_ids.map((id) => chapters[id]).filter(Boolean).join(', ')}` : '—' }),
      )) : empty({ icon: 'tag', title: 'Aucun sujet détecté', small: true }));
    const byType = {};
    ins.entities.forEach((e) => { (byType[e.type] = byType[e.type] || []).push(e); });
    const ents = h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Entités extraites' }), h('span', { class: 'caption', text: 'Cliquez pour écouter la première mention' })),
      Object.keys(byType).length ? h('div', { class: 'panel-body grid grid-2' }, Object.entries(byType).map(([type, list]) => h('div', {},
        h('div', { class: 'kicker mb-2', text: ENTITY_LABELS[type] || type }),
        h('div', { class: 'entity-cloud' }, list.map((e) => h('button', { class: 'chip', type: 'button', title: e.source === 'regex' ? 'Détecté automatiquement dans le texte' : 'Détecté par l’IA', onclick: () => e.times[0] != null && seek(e.times[0]) }, e.value, h('span', { class: 'count', text: e.count }))))))) : empty({ icon: 'hash', title: 'Aucune entité', small: true }));
    return h('div', {}, topics, ents);
  }

  await load();
}

export { CATEGORY };
