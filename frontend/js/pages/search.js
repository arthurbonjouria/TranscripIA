import { api } from '../api.js';
import { h, ic, mount, empty, errorBox, fmtTime, pageHead, listenButton, skeleton, alertBox } from '../ui.js';
import { navigate } from '../app.js';

export async function render(root, params) {
  const state = { q: params.q || '', mode: params.mode || 'text' };
  const page = h('div', { class: 'page', style: { maxWidth: '1080px' } });
  const input = h('input', { class: 'input', type: 'search', value: state.q, placeholder: 'Apple Pay, budget, « prochaine réunion »…', 'aria-label': 'Recherche', style: { minHeight: '48px', fontSize: '1rem' } });
  const results = h('div');
  const modes = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Type de recherche' });
  const drawModes = () => mount(modes, [['text', 'Mots exacts'], ['semantic', 'Par le sens']].map(([k, l]) => {
    const b = h('button', { type: 'button', class: state.mode === k ? 'is-active' : '', text: l });
    b.onclick = () => { state.mode = k; drawModes(); run(); };
    return b;
  }));
  drawModes();
  const form = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); state.q = input.value.trim(); history.replaceState(null, '', `#/search?q=${encodeURIComponent(state.q)}&mode=${state.mode}`); run(); } },
    h('div', { class: 'search-input grow' }, ic('search'), input), modes, h('button', { class: 'btn btn-primary btn-lg', type: 'submit', text: 'Rechercher' }));
  mount(root, page);
  mount(page, pageHead({ kicker: 'Recherche globale', title: 'Retrouvez', accent: 'chaque mot', lede: 'Recherchez dans toutes vos transcriptions. Cliquez sur un résultat pour écouter le passage exact.' }), form, h('div', { class: 'mt-6' }, results));

  const highlight = (snippet) => {
    const frag = document.createDocumentFragment();
    String(snippet || '').split(/(\[\[.*?\]\])/).forEach((part) => {
      if (part.startsWith('[[') && part.endsWith(']]')) frag.appendChild(h('b', { text: part.slice(2, -2) }));
      else if (part) frag.appendChild(document.createTextNode(part));
    });
    return frag;
  };

  async function run() {
    if (!state.q) { mount(results, empty({ icon: 'search', title: 'Que cherchez-vous ?', text: 'Saisissez un mot, un nom, un sujet. La recherche ignore les accents et les majuscules.' })); return; }
    mount(results, h('div', { class: 'panel panel-pad' }, skeleton('lines', 6)));
    try {
      const r = await api.get(`/api/search${api.qs({ q: state.q, mode: state.mode, limit: 100 })}`);
      const parts = [];
      if (state.mode === 'semantic' && r.fallback) {
        parts.push(h('div', { class: 'mb-4' }, alertBox('info', 'Recherche par le sens non activée',
          "Aucun modèle d'embeddings local n'est installé : les résultats ci-dessous proviennent de la recherche par mots-clés. Installez-le depuis Paramètres → Modèles (ex. nomic-embed-text) pour activer la recherche sémantique.")));
      }
      if (!r.results.length) {
        parts.push(h('div', { class: 'panel' }, empty({ icon: 'search', title: 'Aucun résultat', text: `Aucun passage ne correspond à « ${state.q} ».` })));
        mount(results, parts);
        return;
      }
      if (r.by_audio && r.by_audio.length > 1) {
        parts.push(h('div', { class: 'row-wrap mb-4' }, h('span', { class: 'meta', text: `${r.results.length} passages dans ${r.by_audio.length} audios :` }),
          r.by_audio.map((g) => h('a', { class: 'chip', href: `#/audio/${g.audio_id}/transcript` }, g.audio_title, h('span', { class: 'count', text: g.count })))));
      }
      parts.push(h('div', { class: 'panel' }, r.results.map((x) => h('div', { class: 'result' },
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'row gap-2', style: { flexWrap: 'wrap' } },
            h('a', { href: `#/audio/${x.audio_id}/transcript?t=${x.start}`, style: { fontWeight: 600 }, text: x.audio_title }),
            h('span', { class: 'meta mono', text: fmtTime(x.start) }),
            x.chapter ? h('span', { class: 'meta', text: `· ${x.chapter}` }) : null,
            x.speaker ? h('span', { class: 'meta', text: `· ${x.speaker}` }) : null,
            x.match === 'semantic' ? h('span', { class: 'badge badge-info', text: `similarité ${Math.round(x.score * 100)} %` }) : null),
          h('div', { class: 'r-snippet' }, x.snippet ? highlight(x.snippet) : x.text)),
        listenButton(x.start, () => navigate(`#/audio/${x.audio_id}/transcript?t=${x.start}`))))));
      mount(results, parts);
    } catch (err) { mount(results, errorBox(err, { retry: run })); }
  }
  run();
  input.focus();
}
