import { api } from '../api.js';
import { h, ic, mount, skeleton, empty, errorBox, fmtDuration, fmtNumber, relTime, audioStatus, jobStatus, isActiveJob, listenButton, stars, button } from '../ui.js';
import { category } from '../icons.js';
import { miniWave } from '../waveform.js';
import { navigate } from '../app.js';

export async function render(root, _params, ctx) {
  const page = h('div', { class: 'page' });
  mount(root, page);
  mount(page, skeleton('page'));

  let data;
  const load = async () => {
    try {
      data = await api.get('/api/dashboard');
      draw();
    } catch (err) {
      mount(page, errorBox(err, { title: "Le tableau de bord n'a pas pu être chargé.", retry: load }));
    }
  };

  function draw() {
    const s = data.stats;
    const hour = new Date().getHours();
    const hello = hour < 18 ? 'Bonjour' : 'Bonsoir';
    const hero = h('section', { class: 'hero' },
      h('div', {},
        h('div', { class: 'kicker', text: 'Audio Intelligence Workspace' }),
        h('h1', {}, `${hello}. Transformez vos enregistrements en `, h('span', { class: 'accent', text: 'décisions claires' }), '.'),
        h('p', { text: "Importez une réunion, un entretien ou une conférence : l'analyse produit la transcription, les chapitres, la synthèse, les décisions et les actions. Tout reste sur cette machine." })),
      h('div', { class: 'btn-group' },
        button('Importer un audio', { variant: 'btn-primary btn-lg', icon: 'upload', onClick: () => navigate('#/import') }),
        button('Bibliothèque', { variant: 'btn-lg', onClick: () => navigate('#/library') })));

    const tile = (value, label, href, pink) => {
      const inner = [h('div', { class: `stat-value ${pink ? 'pink' : ''}`, text: value }), h('div', { class: 'stat-label', text: label })];
      return h('div', { class: 'stat' }, href ? h('a', { href }, inner) : inner);
    };
    const stats = h('section', { class: 'section' },
      h('div', { class: 'stats', role: 'list' },
        tile(fmtNumber(s.audios), 'Audios', '#/library'),
        tile(fmtDuration(s.duration), 'Durée totale analysée'),
        tile(fmtNumber(s.analyses), 'Analyses complètes'),
        tile(fmtNumber(s.chapters), 'Chapitres'),
        tile(fmtNumber(s.key_moments), 'Moments clés'),
        tile(fmtNumber(s.actions_open), `Actions ouvertes · ${s.actions} au total`, '#/actions', s.actions_open > 0),
        tile(fmtNumber(s.decisions), 'Décisions'),
        tile(fmtNumber(s.questions), 'Questions ouvertes'),
        tile(fmtNumber(s.processing), 'Traitements en cours', '#/jobs', s.processing > 0),
        tile('100 %', 'Traité localement')));

    // Continuer
    const cont = h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('div', {}, h('div', { class: 'kicker', text: 'Reprendre' }), h('h2', { text: 'Continuer' })),
        h('a', { class: 'btn btn-sm btn-ghost', href: '#/library' }, 'Toute la bibliothèque', ic('arrowRight'))));
    if (!data.recent.length) {
      cont.appendChild(h('div', { class: 'panel' }, empty({
        icon: 'wave', title: 'Aucun audio',
        text: 'Importez votre premier fichier audio pour commencer.',
        action: button('Importer un audio', { variant: 'btn-primary', icon: 'upload', onClick: () => navigate('#/import') }),
      })));
    } else {
      const cards = h('div', { class: 'audio-cards' });
      data.recent.forEach((a) => {
        const cv = h('canvas', { class: 'ac-wave' });
        cards.appendChild(h('a', { class: 'audio-card', href: `#/audio/${a.id}` },
          h('div', { class: 'row between' }, audioStatus(a.status), h('span', { class: 'meta', text: relTime(a.last_opened_at || a.created_at) })),
          h('div', { class: 'ac-title clamp-2', text: a.title }),
          cv,
          h('div', { class: 'ac-foot' },
            h('span', { class: 'meta', text: fmtDuration(a.duration) }),
            h('span', { class: 'meta', text: `${a.chapter_count} chapitres · ${a.highlight_count} highlights` }))));
        api.get(`/api/audio/${a.id}/peaks`).then((p) => p && p.peaks && miniWave(cv, p.peaks)).catch(() => miniWave(cv, null));
      });
      cont.appendChild(cards);
    }

    // Moments clés + actions + activité
    const moments = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Moments clés récents' })),
      data.key_moments.length ? h('div', { class: 'panel-body list' }, data.key_moments.map((m) => {
        const c = category(m.category);
        return h('div', { class: 'list-item' },
          h('div', { class: 'li-main' },
            h('div', { class: 'row gap-2' }, h('span', { class: 'cat', style: { '--c': c.color }, text: c.label }), stars(m.importance)),
            h('div', { class: 'mt-2 clamp-2', text: m.text }),
            h('div', { class: 'meta', text: m.audio_title })),
          listenButton(m.start, () => navigate(`#/audio/${m.audio_id}/overview?t=${m.start}`)));
      })) : empty({ icon: 'flame', title: 'Pas encore de moments clés', text: "Ils apparaîtront après l'analyse d'un audio.", small: true }));

    const actions = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Actions à suivre' }), h('a', { class: 'btn btn-sm btn-ghost', href: '#/actions', text: 'Tout voir' })),
      data.open_actions.length ? h('div', { class: 'panel-body list' }, data.open_actions.map((x) => h('div', { class: 'list-item' },
        h('span', { class: 'i-ico', style: { color: 'var(--cat-action)' } }, ic('arrowRight')),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title', text: x.text }),
          h('div', { class: 'meta', text: [x.owner && `Responsable : ${x.owner}`, x.deadline && `Échéance : ${x.deadline}`, x.audio_title].filter(Boolean).join(' · ') })),
        x.time != null ? listenButton(x.time, () => navigate(`#/audio/${x.audio_id}/actions?t=${x.time}`)) : null)))
        : empty({ icon: 'checkSquare', title: 'Aucune action en attente', text: 'Les actions détectées dans vos audios apparaîtront ici.', small: true }));

    const activity = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { text: 'Activité récente' }), h('a', { class: 'btn btn-sm btn-ghost', href: '#/jobs', text: 'Traitements' })),
      data.activity.length ? h('div', { class: 'panel-body' }, data.activity.map((j) => h('div', { class: 'activity-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'truncate', style: { fontWeight: 500 } }, j.audio_title ? h('a', { href: `#/audio/${j.audio_id}`, text: j.audio_title }) : j.label),
          h('div', { class: 'meta', text: `${j.label} · ${j.message || ''} · ${relTime(j.updated_at)}` }),
          isActiveJob(j.status) ? h('div', { class: 'progress mt-2' }, h('span', { style: { width: `${j.progress}%` } })) : null),
        jobStatus(j.status))))
        : empty({ icon: 'layers', title: 'Aucune activité', text: 'Les traitements lancés apparaîtront ici.', small: true }));

    mount(page, hero, stats, cont,
      h('section', { class: 'section grid grid-3' }, moments, actions, activity));
  }

  await load();
  const onIdle = () => load();
  ctx.bus.addEventListener('jobs-idle', onIdle);
  return () => ctx.bus.removeEventListener('jobs-idle', onIdle);
}
