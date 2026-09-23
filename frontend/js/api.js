// Client de l'API locale. Toutes les requêtes restent sur 127.0.0.1.

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const HEADERS = { 'X-Requested-With': 'BonjourIA' };

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg = (body && body.error) || (res.status === 404 ? "L'élément demandé est introuvable." : 'Une erreur est survenue.');
    throw new ApiError(msg, { status: res.status, detail: body && body.detail });
  }
  return body;
}

async function request(method, url, data, opts = {}) {
  const init = { method, headers: { ...HEADERS }, signal: opts.signal };
  if (data !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(data);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError("Le serveur local ne répond pas. Vérifiez que l'application est lancée (START.bat).", { status: 0 });
  }
  return parse(res);
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, data = {}, opts) => request('POST', url, data, opts),
  put: (url, data = {}) => request('PUT', url, data),
  patch: (url, data = {}) => request('PATCH', url, data),
  del: (url) => request('DELETE', url),

  qs(params) {
    const u = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') u.set(k, v);
    });
    const s = u.toString();
    return s ? `?${s}` : '';
  },

  /** Upload avec progression réelle (XHR). */
  upload(file, fields = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('file', file);
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      xhr.open('POST', '/api/audio/upload');
      xhr.setRequestHeader('X-Requested-With', 'BonjourIA');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* réponse non JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError((body && body.error) || "L'import a échoué.", { status: xhr.status, detail: body && body.detail }));
      };
      xhr.onerror = () => reject(new ApiError('Connexion au serveur local interrompue.'));
      xhr.send(fd);
      fields._xhr = xhr;
    });
  },

  /** Flux NDJSON (chat, téléchargement de modèles). */
  async stream(url, data, onEvent, signal) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw new ApiError('Le serveur local ne répond pas.');
    }
    if (!res.ok) return parse(res);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) onEvent(JSON.parse(buf));
  },

  download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
