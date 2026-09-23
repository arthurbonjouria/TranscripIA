// Lecteur audio professionnel : transport, vitesses, volume, raccourcis clavier.
import { h, ic, iconButton, fmtTime } from './ui.js';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export class Player extends EventTarget {
  constructor(src) {
    super();
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.src = src;
    this.chapters = [];
    this.duration = 0;
    this._raf = null;
    try {
      this.audio.volume = Number(localStorage.getItem('bj.volume') ?? 1);
      this.audio.playbackRate = Number(localStorage.getItem('bj.speed') ?? 1);
    } catch { /* stockage indisponible */ }
    this.audio.addEventListener('loadedmetadata', () => { this.duration = this.audio.duration; this.emit('ready'); });
    this.audio.addEventListener('play', () => { this.emit('state'); this._loop(); });
    this.audio.addEventListener('pause', () => { this.emit('state'); cancelAnimationFrame(this._raf); this.emit('time'); });
    this.audio.addEventListener('ended', () => this.emit('state'));
    this.audio.addEventListener('ratechange', () => this.emit('rate'));
    this.audio.addEventListener('volumechange', () => this.emit('volume'));
    this.audio.addEventListener('seeked', () => this.emit('time'));
    this.audio.addEventListener('error', () => this.emit('error'));
  }

  emit(name) { this.dispatchEvent(new Event(name)); }
  _loop() {
    this.emit('time');
    if (!this.audio.paused) this._raf = requestAnimationFrame(() => this._loop());
  }

  get time() { return this.audio.currentTime || 0; }
  get playing() { return !this.audio.paused; }
  play() { return this.audio.play().catch(() => {}); }
  pause() { this.audio.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t, autoplay = false) {
    const d = this.duration || this.audio.duration || 0;
    this.audio.currentTime = Math.max(0, Math.min(d || t, t));
    this.emit('time');
    if (autoplay) this.play();
  }
  skip(delta) { this.seek(this.time + delta); }
  setRate(r) { this.audio.playbackRate = r; try { localStorage.setItem('bj.speed', r); } catch { /* */ } }
  setVolume(v) { this.audio.volume = Math.max(0, Math.min(1, v)); this.audio.muted = false; try { localStorage.setItem('bj.volume', this.audio.volume); } catch { /* */ } }
  toggleMute() { this.audio.muted = !this.audio.muted; }
  currentChapter() {
    const t = this.time;
    let cur = null;
    for (const c of this.chapters) if (c.start <= t + 0.01) cur = c;
    return cur;
  }
  nextChapter() {
    const c = this.chapters.find((x) => x.start > this.time + 0.5);
    if (c) this.seek(c.start);
  }
  prevChapter() {
    const t = this.time;
    const prev = [...this.chapters].reverse().find((x) => x.start < t - 2);
    this.seek(prev ? prev.start : 0);
  }
  destroy() {
    cancelAnimationFrame(this._raf);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}

/** Barre de contrôle. */
export function controlsBar(player) {
  const playBtn = h('button', { class: 'play-btn', type: 'button', title: 'Lecture / pause (Espace)', 'aria-label': 'Lecture' });
  const setPlayIcon = () => { playBtn.replaceChildren(ic(player.playing ? 'pause' : 'play')); playBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture'); };
  setPlayIcon();
  playBtn.onclick = () => player.toggle();

  const skip = (sec, back) => {
    const b = h('button', { class: 'btn btn-icon skip-btn', type: 'button', title: `${back ? 'Reculer' : 'Avancer'} de ${sec} s`, 'aria-label': `${back ? 'Reculer' : 'Avancer'} de ${sec} secondes` },
      ic(back ? 'back' : 'forward'), h('small', { text: String(sec) }));
    b.onclick = () => player.skip(back ? -sec : sec);
    return b;
  };

  const cur = h('span', { class: 'cur', text: '00:00' });
  const total = h('span', { class: 'total', text: ' / --:--' });
  const now = h('div', { class: 'now-chapter truncate' });

  const speed = h('select', { class: 'select select-sm speed-select', title: 'Vitesse de lecture', 'aria-label': 'Vitesse de lecture' },
    SPEEDS.map((s) => h('option', { value: s, text: `${String(s).replace('.', ',')}×` })));
  speed.value = String(player.audio.playbackRate);
  speed.onchange = () => player.setRate(Number(speed.value));

  const volBtn = iconButton('volume', 'Couper le son (M)', () => player.toggleMute());
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, class: 'range', 'aria-label': 'Volume' });
  vol.value = player.audio.volume;
  vol.oninput = () => player.setVolume(Number(vol.value));

  player.addEventListener('state', setPlayIcon);
  player.addEventListener('rate', () => { speed.value = String(player.audio.playbackRate); });
  player.addEventListener('volume', () => { vol.value = player.audio.muted ? 0 : player.audio.volume; volBtn.replaceChildren(ic(player.audio.muted || player.audio.volume === 0 ? 'mute' : 'volume')); });
  const update = () => {
    cur.textContent = fmtTime(player.time, player.duration >= 3600);
    const c = player.currentChapter();
    if (c) now.replaceChildren(h('span', { class: 'muted', text: 'Chapitre · ' }), h('b', { text: c.title }));
    else now.replaceChildren();
  };
  player.addEventListener('time', update);
  player.addEventListener('ready', () => { total.textContent = ` / ${fmtTime(player.duration)}`; update(); });

  return h('div', { class: 'controls' },
    h('div', { class: 'transport' },
      iconButton('prev', 'Chapitre précédent (P)', () => player.prevChapter()),
      skip(30, true), skip(10, true), skip(5, true),
      playBtn,
      skip(5, false), skip(10, false), skip(30, false),
      iconButton('next', 'Chapitre suivant (N)', () => player.nextChapter())),
    h('div', { class: 'time' }, cur, total),
    now,
    speed,
    h('div', { class: 'volume' }, volBtn, vol));
}

/** Raccourcis clavier du lecteur (désactivés pendant la saisie). */
export function bindShortcuts(player, extra = {}) {
  const handler = (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const map = {
      ' ': () => player.toggle(), k: () => player.toggle(), K: () => player.toggle(),
      ArrowLeft: () => player.skip(e.shiftKey ? -30 : -5), ArrowRight: () => player.skip(e.shiftKey ? 30 : 5),
      j: () => player.skip(-10), J: () => player.skip(-10), l: () => player.skip(10), L: () => player.skip(10),
      ArrowUp: () => player.setVolume(player.audio.volume + 0.1), ArrowDown: () => player.setVolume(player.audio.volume - 0.1),
      m: () => player.toggleMute(), M: () => player.toggleMute(),
      n: () => player.nextChapter(), N: () => player.nextChapter(), p: () => player.prevChapter(), P: () => player.prevChapter(),
      '<': () => stepRate(-1), '>': () => stepRate(1), ',': () => stepRate(-1), '.': () => stepRate(1),
      Home: () => player.seek(0), End: () => player.seek(player.duration - 1),
      ...extra,
    };
    if (/^[0-9]$/.test(k)) { player.seek((player.duration * Number(k)) / 10); e.preventDefault(); return; }
    const fn = map[k];
    if (fn) { e.preventDefault(); fn(); }
  };
  const stepRate = (dir) => {
    const i = SPEEDS.indexOf(player.audio.playbackRate);
    const n = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))];
    player.setRate(n);
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

export const SHORTCUTS = [
  ['Espace / K', 'Lecture / pause'], ['← / →', '± 5 secondes'], ['Maj + ← / →', '± 30 secondes'], ['J / L', '± 10 secondes'],
  ['P / N', 'Chapitre précédent / suivant'], ['< / >', 'Vitesse − / +'], ['↑ / ↓', 'Volume'], ['M', 'Couper le son'],
  ['0 … 9', 'Aller à 0 % … 90 %'], ['B', 'Ajouter un bookmark'], ['Maj + glisser', 'Sélectionner une plage sur la waveform'],
];
