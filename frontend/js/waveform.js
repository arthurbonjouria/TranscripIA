// Waveform interactive + timeline sémantique (chapitres, highlights, décisions, actions, bookmarks, annotations, clips).
import { h, ic, iconButton, fmtTime, showTip, hideTip } from './ui.js';

const LAYERS = [
  { key: 'chapters', label: 'Chapitres', color: '--color-secondary' },
  { key: 'highlights', label: 'Highlights', color: '--color-primary' },
  { key: 'decisions', label: 'Décisions', color: '--cat-decision' },
  { key: 'actions', label: 'Actions', color: '--cat-action' },
  { key: 'questions', label: 'Questions', color: '--cat-question' },
  { key: 'risks', label: 'Risques', color: '--cat-risk' },
  { key: 'bookmarks', label: 'Bookmarks', color: '--cat-bookmark' },
  { key: 'annotations', label: 'Annotations', color: '--cat-annotation' },
  { key: 'clips', label: 'Clips', color: '--cat-clip' },
];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#999';

export class Waveform extends EventTarget {
  constructor(player, { duration }) {
    super();
    this.player = player;
    this.duration = duration || 1;
    this.peaks = null;
    this.data = {};
    this.view = [0, this.duration];
    this.selection = null;
    this.hidden = new Set(JSON.parse(safeGet('bj.layers.hidden') || '[]'));
    this.markers = [];
    this.hoverX = null;

    this.canvas = h('canvas', { class: 'wave-canvas', tabindex: '0', 'aria-label': "Forme d'onde : cliquez pour naviguer, glissez pour sélectionner une plage" });
    this.mini = h('canvas', { class: 'wave-mini', 'aria-hidden': 'true' });
    this.selBar = h('div', { class: 'selection-bar hidden' });
    const zoomIn = iconButton('zoomIn', 'Zoomer (Ctrl + molette)', () => this.zoom(0.5));
    const zoomOut = iconButton('zoomOut', 'Dézoomer', () => this.zoom(2));
    const fit = iconButton('maximize', "Voir tout l'audio", () => this.setView(0, this.duration));
    this.legend = h('div', { class: 'wave-legend' }, LAYERS.map((l) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !this.hidden.has(l.key);
      cb.onchange = () => { cb.checked ? this.hidden.delete(l.key) : this.hidden.add(l.key); safeSet('bj.layers.hidden', JSON.stringify([...this.hidden])); this.draw(); };
      return h('label', {}, cb, h('span', { class: 'sw', style: { background: `var(${l.color})` } }), l.label);
    }));
    this.el = h('div', { class: 'wave-wrap' }, h('div', { class: 'wave-toolbar' }, zoomIn, zoomOut, fit), this.canvas, this.mini, this.selBar, this.legend);

    this._bind();
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(this.canvas);
    this._onTime = () => this._follow();
    player.addEventListener('time', this._onTime);
  }

  setPeaks(peaks) { this.peaks = peaks; this.draw(); }
  setData(data) { this.data = data || {}; this.draw(); }
  setDuration(d) { if (d && Math.abs(d - this.duration) > 0.5) { this.duration = d; this.view = [0, d]; this.draw(); } }

  setView(a, b) {
    const span = Math.max(5, Math.min(this.duration, b - a));
    let start = Math.max(0, Math.min(this.duration - span, a));
    this.view = [start, start + span];
    this.draw();
  }
  zoom(factor, center) {
    const [a, b] = this.view;
    const c = center ?? (this.player.time >= a && this.player.time <= b ? this.player.time : (a + b) / 2);
    const span = (b - a) * factor;
    this.setView(c - (c - a) * factor, c - (c - a) * factor + span);
  }
  _follow() {
    const t = this.player.time;
    const [a, b] = this.view;
    const span = b - a;
    if (span < this.duration - 1 && (t > b || t < a) && !this._dragging) this.setView(t - span * 0.1, t + span * 0.9);
    else this.draw();
  }

  t2x(t, w) { const [a, b] = this.view; return ((t - a) / (b - a)) * w; }
  x2t(x, w) { const [a, b] = this.view; return a + (x / w) * (b - a); }

  // ---------------------------------------------------------------- dessin
  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hgt = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    this.markers = [];
    const laneTop = 20, waveTop = 24, waveH = hgt - waveTop - 26, markerY = hgt - 11;
    const mid = waveTop + waveH / 2;
    const [va, vb] = this.view;
    const now = this.player.time;
    const colPlayed = css('--color-primary'), colRest = css('--color-border-strong');
    const show = (k) => !this.hidden.has(k);

    // Chapitres : bandes alternées + titres
    const chapters = this.data.chapters || [];
    if (show('chapters')) {
      g.font = `600 10.5px ${css('--font-sans')}`;
      g.textBaseline = 'middle';
      chapters.forEach((ch, i) => {
        const x1 = Math.max(0, this.t2x(ch.start, w)), x2 = Math.min(w, this.t2x(ch.end, w));
        if (x2 < 0 || x1 > w) return;
        g.fillStyle = i % 2 ? css('--color-surface-sunken') : css('--color-surface-alt');
        g.fillRect(x1, waveTop - 4, x2 - x1, waveH + 8);
        g.fillStyle = css('--color-secondary');
        g.fillRect(x1, 2, 1.5, laneTop - 2);
        const label = `${ch.title}`;
        g.save();
        g.beginPath(); g.rect(x1 + 5, 0, Math.max(0, x2 - x1 - 8), laneTop); g.clip();
        g.fillStyle = css('--color-text');
        g.fillText(label, x1 + 6, laneTop / 2 + 1);
        g.restore();
        this.markers.push({ x1, x2, y1: 0, y2: laneTop, kind: 'chapter', item: ch, time: ch.start, label: ch.title });
      });
    }

    // Clips (plages) et highlights manuels (plages)
    const ranges = [];
    if (show('clips')) (this.data.clips || []).forEach((cl) => ranges.push({ ...cl, color: css('--cat-clip'), kind: 'clip', label: cl.title }));
    if (show('highlights')) (this.data.highlights || []).filter((x) => x.source === 'user').forEach((x) => ranges.push({ start: x.start, end: Math.max(x.end, x.start + 1), color: css('--color-primary'), kind: 'highlight', item: x, label: x.text }));
    ranges.forEach((r) => {
      const x1 = this.t2x(r.start, w), x2 = this.t2x(r.end, w);
      if (x2 < 0 || x1 > w) return;
      g.globalAlpha = 0.12; g.fillStyle = r.color; g.fillRect(x1, waveTop, Math.max(2, x2 - x1), waveH);
      g.globalAlpha = 1; g.fillRect(x1, waveTop + waveH - 2, Math.max(2, x2 - x1), 2);
      this.markers.push({ x1, x2: Math.max(x1 + 2, x2), y1: waveTop, y2: waveTop + waveH, kind: r.kind, item: r.item || r, time: r.start, label: r.label, weak: true });
    });

    // Forme d'onde
    if (this.peaks && this.peaks.length) {
      const peaks = this.peaks, n = peaks.length, perSec = n / this.duration;
      const bar = 2, gap = 1, step = bar + gap;
      for (let x = 0; x < w; x += step) {
        const t0 = this.x2t(x, w), t1 = this.x2t(x + step, w);
        const i0 = Math.max(0, Math.floor(t0 * perSec)), i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(t1 * perSec)));
        let m = 0;
        for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
        const amp = Math.max(1, Math.pow(m, 0.8) * (waveH / 2 - 2));
        g.fillStyle = t0 <= now ? colPlayed : colRest;
        g.fillRect(x, mid - amp, bar, amp * 2);
      }
    } else {
      g.fillStyle = colRest;
      g.fillRect(0, mid - 0.5, w, 1);
    }

    // Sélection
    if (this.selection) {
      const [s, e] = this.selection;
      const x1 = this.t2x(Math.min(s, e), w), x2 = this.t2x(Math.max(s, e), w);
      g.fillStyle = css('--color-primary'); g.globalAlpha = 0.14; g.fillRect(x1, waveTop - 4, x2 - x1, waveH + 8); g.globalAlpha = 1;
      g.fillRect(x1, waveTop - 4, 1.5, waveH + 8); g.fillRect(x2 - 1.5, waveTop - 4, 1.5, waveH + 8);
    }

    // Marqueurs ponctuels
    const points = [];
    const addPts = (key, list, colorVar, shape, labelFn) => {
      if (!show(key)) return;
      (list || []).forEach((it) => points.push({ key, it, t: it.time ?? it.start, color: css(colorVar), shape, label: labelFn(it) }));
    };
    addPts('highlights', (this.data.highlights || []).filter((x) => x.source !== 'user'), '--color-primary', 'dot', (x) => x.text);
    addPts('decisions', this.data.decisions, '--cat-decision', 'dot', (x) => `Décision · ${x.text}`);
    addPts('actions', this.data.actions, '--cat-action', 'square', (x) => `Action · ${x.text}`);
    addPts('questions', this.data.questions, '--cat-question', 'dot', (x) => `Question · ${x.text}`);
    addPts('risks', this.data.risks, '--cat-risk', 'triangle', (x) => `Risque · ${x.text}`);
    addPts('bookmarks', this.data.bookmarks, '--cat-bookmark', 'star', (x) => `Bookmark · ${x.label}`);
    addPts('annotations', this.data.annotations, '--cat-annotation', 'diamond', (x) => `Annotation · ${x.text}`);
    g.fillStyle = css('--color-border'); g.fillRect(0, markerY, w, 1);
    for (const p of points) {
      const x = this.t2x(p.t, w);
      if (x < -6 || x > w + 6) continue;
      g.fillStyle = p.color;
      drawShape(g, p.shape, x, markerY, p.key === 'highlights' ? 3 + 2.5 * (p.it.importance || 0.5) : 4.5);
      if (p.key === 'bookmarks' || p.key === 'annotations') { g.globalAlpha = 0.45; g.fillRect(x - 0.5, waveTop, 1, waveH); g.globalAlpha = 1; }
      this.markers.push({ x1: x - 6, x2: x + 6, y1: markerY - 8, y2: markerY + 8, kind: p.key, item: p.it, time: p.t, label: p.label });
    }

    // Survol + tête de lecture
    if (this.hoverX !== null) { g.fillStyle = css('--color-text-subtle'); g.globalAlpha = 0.6; g.fillRect(this.hoverX, waveTop - 4, 1, waveH + 8); g.globalAlpha = 1; }
    const px = this.t2x(now, w);
    if (px >= 0 && px <= w) {
      g.fillStyle = css('--color-text');
      g.fillRect(px - 0.75, laneTop, 1.5, hgt - laneTop - 14);
      g.beginPath(); g.arc(px, laneTop, 3.5, 0, Math.PI * 2); g.fill();
    }
    this._drawMini();
  }

  _drawMini() {
    const c = this.mini, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hgt = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css('--color-surface-sunken'); g.fillRect(0, 0, w, hgt);
    const d = this.duration;
    if (this.peaks) {
      const n = this.peaks.length;
      g.fillStyle = css('--color-accent');
      for (let x = 0; x < w; x += 2) {
        const i0 = Math.floor((x / w) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 2) / w) * n));
        let m = 0; for (let i = i0; i < i1 && i < n; i++) if (this.peaks[i] > m) m = this.peaks[i];
        const a = Math.max(0.5, m * (hgt / 2 - 1));
        g.fillRect(x, hgt / 2 - a, 1, a * 2);
      }
    }
    (this.data.chapters || []).forEach((ch) => { g.fillStyle = css('--color-secondary'); g.fillRect((ch.start / d) * w, 0, 1, hgt); });
    const [a, b] = this.view;
    if (b - a < d - 0.5) {
      g.fillStyle = css('--color-primary'); g.globalAlpha = 0.18; g.fillRect((a / d) * w, 0, ((b - a) / d) * w, hgt); g.globalAlpha = 1;
      g.strokeStyle = css('--color-primary'); g.lineWidth = 1; g.strokeRect((a / d) * w + 0.5, 0.5, ((b - a) / d) * w - 1, hgt - 1);
    }
    g.fillStyle = css('--color-text'); g.fillRect((this.player.time / d) * w - 0.5, 0, 1.5, hgt);
  }

  // ---------------------------------------------------------------- interactions
  _hit(x, y) {
    let best = null;
    for (const m of this.markers) {
      if (x >= m.x1 && x <= m.x2 && y >= m.y1 && y <= m.y2) {
        if (!best || (best.weak && !m.weak)) best = m;
      }
    }
    return best;
  }

  _bind() {
    const c = this.canvas;
    let down = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width }; };
    c.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      down = { ...p, t: this.x2t(p.x, p.w), moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (down) {
        if (Math.abs(p.x - down.x) > 4) down.moved = true;
        if (down.moved) {
          this._dragging = true;
          this.selection = [down.t, Math.max(0, Math.min(this.duration, this.x2t(p.x, p.w)))];
          this._renderSelBar();
          this.draw();
        }
        return;
      }
      this.hoverX = p.x;
      const m = this._hit(p.x, p.y);
      const r = c.getBoundingClientRect();
      if (m) showTip(e.clientX, r.top + m.y1, h('span', {}, h('span', { class: 'tt-time', text: fmtTime(m.time) }), truncate(m.label, 140)));
      else showTip(e.clientX, r.top + 20, h('span', { class: 'tt-time', text: fmtTime(this.x2t(p.x, p.w)) }));
      c.style.cursor = m ? 'pointer' : 'crosshair';
      this.draw();
    });
    c.addEventListener('pointerleave', () => { this.hoverX = null; hideTip(); this.draw(); });
    c.addEventListener('pointerup', (e) => {
      if (!down) return;
      const p = pos(e);
      if (!down.moved) {
        const m = this._hit(p.x, p.y);
        if (m) {
          this.player.seek(m.time);
          this.dispatchEvent(new CustomEvent('marker', { detail: m }));
        } else {
          this.player.seek(this.x2t(p.x, p.w));
        }
        if (this.selection) { this.selection = null; this._renderSelBar(); }
      } else if (this.selection && Math.abs(this.selection[1] - this.selection[0]) < 0.5) {
        this.selection = null; this._renderSelBar();
      }
      down = null;
      this._dragging = false;
      this.draw();
    });
    c.addEventListener('wheel', (e) => {
      const p = pos(e);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 1.25 : 0.8, this.x2t(p.x, p.w));
      } else if (this.view[1] - this.view[0] < this.duration - 0.5 && (Math.abs(e.deltaX) > 0 || e.shiftKey)) {
        e.preventDefault();
        const span = this.view[1] - this.view[0];
        const delta = ((e.deltaX || e.deltaY) / p.w) * span;
        this.setView(this.view[0] + delta, this.view[1] + delta);
      }
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') { this.zoom(0.5); e.preventDefault(); }
      if (e.key === '-') { this.zoom(2); e.preventDefault(); }
    });
    // Mini-carte : clic / glisser pour déplacer la vue
    let mdown = false;
    const moveTo = (e) => {
      const r = this.mini.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * this.duration;
      const span = this.view[1] - this.view[0];
      if (span >= this.duration - 0.5) this.player.seek(t);
      else this.setView(t - span / 2, t + span / 2);
    };
    this.mini.addEventListener('pointerdown', (e) => { mdown = true; this.mini.setPointerCapture(e.pointerId); moveTo(e); });
    this.mini.addEventListener('pointermove', (e) => { if (mdown) moveTo(e); });
    this.mini.addEventListener('pointerup', () => { mdown = false; });
  }

  _renderSelBar() {
    const bar = this.selBar;
    if (!this.selection) { bar.classList.add('hidden'); bar.replaceChildren(); this.dispatchEvent(new CustomEvent('selection', { detail: null })); return; }
    const [a, b] = [Math.min(...this.selection), Math.max(...this.selection)];
    bar.classList.remove('hidden');
    const act = (label, icon, kind) => {
      const btn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, ic(icon), label);
      btn.onclick = () => this.dispatchEvent(new CustomEvent('selection-action', { detail: { kind, start: a, end: b } }));
      return btn;
    };
    bar.replaceChildren(
      h('span', {}, 'Sélection ', h('span', { class: 'tc', text: `${fmtTime(a)} → ${fmtTime(b)}` }), h('span', { class: 'muted', text: ` · ${fmtTime(b - a)}` })),
      act('Écouter', 'playSm', 'play'), act('Créer un clip', 'scissors', 'clip'), act('Annoter', 'note', 'annotation'),
      act('Surligner', 'highlighter', 'highlight'), act('Zoomer', 'zoomIn', 'zoom'),
      h('button', { class: 'btn btn-sm btn-icon', type: 'button', title: 'Effacer la sélection', onclick: () => { this.selection = null; this._renderSelBar(); this.draw(); } }, ic('close')));
    this.dispatchEvent(new CustomEvent('selection', { detail: { start: a, end: b } }));
  }

  clearSelection() { this.selection = null; this._renderSelBar(); this.draw(); }

  destroy() {
    this._ro.disconnect();
    this.player.removeEventListener('time', this._onTime);
    hideTip();
  }
}

function drawShape(g, shape, x, y, r) {
  g.beginPath();
  if (shape === 'square') g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
  else if (shape === 'triangle') { g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.8); g.lineTo(x - r, y + r * 0.8); g.closePath(); }
  else if (shape === 'diamond') { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
  else if (shape === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI / 5) * i - Math.PI / 2, rr = i % 2 ? r * 0.45 : r * 1.15;
      i ? g.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)) : g.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
    g.closePath();
  } else g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function truncate(s, n) { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } }

/** Petite waveform statique pour les cartes (à partir des pics). */
export function miniWave(canvas, peaks) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240, hgt = canvas.clientHeight || 38;
  canvas.width = w * dpr; canvas.height = hgt * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = css('--color-border-strong');
  if (!peaks || !peaks.length) { g.fillRect(0, hgt / 2, w, 1); return; }
  const n = peaks.length;
  for (let x = 0; x < w; x += 3) {
    const i0 = Math.floor((x / w) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 3) / w) * n));
    let m = 0; for (let i = i0; i < i1 && i < n; i++) if (peaks[i] > m) m = peaks[i];
    const a = Math.max(0.5, Math.pow(m, 0.8) * (hgt / 2 - 1));
    g.fillRect(x, hgt / 2 - a, 2, a * 2);
  }
}
