import { api, get, setUnauthorizedHandler, connectEvents, placeholderArt } from './api.js';
import { navigate, route, startRouter } from './router.js';
import { h, icon, modal, toast } from './ui.js';

export const state = {
  user: null,
  branding: { serverName: 'AISlopMediaBox', tagline: 'Certified fresh slop, served locally.', version: '1.0.0' },
  tvMode: localStorage.getItem('slop-tv') === '1',
  theme: localStorage.getItem('slop-theme') || 'slop',
  scan: null,
  events: null,
};

const NAV_ITEMS = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/browse/movies', label: 'Movies', icon: 'movies' },
  { href: '/browse/shows', label: 'Shows', icon: 'shows' },
  { href: '/music', label: 'Music', icon: 'music' },
  { href: '/photos', label: 'Photos', icon: 'photos' },
  { href: '/collections', label: 'Collections', icon: 'collections' },
  { href: '/playlists', label: 'Playlists', icon: 'playlists' },
  { href: '/requests', label: 'Requests', icon: 'requests' },
];
const BOTTOM_ITEMS = NAV_ITEMS.slice(0, 5).concat({ href: '/collections', label: 'More', icon: 'collections' });

route('/', () => import('./views/home.js'));
route('/browse/:kind', () => import('./views/browse.js'));
route('/item/:id', () => import('./views/detail.js'));
route('/watch/:id', () => import('./views/watch.js'));
route('/music', () => import('./views/music.js'));
route('/music/:tab', () => import('./views/music.js'));
route('/photos', () => import('./views/photos.js'));
route('/search', () => import('./views/search.js'));
route('/collections', () => import('./views/collections.js'));
route('/collections/:id', () => import('./views/collection.js'));
route('/playlists', () => import('./views/playlists.js'));
route('/playlists/:id', () => import('./views/playlist.js'));
route('/requests', () => import('./views/requests.js'));
route('/profile', () => import('./views/profile.js'));
route('/party', () => import('./views/party.js'));
route('/party/new', () => import('./views/party.js'));
route('/party/:id', () => import('./views/party.js'));
route('/tv', () => import('./views/home.js'), { tv: true });

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('slop-theme', theme);
}

function applyTvMode(force) {
  state.tvMode = force ?? !state.tvMode;
  document.body.classList.toggle('tv-mode', state.tvMode);
  localStorage.setItem('slop-tv', state.tvMode ? '1' : '0');
  toast(state.tvMode ? 'TV mode on. Grab the remote, gremlin.' : 'TV mode off. Mouse peasants rejoice.', 'fun', { emoji: state.tvMode ? '📺' : '🖱️' });
}

function currentActive(pathname) {
  if (pathname === '/') return '/';
  for (const item of NAV_ITEMS) {
    if (item.href !== '/' && pathname.startsWith(item.href.replace(/\/$/, ''))) return item.href;
  }
  if (pathname.startsWith('/browse/movies')) return '/browse/movies';
  if (pathname.startsWith('/browse/shows')) return '/browse/shows';
  return '';
}

function renderNav() {
  const side = document.getElementById('side-nav');
  const bottom = document.getElementById('bottom-nav');
  const active = currentActive(location.pathname);
  const adminLink = state.user?.role === 'admin' ? { href: '/admin', label: 'Admin', icon: 'settings', external: true } : null;
  const links = [...NAV_ITEMS, ...(adminLink ? [adminLink] : [])];
  side.replaceChildren(
    ...links.map((item) => h('a', {
      class: `nav-link${active === item.href ? ' active' : ''}`,
      href: item.href,
      'data-link': !item.external,
      'data-focus': true,
    }, icon(item.icon), h('span', {}, item.label))),
    h('div', { class: 'side-section' }, 'server'),
    h('a', { class: 'nav-link', href: '/admin', 'data-focus': true }, icon('dashboard'), h('span', {}, 'Admin panel')),
  );
  bottom.replaceChildren(...BOTTOM_ITEMS.map((item) => h('a', {
    class: active === item.href ? 'active' : '',
    href: item.href,
    'data-link': true,
  }, icon(item.icon), h('span', {}, item.label))));
}

function profileModal() {
  const user = state.user;
  const body = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { gap: '14px' } },
      h('span', { class: 'avatar', style: { width: '52px', height: '52px', fontSize: '20px', '--avatar-hue': user.avatarHue } }, (user.displayName || user.username).slice(0, 2).toUpperCase()),
      h('div', {},
        h('h3', {}, user.displayName),
        h('div', { class: 'faint small' }, `@${user.username} · ${user.role}`),
        h('div', { class: 'faint small' }, user.role === 'admin' ? 'Slop Council member' : 'Certified slopper'),
      ),
    ),
    h('div', { class: 'divider' }),
    h('a', { class: 'btn block', href: '/profile', 'data-link': true, onclick: () => closeRef.close() }, 'Profile & settings'),
    user.role === 'admin' ? h('a', { class: 'btn block', href: '/admin' }, '⚙ Admin panel') : null,
    h('button', { class: 'btn block ghost', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; } }, 'Log out'),
  );
  const closeRef = modal({ title: 'Who dis?', body });
}

function bindChrome() {
  document.getElementById('brand-name').textContent = state.branding.serverName;
  document.getElementById('topbar-brand-name').textContent = state.branding.serverName;
  document.getElementById('footer-version').textContent = `v${state.branding.version}`;
  document.getElementById('me-name').textContent = state.user.displayName;
  const avatar = document.getElementById('me-avatar');
  avatar.textContent = (state.user.displayName || state.user.username).slice(0, 2).toUpperCase();
  avatar.style.setProperty('--avatar-hue', String(state.user.avatarHue));

  document.getElementById('profile-chip').addEventListener('click', profileModal);
  document.querySelector('[data-open-profile]')?.addEventListener('click', profileModal);
  document.getElementById('menu-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.getElementById('theme-btn').addEventListener('click', () => {
    const themes = ['slop', 'light', 'midnight', 'goblin'];
    applyTheme(themes[(themes.indexOf(state.theme) + 1) % themes.length]);
    toast(`Theme: ${state.theme}. Aesthetic maxing.`, 'fun', { emoji: '🎨' });
  });
  document.getElementById('tv-btn').addEventListener('click', () => applyTvMode());
  document.getElementById('random-btn').addEventListener('click', async () => {
    try {
      const res = await get('/api/browse/random');
      if (res?.item) navigate(`/item/${res.item.id}`);
      else toast('No media found. Scan a library first, chief.', 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.getElementById('global-search').value.trim();
    if (value) navigate(`/search?q=${encodeURIComponent(value)}`);
  });
  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable;
    if (!typing && event.key === '/') {
      event.preventDefault();
      document.getElementById('global-search').focus();
    }
    if (event.key === 'Escape' && document.body.classList.contains('nav-open')) document.body.classList.remove('nav-open');
    if (state.tvMode && !typing) tvKeyNav(event);
  });
  window.addEventListener('popstate', renderNav);
  window.addEventListener('slop:route-change', () => {
    renderNav();
    document.body.classList.remove('nav-open');
  });
}

function tvKeyNav(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const focusables = [...document.querySelectorAll('[data-focus], a[href], button:not([disabled]), input, select')]
    .filter((el) => el.offsetParent !== null && el.getClientRects().length > 0);
  if (!focusables.length) return;
  const active = document.activeElement;
  const index = focusables.indexOf(active);
  if (index === -1) {
    focusables[0].focus();
    event.preventDefault();
    return;
  }
  const rect = active.getBoundingClientRect();
  const candidates = focusables.filter((el) => el !== active);
  const directional = candidates
    .map((el) => {
      const r = el.getBoundingClientRect();
      const dx = (r.left + r.width / 2) - (rect.left + rect.width / 2);
      const dy = (r.top + r.height / 2) - (rect.top + rect.height / 2);
      return { el, dx, dy, r };
    })
    .filter((item) => {
      if (event.key === 'ArrowRight') return item.dx > 4 && Math.abs(item.dy) < rect.height * 1.1;
      if (event.key === 'ArrowLeft') return item.dx < -4 && Math.abs(item.dy) < rect.height * 1.1;
      if (event.key === 'ArrowDown') return item.dy > 4 && Math.abs(item.dx) < rect.width * 1.2;
      return item.dy < -4 && Math.abs(item.dx) < rect.width * 1.2;
    })
    .sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dy) * 2) - (Math.abs(b.dx) + Math.abs(b.dy) * 2));
  const next = directional[0]?.el;
  if (next) {
    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    event.preventDefault();
  }
}

function setupEvents() {
  state.events?.close();
  state.events = connectEvents({
    'scan.progress': (data) => {
      state.scan = data;
      const banner = document.getElementById('scan-banner');
      if (data.status === 'done' || data.status === 'error' || !data.active) {
        banner.hidden = true;
        if (data.status === 'done') {
          toast('Scan done. Fresh slop acquired.', 'success');
          window.dispatchEvent(new CustomEvent('slop:scan-done', { detail: data }));
        }
        return;
      }
      banner.hidden = false;
      const pct = Math.round((data.progress || 0) * 100);
      document.getElementById('scan-banner-text').textContent = `Scanning ${data.libraryName || 'library'}… ${pct}% ${data.message || ''}`;
    },
    'job.update': (job) => {
      if (!job) return;
      if (job.status === 'done' && job.type !== 'scan') toast(`${job.type} job finished.`, 'success');
      if (job.status === 'error') toast(`${job.type} job failed: ${job.error || job.message}`, 'error');
    },
    'media.changed': () => {
      window.dispatchEvent(new CustomEvent('slop:media-changed'));
    },
  });
}

async function boot() {
  applyTheme(state.theme);
  document.body.classList.toggle('tv-mode', state.tvMode);
  let me = null;
  try {
    me = await get('/api/auth/me');
  } catch (error) {
    if (error.status !== 401) {
      document.getElementById('boot-screen').innerHTML = `<div class="boot-mark">💀</div><div class="boot-text">server unreachable: ${String(error.message).replace(/[<>]/g, '')}</div>`;
      return;
    }
  }
  if (!me?.authenticated) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }
  state.user = me.user;
  try {
    state.branding = await get('/api/branding');
  } catch { /* keep defaults */ }
  document.title = `${state.branding.serverName} — certified slop`;
  document.getElementById('boot-screen').hidden = true;
  document.getElementById('app').hidden = false;
  bindChrome();
  renderNav();
  setupEvents();
  setUnauthorizedHandler(() => {
    if (!location.pathname.startsWith('/login')) location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  });
  startRouter();
  window.addEventListener('slop:navigate', () => { /* future: view transitions */ });
}

boot();

export { navigate, modal, toast, placeholderArt };
