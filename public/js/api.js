// Tiny fetch wrapper + formatting helpers. No framework, no telemetry, no nonsense.
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, options = {}) {
  const { method = 'GET', body, signal, headers = {}, raw = false } = options;
  const init = { method, credentials: 'same-origin', signal, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'Cannot reach the server. Is the slop still running?');
  }
  if (res.status === 401) onUnauthorized();
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const err = payload && typeof payload === 'object' ? payload.error : null;
    throw new ApiError(res.status, err?.code || 'error', err?.message || `Request failed (${res.status}).`, err?.details);
  }
  return payload;
}

export const get = (path, options) => api(path, options);
export const post = (path, body, options) => api(path, { ...options, method: 'POST', body });
export const patch = (path, body, options) => api(path, { ...options, method: 'PATCH', body });
export const del = (path, options) => api(path, { ...options, method: 'DELETE' });

export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

export function fmtDuration(seconds, opts = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0) return opts.empty || '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (opts.clock) return `${m}:${String(s).padStart(2, '0')}`;
  if (m === 0) return `${s}s`;
  return `${m}m${s > 0 && opts.exact ? ` ${s}s` : ''}`;
}

export function fmtClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

const MEME_COPY = [
  'Certified slop.', 'Based and library-pilled.', 'No notes.', 'Absolute cinema.',
  'It insists upon itself.', 'Touch grass? Not today.', 'Ratioed by the algorithm.',
  'This is the content.', 'Stremio who?', 'Plex is shaking.',
];

export function memeLine(seed = Math.random()) {
  return MEME_COPY[Math.floor(seed * MEME_COPY.length) % MEME_COPY.length];
}

const PALETTES = [
  ['#c8ff3d', '#0b2b1a', '#ff4d9d'],
  ['#ff4d9d', '#2b0b20', '#7b5cff'],
  ['#37d5ff', '#071826', '#c8ff3d'],
  ['#ffcc5c', '#2b1e07', '#ff6b6b'],
  ['#5ce1a4', '#07261c', '#7b5cff'],
  ['#7b5cff', '#140b2b', '#37d5ff'],
];

const MEME_TITLES = ['PEAK', 'BASED', 'SLOP', 'GAS', 'L + RATIO', 'NO THOUGHTS', 'HEAD EMPTY', 'CERTIFIED', 'BANGER', 'GOATED'];
const MEME_FACES = ['◉‿◉', 'ಠ_ಠ', '(⌐■_■)', '( ͡° ͜ʖ ͡°)', 'ᕕ( ᐛ )ᕗ', '｡･ﾟ･(ﾉД`)･ﾟ･｡', '🐸', '💀'];

/** Deterministic local placeholder art — zero external requests, meme energy included. */
export function placeholderArt(seedText, kind = 'poster', title = '') {
  let hash = 2166136261;
  for (const ch of String(seedText)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const palette = PALETTES[Math.abs(hash) % PALETTES.length];
  const face = MEME_FACES[Math.abs(hash >> 3) % MEME_FACES.length];
  const meme = MEME_TITLES[Math.abs(hash >> 5) % MEME_TITLES.length];
  const label = String(title || meme).slice(0, 26).replace(/[<>&"]/g, '');
  const w = kind === 'backdrop' || kind === 'banner' || kind === 'thumb' ? 640 : 400;
  const h = kind === 'backdrop' || kind === 'thumb' ? 360 : kind === 'banner' ? 160 : 600;
  const big = kind === 'poster' ? 60 : 46;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${palette[1]}"/><stop offset="1" stop-color="${palette[2]}" stop-opacity=".55"/>
      </linearGradient>
      <radialGradient id="r" cx=".8" cy=".15" r=".9">
        <stop offset="0" stop-color="${palette[0]}" stop-opacity=".5"/><stop offset="1" stop-color="${palette[0]}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#r)"/>
    <g fill="none" stroke="${palette[0]}" stroke-opacity=".22" stroke-width="2">
      ${Array.from({ length: 9 }, (_, i) => `<circle cx="${w * 0.72}" cy="${h * 0.32}" r="${30 + i * 22}"/>`).join('')}
    </g>
    <text x="${w / 2}" y="${h / 2 - 10}" text-anchor="middle" font-size="${big}" font-family="system-ui,sans-serif" fill="${palette[0]}" opacity=".92">${face}</text>
    <text x="${w / 2}" y="${h / 2 + big}" text-anchor="middle" font-size="${kind === 'poster' ? 34 : 26}" font-weight="900" letter-spacing="4" font-family="system-ui,sans-serif" fill="#fff" opacity=".85">${meme}</text>
    <text x="${w / 2}" y="${h - 28}" text-anchor="middle" font-size="${kind === 'poster' ? 15 : 13}" font-family="ui-monospace,monospace" fill="#fff" opacity=".55">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function artFor(item, kind = 'poster') {
  return item?.art?.[kind] || (kind === 'poster' || kind === 'backdrop' || kind === 'thumb'
    ? placeholderArt(`${item?.kind || 'media'}:${item?.id || item?.title}`, kind, item?.title)
    : placeholderArt(`${item?.kind || 'media'}:${item?.id}:${kind}`, kind, item?.title));
}

export function connectEvents(handlers) {
  const source = new EventSource('/api/events');
  for (const [name, handler] of Object.entries(handlers)) {
    source.addEventListener(name, (event) => {
      let data = {};
      try { data = JSON.parse(event.data); } catch { data = { raw: event.data }; }
      handler(data);
    });
  }
  source.onerror = () => { /* browser auto-reconnects; nothing to do */ };
  return source;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
