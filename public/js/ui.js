// Shared DOM/UI building blocks. Keep it small and used everywhere.
import { artFor, fmtDuration, fmtRelative, placeholderArt } from './api.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  home: '⌂', movies: '▶', shows: '📺', music: '♫', photos: '▣', collections: '◫', playlists: '☰',
  search: '⌕', requests: '✉', settings: '⚙', users: '◉', dashboard: '▤', libraries: '🗄', jobs: '⚡',
  logs: '▦', moderation: '⚑', remote: '📡', party: '🎉', play: '▶', info: 'ⓘ', favorite: '♥',
  close: '✕', add: '＋', check: '✓', trash: '🗑', edit: '✎', refresh: '↻', upload: '⇧', download: '⇩',
};
export function icon(name, cls = '') {
  const span = h('span', { class: `nav-icon ${cls}`, 'aria-hidden': 'true' }, ICONS[name] || '•');
  return span;
}

export function toast(message, type = 'info', { emoji, duration = 3800 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const faces = { success: '✅', error: '💀', fun: '🫡', info: 'ⓘ' };
  const node = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'emoji' }, emoji || faces[type] || faces.info),
    h('div', {}, message),
  );
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, duration);
}

export function cardLink(item, { width, landscape = false, showKind = false, eager = false } = {}) {
  const href = item.kind === 'artist' || item.kind === 'album' || item.kind === 'track'
    ? (item.kind === 'track' ? `/item/${item.id}` : `/item/${item.id}`)
    : `/item/${item.id}`;
  const progressPct = item.progress && item.progress.durationSeconds > 0 && !item.progress.finished
    ? Math.min(100, (item.progress.positionSeconds / item.progress.durationSeconds) * 100) : 0;
  const meta = [item.year || '', item.kind === 'episode' ? `S${item.seasonNumber}E${item.episodeNumber}` : '', item.kind === 'album' || item.kind === 'track' ? (item.artistName || '') : '']
    .filter(Boolean).join(' · ');
  const alt = item.title || 'Untitled slop';
  return h('a', {
    class: `poster-card${landscape ? ' landscape' : ''}`,
    href,
    'data-link': true,
    'data-focus': true,
    'data-media-id': item.id,
    title: `${alt}${meta ? ` (${meta})` : ''}`,
    style: width ? { width: `${width}px` } : undefined,
  },
    h('div', { class: 'poster' },
      h('img', { src: artFor(item, landscape ? 'thumb' : 'poster'), alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async' }),
      h('div', { class: 'poster-play' }, '▶'),
      h('div', { class: 'poster-badges' },
        showKind ? h('span', { class: 'pill accent' }, kindLabel(item.kind)) : null,
        item.favorite ? h('span', { class: 'pill hot' }, '♥') : null,
      ),
      progressPct > 0 ? h('div', { class: 'progress-bar' }, h('i', { style: { width: `${progressPct}%` } })) : null,
    ),
    h('div', { class: 'title clamp-2' }, alt),
    h('div', { class: 'meta truncate' }, meta || kindLabel(item.kind)),
  );
}

export function kindLabel(kind) {
  return ({ movie: 'movie', show: 'show', season: 'season', episode: 'episode', artist: 'artist', album: 'album', track: 'track', photo: 'photo', video: 'video' })[kind] || kind || 'slop';
}

export function skeletonCards(count = 8, landscape = false) {
  return Array.from({ length: count }, () => h('div', { class: `poster-card${landscape ? ' landscape' : ''}`, 'aria-hidden': 'true' },
    h('div', { class: 'skeleton poster' }),
    h('div', { class: 'skeleton', style: { height: '14px', width: '80%' } }),
    h('div', { class: 'skeleton', style: { height: '10px', width: '50%' } }),
  ));
}

export function rail(title, items, options = {}) {
  if (!items?.length && !options.allowEmpty) return null;
  const scroller = h('div', { class: 'rail', role: 'list' });
  for (const item of items) {
    scroller.append(h('div', { role: 'listitem' }, cardLink(item, options)));
  }
  const wrap = h('div', { class: 'rail-wrap' }, scroller);
  if (items?.length > 5) {
    wrap.append(
      h('button', { class: 'rail-btn left', 'aria-label': 'Scroll left', onclick: () => scroller.scrollBy({ left: -600, behavior: 'smooth' }) }, '‹'),
      h('button', { class: 'rail-btn right', 'aria-label': 'Scroll right', onclick: () => scroller.scrollBy({ left: 600, behavior: 'smooth' }) }, '›'),
    );
  }
  const head = h('div', { class: 'section-head' },
    h('h2', {}, title),
    options.count !== undefined ? h('span', { class: 'count' }, `${options.count} titles`) : null,
    options.action ? h('a', { class: 'mini-link', href: options.action.href, 'data-link': true, style: { marginLeft: 'auto' } }, options.action.label) : null,
  );
  return h('section', { class: 'section', 'data-rail': title }, head, wrap);
}

export function emptyState(title, message, emoji = '🫠', action) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'emoji' }, emoji),
    h('h3', {}, title),
    h('p', {}, message),
    action ? h('a', { class: 'btn primary', href: action.href, 'data-link': true }, action.label) : null,
  );
}

export function posterGrid(items, opts = {}) {
  const grid = h('div', { class: 'grid poster-grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } });
  for (const item of items) grid.append(cardLink(item, opts));
  return grid;
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', esc);
    onClose?.();
  };
  const esc = (event) => { if (event.key === 'Escape') close(); };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('button', { class: 'icon-btn modal-close', 'aria-label': 'Close', onclick: close }, '✕'),
      h('h2', {}, title),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '18px', gap: '8px' } },
        ...actions.map((action) => h('button', {
          class: `btn ${action.kind || ''}`,
          onclick: async (event) => {
            const result = await action.onClick?.(event, close);
            if (result !== false) close();
          },
        }, action.label)),
      ) : null,
    ),
  );
  root.append(backdrop);
  document.addEventListener('keydown', esc);
  backdrop.querySelector('input, textarea, button')?.focus();
  return { close, root: backdrop };
}

export function confirmDialog(title, message, { confirmLabel = 'Do it', danger = true } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('p', { class: 'muted' }, message),
      actions: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

export function starRating(value = 0, onChange, readonly = false) {
  const wrap = h('div', { class: 'row', style: { gap: '2px' }, 'aria-label': `Rating ${value} of 10` });
  for (let i = 1; i <= 5; i += 1) {
    const filled = value >= i * 2;
    const btn = h('button', {
      class: 'icon-btn',
      style: { width: '28px', height: '28px', fontSize: '15px', color: filled ? 'var(--accent)' : 'var(--faint)' },
      disabled: readonly,
      'aria-label': `${i * 2} out of 10`,
      onclick: () => onChange?.(i * 2),
    }, filled ? '★' : '☆');
    wrap.append(btn);
  }
  return wrap;
}

export function progressLabel(item) {
  if (!item.progress) return '';
  if (item.progress.finished) return 'watched';
  if (item.progress.positionSeconds > 30) return `resume ${fmtDuration(item.progress.positionSeconds, { clock: true })}`;
  return '';
}

export function timeAgo(iso) { return fmtRelative(iso); }

export function pageHeader(title, subtitles = [], actions = []) {
  return h('header', { class: 'page-head' },
    h('div', {},
      h('h1', {}, title),
      subtitles.filter(Boolean).length ? h('p', { class: 'sub' }, subtitles.filter(Boolean).join(' · ')) : null,
    ),
    actions.length ? h('div', { class: 'row wrap' }, ...actions) : null,
  );
}

export function loadImageFallback(item, kind = 'poster') {
  return artFor(item, kind) || placeholderArt(String(item?.id), kind, item?.title);
}
