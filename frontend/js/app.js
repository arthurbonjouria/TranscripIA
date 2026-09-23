// BONJOUR IA — Audio Intelligence Workspace · coquille de l'application et routeur.
import { api } from './api.js';
import { h, ic, mount, clear, closeMenu, hideTip } from './ui.js';

const routes = [
  { re: /^\/?$/, page: 'dashboard' },
  { re: /^\/library\/?$/, page: 'library' },
  { re: /^\/import\/?$/, page: 'import' },
  { re: /^\/audio\/(\d+)(?:\/([\w-]+))?\/?$/, page: 'audio', keys: ['id', 'section'] },
  { re: /^\/search\/?$/, page: 'search' },
  { re: /^\/chat\/?$/, page: 'chat' },
  { re: /^\/compare\/?$/, page: 'compare' },
  { re: /^\/actions\/?$/, page: 'actions' },
  { re: /^\/jobs\/?$/, page: 'jobs' },
  { re: /^\/health\/?$/, page: 'health' },
  { re: /^\/settings\/?$/, page: 'settings' },
];

const NAV = [
  { title: 'Espace de travail', items: [
    { href: '#/', page: 'dashboard', icon: 'home', label: 'Tableau de bord' },
    { href: '#/library', page: 'library', icon: 'library', label: 'Bibliothèque' },
    { href: '#/import', page: 'import', icon: 'upload', label: 'Importer' },
  ] },
  { title: 'Explorer', items: [
    { href: '#/search', page: 'search', icon: 'search', label: 'Recherche' },
    { href: '#/chat', page: 'chat', icon: 'chat', label: 'Chat IA' },
    { href: '#/compare', page: 'compare', icon: 'compare', label: 'Comparer & briefer' },
    { href: '#/actions', page: 'actions', icon: 'checkSquare', label: 'Actions' },
  ] },
  { title: 'Système', items: [
    { href: '#/jobs', page: 'jobs', icon: 'layers', label: 'Traitements', count: 'jobs' },
    { href: '#/health', page: 'health', icon: 'activity', label: 'Diagnostic' },
    { href: '#/settings', page: 'settings', icon: 'settings', label: 'Paramètres' },
  ] },
];

const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const appEl = document.getElementById('app');
let cleanup = null;
let current = { page: null, params: {} };
let activeJobs = 0;
const modules = {};

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

// ------------------------------------------------------------------ barre latérale
function privacyNote() {
  return h('div', { class: 'sidebar-foot' },
    h('div', { class: 'privacy-note' }, ic('shield'),
      h('div', {}, h('strong', { text: 'Traitement local' }),
        'Vos fichiers audio et vos données sont traités localement sur cette machine.')));
}

export function renderDefaultSidebar() {
  mount(sidebar,
    NAV.map((sec) => h('div', { class: 'nav-section' },
      h('div', { class: 'nav-title', text: sec.title }),
      sec.items.map((it) => {
        const a = h('a', { class: `nav-link ${current.page === it.page ? 'is-active' : ''}`, href: it.href, 'aria-current': current.page === it.page ? 'page' : null },
          ic(it.icon), h('span', { text: it.label }));
        if (it.count === 'jobs' && activeJobs) a.appendChild(h('span', { class: 'nav-count', text: String(activeJobs) }));
        return a;
      }))),
    privacyNote());
}

export function setSidebar(content) { mount(sidebar, content, privacyNote()); }

// ------------------------------------------------------------------ routeur
function parse() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  const [path, query = ''] = raw.split('?');
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = Object.fromEntries(new URLSearchParams(query));
      (r.keys || []).forEach((k, i) => { if (m[i + 1] !== undefined) params[k] = m[i + 1]; });
      return { page: r.page, params };
    }
  }
  return { page: 'dashboard', params: {} };
}

async function route() {
  const next = parse();
  closeMenu();
  hideTip();
  appEl.classList.remove('nav-open');
  // Même audio, autre section : on laisse la page gérer sans tout recharger
  if (next.page === 'audio' && current.page === 'audio' && next.params.id === current.params.id && modules.audio?.onSection) {
    current = next;
    modules.audio.onSection(next.params.section, next.params);
    return;
  }
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  current = next;
  renderDefaultSidebar();
  clear(main);
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    const mod = modules[next.page] || (modules[next.page] = await import(`./pages/${next.page}.js`));
    const res = await mod.render(main, next.params, { setSidebar, renderDefaultSidebar, emit, bus });
    if (typeof res === 'function') cleanup = res;
  } catch (err) {
    console.error(err);
    mount(main, h('div', { class: 'page' }, h('div', { class: 'alert alert-danger' }, ic('alert'),
      h('div', {}, h('div', { class: 'alert-title', text: "Cette page n'a pas pu s'afficher." }), h('div', { text: String(err.message || err) })))));
  }
  const title = { dashboard: 'Tableau de bord', library: 'Bibliothèque', import: 'Importer', audio: 'Audio', search: 'Recherche',
    chat: 'Chat IA', compare: 'Comparer', actions: 'Actions', jobs: 'Traitements', health: 'Diagnostic', settings: 'Paramètres' }[next.page];
  if (next.page !== 'audio') document.title = `${title} · BONJOUR IA — Audio Intelligence`;
}

export function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// ------------------------------------------------------------------ surveillance des traitements
async function pollJobs() {
  try {
    const jobs = await api.get('/api/jobs?active=true&limit=50');
    const n = jobs.length;
    if (n !== activeJobs) {
      const wasBusy = activeJobs > 0;
      activeJobs = n;
      if (current.page !== 'audio') renderDefaultSidebar();
      if (wasBusy && n === 0) emit('jobs-idle');
    }
    const ind = document.getElementById('jobs-indicator');
    mount(ind, ic('layers'), n ? h('span', { class: 'badge-count', text: String(n) }) : null);
    ind.title = n ? `${n} traitement(s) en cours` : 'Aucun traitement en cours';
    emit('jobs', jobs);
  } catch { /* serveur momentanément indisponible */ }
  setTimeout(pollJobs, activeJobs ? 2000 : 5000);
}

// ------------------------------------------------------------------ démarrage
function initShell() {
  const badge = document.querySelector('.local-badge');
  mount(badge, ic('lock'), h('span', { text: 'Traitement local' }));
  mount(document.getElementById('import-cta'), ic('upload'), h('span', { text: 'Importer' }));
  mount(document.getElementById('menu-toggle'), ic('menu'));
  document.getElementById('menu-toggle').onclick = () => appEl.classList.toggle('nav-open');
  const search = document.getElementById('global-search');
  search.prepend(ic('search'));
  search.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('global-q').value.trim();
    if (q) navigate(`#/search?q=${encodeURIComponent(q)}`);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('global-q').focus(); }
  });
  try { const theme = localStorage.getItem('bj.theme'); if (theme) document.documentElement.dataset.theme = theme; } catch { /* */ }
}

initShell();
window.addEventListener('hashchange', route);
route();
pollJobs();
