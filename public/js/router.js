// Minimal history router with pattern params, scroll restoration, and view cleanup.
const routes = [];
let currentCleanup = null;
let currentPath = '';

export function route(pattern, loaderOrView, meta = {}) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; }) + '/?$',
  );
  routes.push({ regex, keys, loaderOrView, meta, pattern });
}

export function match(pathname) {
  for (const entry of routes) {
    const found = pathname.match(entry.regex);
    if (!found) continue;
    const params = {};
    entry.keys.forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1] || ''); });
    return { ...entry, params };
  }
  return null;
}

export function navigate(to, { replace = false, state = {} } = {}) {
  if (to === window.location.pathname + window.location.search && !replace) return;
  if (replace) history.replaceState(state, '', to);
  else history.pushState(state, '', to);
  dispatch();
}

export function rerender() { dispatch(); }

export async function dispatch() {
  const { pathname, search } = window.location;
  const query = Object.fromEntries(new URLSearchParams(search));
  const found = match(pathname);
  const host = document.getElementById('view');
  if (!host) return;
  if (currentCleanup) {
    try { currentCleanup(); } catch { /* cleanup is best effort */ }
    currentCleanup = null;
  }
  if (!found) {
    host.innerHTML = '<div class="empty-state"><div class="emoji">🫠</div><h3>404 — page not found</h3><p>This route is not certified slop. <a class="mini-link" href="/" data-link>Go home.</a></p></div>';
    return;
  }
  const samePath = pathname === currentPath;
  currentPath = pathname;
  window.dispatchEvent(new CustomEvent('slop:route-change', { detail: { pathname, query } }));
  host.setAttribute('aria-busy', 'true');
  const loading = document.createElement('div');
  loading.className = 'view-loading';
  loading.innerHTML = '<div class="spinner"></div>';
  if (!samePath) {
    host.replaceChildren(loading);
    window.scrollTo(0, 0);
  }
  const token = (dispatch.token = (dispatch.token || 0) + 1);
  try {
    const loaded = typeof found.loaderOrView === 'function' ? found.loaderOrView() : found.loaderOrView;
    const module = typeof loaded?.then === 'function' ? await loaded : loaded;
    if (token !== dispatch.token) return;
    const view = module?.default || module?.render;
    if (!view) throw new Error(`View for ${pathname} has no default render export`);
    const abort = new AbortController();
    currentCleanup = null;
    host.replaceChildren();
    const result = await view(host, { params: found.params, query, signal: abort.signal, navigate, meta: found.meta });
    currentCleanup = typeof result === 'function' ? () => { abort.abort(); result(); } : () => abort.abort();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error(error);
    host.replaceChildren();
    const state = document.createElement('div');
    state.className = 'empty-state';
    const emoji = document.createElement('div');
    emoji.className = 'emoji';
    emoji.textContent = '💀';
    const title = document.createElement('h3');
    title.textContent = 'The slop failed to load';
    const message = document.createElement('p');
    message.textContent = String(error.message || error);
    const retry = document.createElement('button');
    retry.className = 'btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => location.reload());
    state.append(emoji, title, message, retry);
    host.append(state);
  } finally {
    host.removeAttribute('aria-busy');
  }
}

export function startRouter() {
  window.addEventListener('popstate', () => dispatch());
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-link]');
    if (!link) return;
    if (link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(link.pathname + link.search + link.hash);
  });
  window.addEventListener('scroll', () => { lastScrollY = window.scrollY; }, { passive: true });
  dispatch();
}

export let lastScrollY = 0;
