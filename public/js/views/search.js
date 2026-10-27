// Search — instant, grouped, keyboard-friendly. Highlights are DOM text, not innerHTML.
import { artFor, get, placeholderArt, qs } from '../api.js';
import { state } from '../app.js';
import { cardLink, emptyState, h, skeletonCards } from '../ui.js';

const RECENT_KEY = 'slop-recent-searches';
const DEBOUNCE_MS = 300;

function installArtFallback(scope) {
  scope.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.artFallback === '1') return;
    img.dataset.artFallback = '1';
    const kind = img.closest('.search-hit, .poster-card.landscape') ? 'thumb' : 'poster';
    img.src = placeholderArt(img.alt || img.src || 'slop', kind, img.alt || '');
  }, true);
}

const GROUPS = [
  { key: 'movies', label: 'Movies', emoji: '🎬', kind: 'poster' },
  { key: 'shows', label: 'Shows', emoji: '📺', kind: 'poster' },
  { key: 'episodes', label: 'Episodes', emoji: '🎞️', kind: 'episode' },
  { key: 'people', label: 'People', emoji: '🧑‍🎤', kind: 'person' },
  { key: 'albums', label: 'Albums', emoji: '💿', kind: 'poster' },
  { key: 'artists', label: 'Artists', emoji: '🎤', kind: 'poster' },
  { key: 'tracks', label: 'Tracks', emoji: '🎵', kind: 'track' },
  { key: 'photos', label: 'Photos', emoji: '▣', kind: 'poster' },
  { key: 'videos', label: 'Videos', emoji: '📼', kind: 'poster' },
  { key: 'genres', label: 'Genres', emoji: '🏷️', kind: 'genre' },
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns a DocumentFragment with <mark> around matching tokens — never raw HTML. */
export function highlight(text, query) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? '');
  const tokens = String(query || '').trim().split(/\s+/).filter((token) => token.length > 0).map(escapeRegExp);
  if (!tokens.length || !source) {
    fragment.append(source);
    return fragment;
  }
  let regex;
  try {
    regex = new RegExp(`(${tokens.join('|')})`, 'gi');
  } catch {
    fragment.append(source);
    return fragment;
  }
  let last = 0;
  for (const match of source.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > last) fragment.append(source.slice(last, index));
    fragment.append(h('mark', { class: 'search-mark' }, match[0]));
    last = index + match[0].length;
  }
  if (last < source.length) fragment.append(source.slice(last));
  return fragment;
}

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberSearch(query) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return;
  const recent = [trimmed, ...readRecent().filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase())].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* private mode, no biggie */ }
}

function syncUrl(query) {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set('q', query);
  else url.searchParams.delete('q');
  if (url.search !== window.location.search) history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

function groupedResults(data, query) {
  const groups = data?.groups && typeof data.groups === 'object' ? data.groups : {};
  const fallback = Array.isArray(data?.items) ? data.items : [];
  const normalized = {};
  for (const group of GROUPS) {
    normalized[group.key] = Array.isArray(groups[group.key]) ? groups[group.key] : [];
  }
  if (!GROUPS.some((group) => normalized[group.key].length) && fallback.length) {
    for (const item of fallback) {
      const bucket = item.kind === 'episode' ? 'episodes'
        : item.kind === 'track' ? 'tracks'
          : item.kind === 'album' ? 'albums'
            : item.kind === 'artist' ? 'artists'
              : item.kind === 'show' ? 'shows'
                : item.kind === 'movie' ? 'movies'
                  : item.kind === 'photo' ? 'photos' : 'movies';
      if (!normalized[bucket]) normalized[bucket] = [];
      normalized[bucket].push(item);
    }
  }
  return normalized;
}

function personCard(person, query) {
  const name = typeof person === 'string' ? person : person?.name || 'Unknown human';
  const role = typeof person === 'string' ? '' : person?.role || person?.character || '';
  const href = typeof person === 'object' && person?.id ? `/item/${person.id}` : `/browse/movies?person=${encodeURIComponent(name)}`;
  return h('a', {
    class: 'person-hit',
    href,
    'data-link': true,
    'data-focus': true,
    'aria-label': `Search result for ${name}`,
  },
    h('span', { class: 'avatar person-avatar', 'aria-hidden': 'true' }, name.slice(0, 2).toUpperCase()),
    h('span', { class: 'person-copy' },
      h('strong', {}, highlight(name, query)),
      role ? h('span', { class: 'faint small' }, role) : null,
    ),
  );
}

function searchHit(item, query, kindHint) {
  const isEpisode = item.kind === 'episode' || kindHint === 'episode';
  const href = item.kind === 'track'
    ? (item.albumId ? `/music?album=${item.albumId}` : `/music?track=${item.id}`)
    : `/item/${item.id}`;
  const meta = [
    item.kind || kindHint,
    item.year ? String(item.year) : '',
    isEpisode && item.seasonNumber != null ? `S${item.seasonNumber}E${item.episodeNumber}` : '',
    item.artistName || '',
  ].filter(Boolean).join(' · ');
  return h('a', {
    class: 'search-hit',
    href,
    'data-link': true,
    'data-focus': true,
    'data-media-id': item.id,
    title: item.title || '',
  },
    h('img', {
      src: artFor(item, 'thumb'),
      alt: '',
      loading: 'lazy',
      decoding: 'async',
    }),
    h('div', { class: 'search-hit-copy' },
      h('strong', { class: 'search-hit-title' }, highlight(item.title || 'Untitled slop', query)),
      item.description ? h('p', { class: 'faint small clamp-2' }, highlight(item.description, query)) : null,
    ),
    h('span', { class: 'faint mono small search-hit-meta' }, meta),
  );
}

function posterGroup(items, query) {
  const grid = h('div', { class: 'grid poster-grid search-poster-grid' });
  for (const item of items) {
    const card = cardLink(item, { showKind: false });
    const titleNode = card.querySelector('.title');
    if (titleNode) titleNode.replaceChildren(highlight(item.title || 'Untitled slop', query));
    if (item.kind === 'photo') {
      const img = card.querySelector('img');
      if (img) img.src = artFor(item, 'thumb');
    }
    grid.append(card);
  }
  return grid;
}

function genreHits(items, query) {
  const names = items.map((entry) => (typeof entry === 'string' ? entry : entry?.genre || entry?.name || entry?.title || '')).filter(Boolean);
  if (!names.length) return h('div', { class: 'chip-row' }, ...items.map((entry) => h('span', { class: 'chip' }, String(entry?.genre || entry?.name || entry || 'slop'))));
  return h('div', { class: 'chip-row' }, ...names.map((genre) => h('a', {
    class: 'chip genre-chip',
    href: `/browse/movies?genre=${encodeURIComponent(genre)}`,
    'data-link': true,
    'data-focus': true,
  }, highlight(genre, query))));
}

function groupSection(group, items, query) {
  if (!items?.length) return null;
  const body = group.kind === 'episode' || group.kind === 'track'
    ? h('div', { class: 'search-results' }, ...items.map((item) => searchHit(item, query, group.kind)))
    : group.kind === 'person'
      ? h('div', { class: 'person-grid' }, ...items.map((person) => personCard(person, query)))
      : group.kind === 'genre'
        ? genreHits(items, query)
        : posterGroup(items, query);
  return h('section', { class: 'section search-group', 'data-search-group': group.key },
    h('div', { class: 'section-head' },
      h('h2', {}, group.emoji, ' ', group.label),
      h('span', { class: 'count' }, `${items.length} hit${items.length === 1 ? '' : 's'}`),
    ),
    body,
  );
}

function skeletonSearch(host) {
  host.replaceChildren(
    ...GROUPS.slice(0, 4).map((group) => h('section', { class: 'section', 'aria-hidden': 'true' },
      h('div', { class: 'section-head' }, h('div', { class: 'skeleton', style: { height: '18px', width: '120px' } })),
      h('div', { class: 'search-results' }, ...Array.from({ length: 3 }, () => h('div', { class: 'skeleton', style: { height: '58px' } }))),
    )),
  );
}

function shortcutTiles() {
  return h('div', { class: 'search-shortcuts' },
    ...[
      ['/browse/movies', '🎬', 'Movies', 'the classics, allegedly'],
      ['/browse/shows', '📺', 'Shows', 'one more episode'],
      ['/music', '♫', 'Music', 'headphones on'],
      ['/photos', '▣', 'Photos', 'local memories'],
    ].map(([href, emoji, label, sub]) => h('a', {
      class: 'search-tile',
      href,
      'data-link': true,
      'data-focus': true,
    }, h('span', { class: 'search-tile-emoji' }, emoji), h('strong', {}, label), h('span', { class: 'faint small' }, sub))),
  );
}

function idleState(query, recent, genres, applyQuery, clearRecent) {
  const chips = recent.length
    ? h('div', { class: 'chip-row' }, ...recent.map((entry) => h('button', {
      class: 'chip', type: 'button', 'data-focus': true,
      onclick: () => applyQuery(entry),
    }, '↺ ', entry)),
      h('button', { class: 'chip ghost-chip', type: 'button', onclick: clearRecent, 'aria-label': 'Clear recent searches' }, 'clear'))
    : null;
  const genreChips = genres.length
    ? h('div', { class: 'chip-row' }, ...genres.slice(0, 14).map((genre) => h('a', {
      class: 'chip', href: `/browse/movies?genre=${encodeURIComponent(genre)}`, 'data-link': true, 'data-focus': true,
    }, genre)))
    : null;
  return h('div', { class: 'search-idle' },
    h('div', { class: 'search-idle-mark', 'aria-hidden': 'true' }, '⌕'),
    h('h2', {}, query ? `No slop found for “${query}”` : 'What are we slopping today?'),
    h('p', { class: 'muted' }, query
      ? 'Zero results. Either it is not here, or your spelling is doing parkour.'
      : 'Search titles, episodes, people, albums — basically the whole brain cell.'),
    chips ? h('div', { class: 'search-idle-block' }, h('span', { class: 'eyebrow' }, 'recent searches'), chips) : null,
    h('div', { class: 'search-idle-block' }, h('span', { class: 'eyebrow' }, 'jump straight in'), shortcutTiles()),
    genreChips ? h('div', { class: 'search-idle-block' }, h('span', { class: 'eyebrow' }, 'genre roulette'), genreChips) : null,
  );
}

export default async function render(container, ctx) {
  const root = h('div', { class: 'search-view' });
  installArtFallback(root);
  container.append(root);
  document.title = `Search — ${state.branding?.serverName || 'AISlopMediaBox'}`;

  let query = String(ctx.query.q || '');
  let typing = query;
  let debounceTimer = null;
  let requestController = null;
  let requestToken = 0;
  let disposed = false;
  let filterGenres = [];

  const input = h('input', {
    class: 'search-page-input',
    type: 'search',
    placeholder: 'Search titles, people, albums, episodes…',
    value: query,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search the library',
    enterkeyhint: 'search',
  });
  const clearButton = h('button', {
    class: 'icon-btn search-clear',
    type: 'button',
    'aria-label': 'Clear search',
    onclick: () => { setQuery(''); input.focus(); },
  }, '✕');
  const form = h('form', { class: 'search-page-form', role: 'search' },
    h('span', { class: 'search-icon', 'aria-hidden': 'true' }, '⌕'),
    input,
    clearButton,
    h('kbd', { class: 'faint mono' }, 'esc'),
    h('button', { class: 'btn primary small search-submit', type: 'submit', 'data-focus': true }, 'Search'),
  );
  const status = h('div', { class: 'search-status faint small', 'aria-live': 'polite' });
  const resultHost = h('div', { class: 'search-result-host' });
  root.append(h('header', { class: 'search-page-head' },
    h('div', {},
      h('span', { class: 'eyebrow' }, 'search the slop'),
      h('h1', {}, 'Find your next bad decision'),
    ),
    status,
  ), form, resultHost);

  const renderIdle = () => {
    const recent = readRecent();
    resultHost.replaceChildren(idleState(query, recent, filterGenres, applyQuery, () => {
      try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
      renderIdle();
    }));
    status.textContent = query ? `No hits for “${query}”` : 'type at least 2 characters, gremlin';
  };

  const renderError = (error) => {
    resultHost.replaceChildren(h('div', { class: 'empty-state' },
      h('div', { class: 'emoji' }, '💀'),
      h('h3', {}, 'Search took an L'),
      h('p', {}, error.message || 'Server said no.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => runSearch(query, { instant: true }) }, 'Retry'),
    ));
    status.textContent = 'search failed';
  };

  const renderResults = (data, searched) => {
    const groups = groupedResults(data, searched);
    const total = Number(data?.total) || Object.values(groups).reduce((sum, items) => sum + items.length, 0);
    const sections = GROUPS.map((group) => groupSection(group, groups[group.key], searched)).filter(Boolean);
    if (!total || !sections.length) {
      const recent = readRecent();
      resultHost.replaceChildren(h('div', { class: 'empty-state search-empty' },
        h('div', { class: 'emoji' }, '🫥'),
        h('h3', {}, `“${searched}” found absolutely nothing`),
        h('p', {}, 'L + ratio + your title is not in the database. Try fewer words or different spelling.'),
        h('div', { class: 'row wrap', style: { gap: '8px' } },
          h('button', { class: 'btn primary', type: 'button', onclick: () => { setQuery(''); input.focus(); } }, 'Clear search'),
          h('a', { class: 'btn', href: '/browse/movies', 'data-link': true }, 'Browse movies'),
          h('a', { class: 'btn ghost', href: '/', 'data-link': true }, 'Home'),
        ),
        recent.length ? h('div', { class: 'chip-row' }, ...recent.slice(0, 5).map((entry) => h('button', {
          class: 'chip', type: 'button', onclick: () => applyQuery(entry),
        }, entry))) : null,
      ));
      status.textContent = `0 hits for “${searched}” · the algorithm is seething`;
      return;
    }
    resultHost.replaceChildren(...sections);
    status.textContent = `${total.toLocaleString()} hit${total === 1 ? '' : 's'} for “${searched}” · grouped by vibe`;
    rememberSearch(searched);
  };

  async function runSearch(raw, { instant = false } = {}) {
    const trimmed = String(raw || '').trim();
    query = trimmed;
    syncUrl(trimmed);
    clearTimeout(debounceTimer);
    requestController?.abort();
    const token = ++requestToken;
    if (!trimmed) {
      requestController = null;
      renderIdle();
      return;
    }
    if (trimmed.length < 2) {
      resultHost.replaceChildren(h('div', { class: 'empty-state small-empty' },
        h('div', { class: 'emoji' }, '⌨️'),
        h('h3', {}, 'Need one more character'),
        h('p', {}, 'Two letters minimum. We are not Yahoo Answers.'),
      ));
      status.textContent = 'keep typing';
      return;
    }
    requestController = new AbortController();
    root.setAttribute('aria-busy', 'true');
    skeletonSearch(resultHost);
    status.textContent = `searching “${trimmed}”…`;
    try {
      const data = await get('/api/browse/search' + qs({ q: trimmed, limit: instant ? 40 : 20 }), { signal: requestController.signal });
      if (disposed || token !== requestToken) return;
      renderResults(data || {}, trimmed);
    } catch (error) {
      if (disposed || token !== requestToken || error?.name === 'AbortError') return;
      if (error?.status === 401) return;
      renderError(error);
    } finally {
      if (!disposed && token === requestToken) root.removeAttribute('aria-busy');
    }
  }

  const scheduleSearch = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(typing), DEBOUNCE_MS);
  };

  function setQuery(next, { focus = false, immediate = false } = {}) {
    typing = next;
    input.value = next;
    if (focus) input.focus();
    if (immediate) runSearch(next, { instant: true });
    else scheduleSearch();
  }

  function applyQuery(next) {
    setQuery(next, { focus: true, immediate: true });
  }

  input.addEventListener('input', () => {
    typing = input.value;
    syncUrl(input.value.trim());
    requestToken += 1;
    requestController?.abort();
    requestController = null;
    scheduleSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('', { focus: true, immediate: true });
    }
    if (event.key === 'ArrowDown') {
      const first = resultHost.querySelector('[data-focus], a[href]');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(input.value, { instant: true });
    input.blur();
  });

  root.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (event.target === input) return;
    const focusables = [...resultHost.querySelectorAll('[data-focus], a[href], button')].filter((element) => element.offsetParent !== null);
    if (!focusables.length) return;
    const index = focusables.indexOf(document.activeElement);
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(focusables.length - 1, index + 1)
      : Math.max(0, index - 1);
    if (index === -1) focusables[0].focus();
    else focusables[nextIndex].focus();
    event.preventDefault();
  });

  if (!state.tvMode) requestAnimationFrame(() => input.focus({ preventScroll: true }));

  try {
    const filters = await get('/api/browse/filters', { signal: ctx.signal });
    filterGenres = Array.isArray(filters?.genres)
      ? filters.genres.map((genre) => (typeof genre === 'string' ? genre : genre?.genre || genre?.name || '')).filter(Boolean)
      : [];
  } catch { filterGenres = []; }
  if (disposed) return () => {};

  if (query) await runSearch(query, { instant: true });
  else renderIdle();

  return () => {
    disposed = true;
    clearTimeout(debounceTimer);
    requestController?.abort();
  };
}
