// Briques d'interface. Règle de sécurité : le texte provenant des données passe TOUJOURS par textContent.
import { icon } from './icons.js';

// ------------------------------------------------------------------ construction DOM
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'icon') el.insertAdjacentHTML('afterbegin', icon(v)); // icônes statiques uniquement
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function ic(name, cls) {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

// ------------------------------------------------------------------ formats
export function fmtTime(sec, forceHours = false) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh || forceHours ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function fmtDuration(sec) {
  if (!sec) return '0 min';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
  if (hh) return `${hh} h ${String(mm).padStart(2, '0')}`;
  if (mm) return `${mm} min`;
  return `${s} s`;
}

export function fmtBytes(n) {
  if (!n) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0).replace('.', ',')} ${u[i]}`;
}

export function fmtNumber(n) { return new Intl.NumberFormat('fr-FR').format(n || 0); }

export function parseDate(s) {
  if (!s) return null;
  return new Date(s.includes('T') || s.length <= 10 ? s : s.replace(' ', 'T') + 'Z');
}

export function fmtDate(s, withTime = false) {
  const d = parseDate(s);
  if (!d || Number.isNaN(d.getTime())) return '';
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fr-FR', opts);
}

export function relTime(s) {
  const d = parseDate(s);
  if (!d) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `il y a ${Math.floor(diff / 86400)} j`;
  return fmtDate(s);
}

export function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

export function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// ------------------------------------------------------------------ petits composants
export function stars(importance) {
  const n = Math.max(1, Math.min(5, Math.round((importance || 0) * 5)));
  return h('span', { class: 'stars', title: `Importance ${n}/5`, 'aria-label': `Importance ${n} sur 5` },
    '★'.repeat(n), h('span', { class: 'off' }, '★'.repeat(5 - n)));
}

const AUDIO_STATUS = {
  uploaded: ['Importé', ''], queued: ['En attente', 'badge-info'], processing: ['En cours', 'badge-primary badge-live'],
  transcribed: ['Transcrit', 'badge-info'], analyzed: ['Analysé', 'badge-success'], failed: ['Échec', 'badge-danger'],
};
export function audioStatus(status) {
  const [label, cls] = AUDIO_STATUS[status] || [status, ''];
  return h('span', { class: `badge ${cls}` }, h('span', { class: 'dot' }), label);
}

const JOB_STATUS = {
  QUEUED: ['En attente', 'badge-info'], PROCESSING: ['Préparation', 'badge-primary badge-live'],
  TRANSCRIBING: ['Transcription', 'badge-primary badge-live'], SEGMENTING: ['Segmentation', 'badge-primary badge-live'],
  CHAPTERING: ['Chapitrage', 'badge-primary badge-live'], ANALYZING: ['Analyse', 'badge-primary badge-live'],
  INDEXING: ['Indexation', 'badge-primary badge-live'], COMPLETED: ['Terminé', 'badge-success'],
  FAILED: ['Échec', 'badge-danger'], CANCELLED: ['Annulé', ''],
};
export function jobStatus(status) {
  const [label, cls] = JOB_STATUS[status] || [status, ''];
  return h('span', { class: `badge ${cls}` }, h('span', { class: 'dot' }), label);
}
export const isActiveJob = (s) => ['QUEUED', 'PROCESSING', 'TRANSCRIBING', 'SEGMENTING', 'CHAPTERING', 'ANALYZING', 'INDEXING'].includes(s);

export function button(label, opts = {}) {
  const { icon: ico, variant = '', size = '', onClick, title, disabled, type = 'button' } = opts;
  const b = h('button', { class: `btn ${variant} ${size}`.trim(), type, title, disabled, onclick: onClick });
  if (ico) b.appendChild(ic(ico));
  if (label) b.appendChild(document.createTextNode(label));
  return b;
}

export function iconButton(ico, title, onClick, extra = '') {
  return h('button', { class: `btn-icon btn ${extra}`.trim(), type: 'button', title, 'aria-label': title, onclick: onClick }, ic(ico));
}

export function listenButton(time, onClick, label = 'Écouter') {
  return h('button', { class: 'listen', type: 'button', title: `${label} à ${fmtTime(time)}`, onclick: (e) => { e.stopPropagation(); onClick(time); } },
    ic('playSm'), fmtTime(time));
}

export function empty({ icon: ico = 'wave', title, text, action, small = false }) {
  return h('div', { class: `empty ${small ? 'empty-sm' : ''}` },
    h('div', { class: 'empty-art' }, ic(ico)),
    h('h3', { text: title }),
    text ? h('p', { text }) : null,
    action || null);
}

export function errorBox(err, { title, retry } = {}) {
  const detail = err && (err.detail || (err.status ? `Code ${err.status}` : null));
  return h('div', { class: 'alert alert-danger', role: 'alert' }, ic('alert'),
    h('div', { class: 'grow' },
      h('div', { class: 'alert-title', text: title || "Quelque chose n'a pas fonctionné." }),
      h('div', { text: (err && err.message) || String(err) }),
      detail ? h('details', { class: 'tech' }, h('summary', { text: 'Voir les détails' }), h('pre', { text: String(detail) })) : null,
      retry ? h('div', { class: 'mt-2' }, button('Réessayer', { size: 'btn-sm', icon: 'refresh', onClick: retry })) : null));
}

export function alertBox(kind, title, text, extra) {
  const icons = { info: 'info', warning: 'alert', danger: 'alert', success: 'check', neutral: 'info' };
  return h('div', { class: `alert alert-${kind}` }, ic(icons[kind] || 'info'),
    h('div', { class: 'grow' }, title ? h('div', { class: 'alert-title', text: title }) : null, text ? h('div', { text }) : null, extra || null));
}

export function skeleton(kind = 'lines', n = 4) {
  const box = h('div', { 'aria-busy': 'true', 'aria-label': 'Chargement' });
  if (kind === 'page') {
    box.append(h('div', { class: 'skeleton sk-title' }), h('div', { class: 'skeleton sk-line', style: { width: '60%' } }));
    const g = h('div', { class: 'grid grid-3 mt-6' });
    for (let i = 0; i < 3; i++) g.appendChild(h('div', { class: 'skeleton sk-block' }));
    box.appendChild(g);
    for (let i = 0; i < 5; i++) box.appendChild(h('div', { class: 'skeleton sk-line', style: { width: `${90 - i * 9}%` } }));
    return box;
  }
  if (kind === 'wave') return h('div', { class: 'skeleton sk-wave' });
  if (kind === 'rows') {
    for (let i = 0; i < n; i++) {
      box.appendChild(h('div', { class: 'row', style: { padding: '14px 0', borderBottom: '1px solid var(--color-border)' } },
        h('div', { class: 'skeleton', style: { width: '38px', height: '38px', borderRadius: '8px' } }),
        h('div', { class: 'grow' }, h('div', { class: 'skeleton sk-line', style: { width: `${70 - i * 6}%`, margin: '4px 0' } }),
          h('div', { class: 'skeleton sk-line', style: { width: '30%', margin: '8px 0 0', height: '9px' } }))));
    }
    return box;
  }
  for (let i = 0; i < n; i++) box.appendChild(h('div', { class: 'skeleton sk-line', style: { width: `${95 - (i % 4) * 12}%` } }));
  return box;
}

// ------------------------------------------------------------------ toasts
export function toast(message, type = 'info', action) {
  let root = document.querySelector('.toasts');
  if (!root) { root = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(root); }
  const icons = { success: 'check', error: 'alert', info: 'info' };
  const t = h('div', { class: `toast ${type}` }, ic(icons[type] || 'info'), h('div', { class: 'grow', text: message }),
    action ? h('button', { class: 'toast-action', text: action.label, onclick: () => { action.onClick(); t.remove(); } }) : null);
  root.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 8000 : 4200);
}

export function toastError(err, fallback) {
  toast((err && err.message) || fallback || 'Une erreur est survenue.', 'error');
}

// ------------------------------------------------------------------ fenêtres modales
export function modal({ title, kicker, body, actions = [], wide = false, onClose }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); prevFocus && prevFocus.focus && prevFocus.focus(); onClose && onClose(value); resolve(value); };
    const foot = actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
      button(a.label, { variant: a.variant || '', icon: a.icon, onClick: async () => {
        if (a.onClick) { const r = await a.onClick(); if (r === false) return; close(r === undefined ? a.value : r); } else close(a.value);
      } }))) : null;
    const dialog = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('div', {}, kicker ? h('div', { class: 'kicker', text: kicker }) : null, h('h3', { text: title })),
        iconButton('close', 'Fermer', () => close(undefined))),
      h('div', { class: 'modal-body' }, body), foot);
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(undefined); } }, dialog);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(undefined); } };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    const first = dialog.querySelector('input, textarea, select') || dialog.querySelector('.modal-foot .btn-primary');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export function confirmDialog(title, text, { confirmLabel = 'Confirmer', danger = false } = {}) {
  return modal({
    title, body: h('p', { class: 'muted', text }),
    actions: [{ label: 'Annuler', value: false, variant: 'btn-ghost' },
      { label: confirmLabel, value: true, variant: danger ? 'btn-dark' : 'btn-primary' }],
  }).then((v) => v === true);
}

export function formDialog(title, fields, { submitLabel = 'Enregistrer', kicker } = {}) {
  const inputs = {};
  const form = h('form', { class: 'col gap-4', onsubmit: (e) => e.preventDefault() },
    fields.map((f) => {
      let input;
      if (f.type === 'textarea') input = h('textarea', { class: 'textarea', rows: f.rows || 4, placeholder: f.placeholder || '' });
      else if (f.type === 'select') input = h('select', { class: 'select' }, f.options.map((o) => h('option', { value: o.value, text: o.label })));
      else input = h('input', { class: 'input', type: f.type || 'text', placeholder: f.placeholder || '', step: f.step });
      input.value = f.value ?? '';
      inputs[f.name] = input;
      return h('div', { class: 'field' }, h('label', { text: f.label }), input, f.hint ? h('div', { class: 'field-hint', text: f.hint }) : null);
    }));
  return modal({
    title, kicker, body: form,
    actions: [{ label: 'Annuler', value: null, variant: 'btn-ghost' },
      { label: submitLabel, variant: 'btn-primary', onClick: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) }],
  });
}

// ------------------------------------------------------------------ menus contextuels
let openMenu = null;
export function popMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' }, items.map((it) => {
    if (it === '-') return h('div', { class: 'menu-sep' });
    if (it.title) return h('div', { class: 'menu-title', text: it.title });
    const b = h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', type: 'button', onclick: () => { closeMenu(); it.onClick(); } });
    if (it.icon) b.appendChild(ic(it.icon));
    b.appendChild(h('span', { text: it.label }));
    if (it.hint) b.appendChild(h('span', { class: 'hint', text: it.hint }));
    return b;
  }));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  openMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  const first = menu.querySelector('.menu-item');
  if (first) first.focus();
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('.menu-item')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === 'Escape') closeMenu();
  });
  return menu;
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('mousedown', outside, true);
}

// ------------------------------------------------------------------ infobulle
let tipEl = null;
export function showTip(x, y, content) {
  if (!tipEl) { tipEl = h('div', { class: 'tooltip', role: 'tooltip' }); document.body.appendChild(tipEl); }
  mount(tipEl, content);
  tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
  tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`;
  tipEl.style.top = `${y - hh - 12 < 8 ? y + 18 : y - hh - 12}px`;
}
export function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

// ------------------------------------------------------------------ Markdown minimal et sûr (DOM, jamais innerHTML)
export function inlineMd(text, onCite) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[S\d+\]|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) frag.appendChild(h('strong', { text: tok.slice(2, -2) }));
    else if (tok.startsWith('[S')) frag.appendChild(onCite ? onCite(tok.slice(1, -1)) : document.createTextNode(tok));
    else if (tok.startsWith('`')) frag.appendChild(h('code', { class: 'code', text: tok.slice(1, -1) }));
    else frag.appendChild(h('em', { text: tok.slice(1, -1) }));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

export function renderMarkdown(md, onCite) {
  const root = h('div', { class: 'prose' });
  let list = null;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (!list) { list = h(/^\s*\d/.test(line) ? 'ol' : 'ul'); root.appendChild(list); }
      list.appendChild(h('li', {}, inlineMd(bullet[1], onCite)));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const head = line.match(/^(#{1,4})\s+(.*)$/);
    if (head) root.appendChild(h('h3', {}, inlineMd(head[2], onCite)));
    else root.appendChild(h('p', {}, inlineMd(line, onCite)));
  }
  return root;
}

// ------------------------------------------------------------------ divers
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function downloadName(title, ext) {
  return `${(title || 'export').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase()}.${ext}`;
}

export function kicker(text) { return h('div', { class: 'kicker', text }); }

export function pageHead({ kicker: k, title, accent, lede, actions }) {
  const t = h('h1');
  t.appendChild(document.createTextNode(title));
  if (accent) { t.appendChild(document.createTextNode(' ')); t.appendChild(h('span', { class: 'accent', text: accent })); }
  return h('div', { class: 'page-head' },
    h('div', {}, k ? kicker(k) : null, t, lede ? h('p', { class: 'lede', text: lede }) : null),
    actions ? h('div', { class: 'btn-group' }, actions) : null);
}
