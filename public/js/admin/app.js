// Admin shell: auth gate, hash router, server-health pill, SSE bridge, dirty-state guard.
import { connectEvents, get, setUnauthorizedHandler, initials } from '../api.js';
import { h, toast, confirmDialog } from '../ui.js';
import {
  state, emitAdminEvent, redirectToLogin, apiError, errorState, btn,
} from './core.js';
import dashboard from './dashboard.js';
import libraries from './libraries.js';
import ingest from './ingest.js';
import media from './media.js';
import users from './users.js';
import requests from './requests.js';
import moderation from './moderation.js';
import jobs from './jobs.js';
import logs from './logs.js';
import settings from './settings.js';
import privacy from './privacy.js';
import storage from './storage.js';

const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard', icon: '▤', group: 'Overview' },
  { id: 'libraries', label: 'Libraries', icon: '🗄', group: 'Library' },
  { id: 'ingest', label: 'Ingestion', icon: '📥', group: 'Library' },
  { id: 'media', label: 'Media', icon: '▶', group: 'Library' },
  { id: 'users', label: 'Users', icon: '◉', group: 'People' },
  { id: 'requests', label: 'Requests', icon: '✉', group: 'People' },
  { id: 'moderation', label: 'Moderation', icon: '⚑', group: 'People' },
  { id: 'jobs', label: 'Jobs', icon: '⚡', group: 'Server' },
  { id: 'logs', label: 'Logs', icon: '▦', group: 'Server' },
  { id: 'storage', label: 'Storage', icon: '💾', group: 'Server' },
  { id: 'settings', label: 'Settings', icon: '⚙', group: 'System' },
  { id: 'privacy', label: 'Privacy', icon: '🔒', group: 'System' },
];
const VIEWS = { dashboard, libraries, ingest, media, users, requests, moderation, jobs, logs, settings, privacy, storage };
const GROUPS = ['Overview', 'Library', 'People', 'Server', 'System'];

let currentSection = null;
let cleanup = null;
let activeController = null;
let renderToken = 0;
let healthTimer = null;
let navBound = false;

function sectionMeta(id) {
  return SECTIONS.find((section) => section.id === id) || SECTIONS[0];
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '').trim();
  const id = raw.split(/[/?]/)[0];
  return SECTIONS.some((section) => section.id === id) ? id : 'dashboard';
}

function renderNav() {
  const nav = document.getElementById('adm-nav');
  const nodes = [];
  for (const group of GROUPS) {
    nodes.push(h('div', { class: 'adm-nav-label' }, group));
    for (const section of SECTIONS.filter((item) => item.group === group)) {
      nodes.push(h('a', {
        href: `#${section.id}`,
        'data-section': section.id,
        'aria-current': state.section === section.id ? 'page' : undefined,
        title: section.label,
      },
      h('span', { class: 'adm-nav-icon', 'aria-hidden': 'true' }, section.icon),
      h('span', { class: 'adm-nav-text' }, section.label)));
    }
  }
  nav.replaceChildren(...nodes);
}

function updateActiveNav(id) {
  document.querySelectorAll('#adm-nav a[data-section]').forEach((anchor) => {
    if (anchor.dataset.section === id) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  });
}

async function renderSection(id, { focus = false } = {}) {
  const meta = sectionMeta(id);
  const view = VIEWS[id];
  if (!view || typeof view.render !== 'function') {
    toast('That admin section forgot to exist.', 'error');
    return;
  }
  const token = ++renderToken;
  const previousController = activeController;
  activeController = null;
  if (cleanup) {
    try { cleanup(); } catch (error) { console.error('admin cleanup failed', error); }
    cleanup = null;
  }
  if (previousController) previousController.abort();
  state.section = id;
  state.dirtyGuard = null;
  updateActiveNav(id);
  document.getElementById('adm-crumb').textContent = meta.label;
  document.title = `${meta.label} — Control room — ${state.branding.serverName}`;
  const host = document.getElementById('adm-main');
  host.replaceChildren(h('div', { class: 'adm-view-loading' }, h('div', { class: 'spinner' }), h('span', {}, `loading ${meta.label.toLowerCase()}…`)));
  const controller = new AbortController();
  activeController = controller;
  const ctx = {
    section: id,
    signal: controller.signal,
    navigate: (next) => { if (next !== id) { location.hash = `#${next}`; } },
    onCleanup: (fn) => { controller.signal.addEventListener('abort', fn, { once: true }); },
    refreshHealth,
  };
  try {
    const result = await view.render(host, ctx);
    const resultCleanup = typeof result === 'function' ? result : null;
    if (resultCleanup) controller.signal.addEventListener('abort', resultCleanup, { once: true });
    if (token !== renderToken) {
      controller.abort();
      if (resultCleanup && controller.signal.aborted) {
        try { resultCleanup(); } catch (error) { console.error('admin cleanup failed', error); }
      }
      return;
    }
    cleanup = resultCleanup;
    if (focus) host.focus({ preventScroll: true });
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    if (error?.name === 'AbortError') return;
    host.replaceChildren(h('div', { class: 'adm-section' },
      errorState(error, () => renderSection(id), { title: 'The control room hit a snag' }),
    ));
  }
}

async function handleHashChange({ initial = false } = {}) {
  const target = parseHash();
  if (target === currentSection) return;
  if (!initial && state.dirtyGuard) {
    let leave = false;
    try { leave = await state.dirtyGuard(); } catch { leave = false; }
    if (!leave) {
      history.replaceState(null, '', `#${currentSection}`);
      return;
    }
    state.dirtyGuard = null;
    state.dirty = false;
  }
  currentSection = target;
  window.scrollTo({ top: 0, behavior: 'instant' });
  await renderSection(target, { focus: !initial });
}

function closeMobileNav() {
  document.body.classList.remove('nav-open');
  document.getElementById('adm-menu')?.setAttribute('aria-expanded', 'false');
  document.getElementById('adm-scrim').hidden = true;
}

function bindChrome() {
  if (navBound) return;
  navBound = true;
  document.getElementById('adm-menu').addEventListener('click', () => {
    const open = !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open', open);
    document.getElementById('adm-menu').setAttribute('aria-expanded', String(open));
    document.getElementById('adm-scrim').hidden = !open;
  });
  document.getElementById('adm-scrim').addEventListener('click', closeMobileNav);
  document.getElementById('adm-nav').addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMobileNav();
  });
  document.getElementById('adm-health').addEventListener('click', () => refreshHealth());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMobileNav();
    if (!event.target.closest?.('input, textarea, select, [contenteditable="true"]') && event.key === 'r' && event.altKey) {
      event.preventDefault();
      refreshHealth();
      toast('Health re-checked.', 'info');
    }
  });
  window.addEventListener('hashchange', () => handleHashChange());
  window.addEventListener('resize', () => { if (window.innerWidth > 760) closeMobileNav(); });
}

function setHealthPill(stateName, label, title) {
  const pill = document.getElementById('adm-health');
  if (!pill) return;
  pill.dataset.state = stateName;
  pill.querySelector('.adm-health-text').textContent = label;
  pill.title = title || label;
}

export async function refreshHealth() {
  try {
    const health = await get('/api/health');
    state.health = health;
    if (!health?.ok) {
      setHealthPill('down', 'unhealthy', 'Server responded but reports not-ok.');
      return;
    }
    if (health.maintenance) {
      setHealthPill('warn', 'maintenance', `Server healthy but maintenance mode is ON. Version ${health.version || ''} · uptime ${health.uptimeSeconds || 0}s`);
      return;
    }
    setHealthPill('ok', 'healthy', [
      `v${health.version || '?'}`, health.env || '', `uptime ${Math.round((health.uptimeSeconds || 0) / 60)}m`,
      `${health.sseClients ?? 0} SSE clients`, `node ${health.node || ''}`,
    ].filter(Boolean).join(' · '));
  } catch (error) {
    state.health = null;
    setHealthPill('down', 'unreachable', `Cannot reach the server: ${apiError(error)}`);
  }
}

function setupEvents() {
  state.events?.close();
  state.events = connectEvents({
    'job.update': (data) => emitAdminEvent('job.update', data),
    'scan.progress': (data) => emitAdminEvent('scan.progress', data),
    'ingest.progress': (data) => emitAdminEvent('ingest.progress', data),
    'ingest.item': (data) => emitAdminEvent('ingest.item', data),
    'media.changed': (data) => emitAdminEvent('media.changed', data),
    'settings.changed': (data) => emitAdminEvent('settings.changed', data),
    'stream.started': (data) => emitAdminEvent('stream.started', data),
    'stream.ended': (data) => emitAdminEvent('stream.ended', data),
  });
}

function bootError(error) {
  const boot = document.getElementById('adm-boot');
  boot.hidden = false;
  boot.replaceChildren(h('div', { class: 'adm-boot-error' },
    h('div', { class: 'adm-boot-mark', 'aria-hidden': 'true' }, '💀'),
    h('h1', {}, 'The control room is dark'),
    h('p', {}, apiError(error)),
    btn('Try again', () => location.reload(), { kind: 'primary', small: false }),
    h('a', { class: 'mini-link', href: '/' }, '← Back to the app'),
  ));
}

function deniedState(me) {
  const boot = document.getElementById('adm-boot');
  boot.hidden = false;
  boot.removeAttribute('aria-live');
  const who = me?.user;
  boot.replaceChildren(h('div', { class: 'adm-boot-error' },
    h('div', { class: 'adm-boot-mark', 'aria-hidden': 'true' }, '🚫'),
    h('h1', {}, 'Not your lane'),
    h('p', {}, who
      ? `Signed in as @${who.username} with role "${who.role}". The control room is admin-only. Ask the slop council for a promotion, or head back to the library.`
      : 'This area is admin-only.'),
    h('div', { class: 'row wrap', style: { justifyContent: 'center' } },
      h('a', { class: 'btn', href: '/' }, '← Back to app'),
      h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => {
          try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* already gone */ }
          location.href = '/login?next=%2Fadmin';
        },
      }, 'Log in as someone else'),
    ),
    h('p', { class: 'faint mono small' }, 'admin endpoints require requireAdmin — this is not a suggestion.'),
  ));
  document.getElementById('adm-shell').hidden = true;
}

function bindUserChrome(me) {
  const user = me.user;
  const side = document.getElementById('adm-side-user');
  side.replaceChildren(
    h('span', { class: 'avatar', style: { '--avatar-hue': user.avatarHue ?? 280 } }, initials(user.displayName || user.username)),
    h('span', { class: 'adm-side-user-copy' },
      h('strong', {}, user.displayName || user.username),
      h('span', {}, user.role || 'admin'),
    ),
  );
  document.getElementById('adm-brand-name').textContent = state.branding.serverName;
  document.getElementById('adm-footer-meta').textContent = `v${state.branding.version || '?'} · signed in as @${user.username}`;
}

export async function bootAdmin() {
  let me;
  try {
    me = await get('/api/auth/me');
  } catch (error) {
    if (error.status === 401 || !error.status) {
      redirectToLogin();
      return;
    }
    bootError(error);
    return;
  }
  if (!me?.authenticated || !me.user) {
    redirectToLogin();
    return;
  }
  if (me.user.role !== 'admin') {
    document.getElementById('adm-boot').hidden = true;
    document.getElementById('adm-boot').removeAttribute('aria-live');
    deniedState(me);
    return;
  }
  state.user = me.user;
  try {
    state.branding = await get('/api/branding');
  } catch { /* branding is cosmetic; defaults are fine */ }

  document.getElementById('adm-boot').hidden = true;
  document.getElementById('adm-shell').hidden = false;
  bindUserChrome(me);
  bindChrome();
  renderNav();
  state.setTitle = (label) => { document.getElementById('adm-crumb').textContent = label; };
  setUnauthorizedHandler(() => redirectToLogin());
  refreshHealth();
  healthTimer = setInterval(refreshHealth, 30_000);
  window.addEventListener('beforeunload', () => clearInterval(healthTimer), { once: true });
  setupEvents();
  window.addEventListener('beforeunload', (event) => {
    if (state.dirtyGuard && state.dirty) {
      // Async confirm is impossible here; use the browser's native leave prompt.
      event.preventDefault();
      event.returnValue = '';
    }
  });
  await handleHashChange({ initial: true });
}
