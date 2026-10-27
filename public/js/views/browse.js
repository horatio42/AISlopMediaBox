// Browse — filters that actually filter, grids that breathe, URL that remembers.
import { artFor, get, placeholderArt, qs } from '../api.js';
import { state } from '../app.js';
import { cardLink, emptyState, h, skeletonCards, toast } from '../ui.js';

const PAGE_SIZE = 60;

const KINDS = {
  movie: { slug: 'movies', title: 'Movies', kicker: 'certified cinema, questionable taste', empty: 'No movies match that combo. The algorithm is seething.' },
  show: { slug: 'shows', title: 'Shows', kicker: 'episodes of varying basedness', empty: 'No shows match. Touch grass, then refine your filters.' },
  video: { slug: 'videos', title: 'Music videos', kicker: 'visual slop, played loud', empty: 'No videos match. Skill issue on the filter front.' },
  photo: { slug: 'photos', title: 'Photos', kicker: 'memories, locally hosted', empty: 'No photos match. The vibes are off.' },
  album: { slug: 'albums', title: 'Albums', kicker: 'full-length slop, tracklisted', empty: 'No albums match. Cope and rethink.' },
  artist: { slug: 'artists', title: 'Artists', kicker: 'the talent (allegedly)', empty: 'No artists match. Ratio.' },
  track: { slug: 'tracks', title: 'Tracks', kicker: 'one-song bangers', empty: 'No tracks match. Head empty.' },
};

const SLUG_TO_KIND = {
  movies: 'movie', movie: 'movie',
  shows: 'show', show: 'show', tv: 'show',
  videos: 'video', video: 'video', 'music-videos': 'video', 'music-video': 'video',
  photos: 'photo', photo: 'photo',
  albums: 'album', album: 'album', music: 'album',
  artists: 'artist', artist: 'artist',
  tracks: 'track', track: 'track',
};

const SORTS = [
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'year', label: 'Year' },
  { value: 'rating', label: 'Top rated' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'random', label: 'Chaos (random)' },
];

const FILTER_KEYS = ['genre', 'yearFrom', 'yearTo', 'libraryId', 'contentRating', 'tag', 'person', 'sort', 'order'];

function installArtFallback(scope) {
  scope.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.artFallback === '1') return;
    img.dataset.artFallback = '1';
    const kind = img.closest('.poster-card.landscape, .ep-thumb') ? 'thumb' : 'poster';
    img.src = placeholderArt(img.alt || img.src || 'slop', kind, img.alt || '');
  }, true);
}

function resolveKind(params = {}, query = {}) {
  const raw = String(query.kind || params.kind || 'movies').toLowerCase();
  return SLUG_TO_KIND[raw] || raw;
}

function defaultSort(kind) {
  return kind === 'track' || kind === 'album' || kind === 'artist' ? 'title' : 'added';
}

function filtersFromQuery(query) {
  const filters = {};
  for (const key of FILTER_KEYS) {
    if (query[key] !== undefined && query[key] !== '') filters[key] = String(query[key]);
  }
  for (const flag of ['favorites', 'watched', 'unwatched', 'inProgress']) {
    if (query[flag] === '1' || query[flag] === 'true') filters[flag] = true;
  }
  return filters;
}

function isDefaultSort(filters, kind) {
  return (filters.sort || defaultSort(kind)) === defaultSort(kind) && !filters.order;
}

function hasActiveFilters(filters, kind) {
  if (filters.favorites || filters.watched || filters.unwatched || filters.inProgress) return true;
  for (const key of FILTER_KEYS) {
    if (key === 'sort' || key === 'order') continue;
    if (filters[key]) return true;
  }
  return !isDefaultSort(filters, kind);
}

function syncUrl(filters, kind, page) {
  const url = new URL(window.location.href);
  for (const key of FILTER_KEYS) {
    if (filters[key]) url.searchParams.set(key, filters[key]);
    else url.searchParams.delete(key);
  }
  for (const flag of ['favorites', 'watched', 'unwatched', 'inProgress']) {
    if (filters[flag]) url.searchParams.set(flag, '1');
    else url.searchParams.delete(flag);
  }
  if (page > 1) url.searchParams.set('page', String(page));
  else url.searchParams.delete('page');
  if (url.search !== window.location.search) history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

function optionSelect(label, value, options, onChange, { anyLabel = 'All' } = {}) {
  const select = h('select', {
    class: 'select browse-select',
    'aria-label': label,
    'data-focus': true,
    onchange: (event) => onChange(event.target.value),
  },
    h('option', { value: '' }, anyLabel),
    ...options.map((option) => h('option', { value: String(option.value), selected: String(option.value) === String(value) }, option.label)),
  );
  return h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, label), select);
}

function yearsBetween(range) {
  const min = Number(range?.[0]);
  const max = Number(range?.[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  const years = [];
  const start = Math.max(min, max - 80);
  for (let year = max; year >= start; year -= 1) years.push({ value: year, label: String(year) });
  return years;
}

function normalizeLibraries(libraries) {
  return (libraries || []).map((library) => {
    if (typeof library === 'object' && library !== null) return { value: library.id, label: library.name || `Library ${library.id}` };
    return { value: library, label: String(library) };
  });
}

function normalizeStrings(values) {
  return (values || []).map((value) => {
    if (typeof value === 'object' && value !== null) return String(value.genre || value.name || value.contentRating || value.value || '');
    return String(value);
  }).filter(Boolean);
}

function filterChip(label, onRemove) {
  return h('button', {
    class: 'chip active filt-chip',
    type: 'button',
    'data-focus': true,
    'aria-label': `Remove filter ${label}`,
    onclick: onRemove,
  }, label, h('span', { class: 'x', 'aria-hidden': 'true' }, '✕'));
}

function activeChips(filters, kind, onClear) {
  const chips = [];
  if (filters.genre) chips.push(filterChip(filters.genre, () => onClear('genre')));
  if (filters.yearFrom && filters.yearFrom === filters.yearTo) chips.push(filterChip(filters.yearFrom, () => { onClear('yearFrom'); onClear('yearTo'); }));
  else if (filters.yearFrom) chips.push(filterChip(`from ${filters.yearFrom}`, () => onClear('yearFrom')));
  if (filters.yearTo && filters.yearTo !== filters.yearFrom) chips.push(filterChip(`to ${filters.yearTo}`, () => onClear('yearTo')));
  if (filters.libraryId) chips.push(filterChip(`library #${filters.libraryId}`, () => onClear('libraryId')));
  if (filters.contentRating) chips.push(filterChip(filters.contentRating, () => onClear('contentRating')));
  if (filters.tag) chips.push(filterChip(`#${filters.tag}`, () => onClear('tag')));
  if (filters.person) chips.push(filterChip(filters.person, () => onClear('person')));
  if (filters.favorites) chips.push(filterChip('♥ favorites', () => onClear('favorites')));
  if (filters.watched) chips.push(filterChip('✓ watched', () => onClear('watched')));
  if (filters.unwatched) chips.push(filterChip('◻ unwatched', () => onClear('unwatched')));
  if (filters.inProgress) chips.push(filterChip('▶ in progress', () => onClear('inProgress')));
  if (filters.sort && filters.sort !== defaultSort(kind)) chips.push(filterChip(`sort: ${SORTS.find((entry) => entry.value === filters.sort)?.label || filters.sort}`, () => onClear('sort')));
  return chips;
}

function buildGrid(items) {
  const grid = h('div', { class: 'grid poster-grid browse-grid', role: 'list' });
  for (const item of items) {
    const card = cardLink(item, { showKind: false });
    if (item.kind === 'photo') {
      const img = card.querySelector('img');
      if (img) img.src = artFor(item, 'thumb');
    }
    grid.append(h('div', { class: 'browse-cell', role: 'listitem' }, card));
  }
  return grid;
}

function skeletonGrid(count = 18) {
  return h('div', { class: 'grid poster-grid browse-grid skeleton-grid', 'aria-hidden': 'true' }, ...skeletonCards(count));
}

function errorState(message, retry) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'emoji' }, '💀'),
    h('h3', {}, 'The browse goblin choked'),
    h('p', {}, message),
    h('button', { class: 'btn primary', type: 'button', onclick: retry }, 'Try again'),
  );
}

export default async function render(container, ctx) {
  const kind = resolveKind(ctx.params, ctx.query);
  const meta = KINDS[kind];
  if (!meta) {
    container.append(emptyState('Unknown shelf', `"${kind}" is not a certified media kind. Skill issue.`, '🤨'));
    return;
  }
  document.title = `${meta.title} — ${state.branding?.serverName || 'AISlopMediaBox'}`;

  const filters = filtersFromQuery(ctx.query);
  let page = Math.max(1, Number(ctx.query.page) || 1);
  let total = 0;
  let items = [];
  let filterOptions = {};
  let disposed = false;
  let requestController = null;
  let loading = false;

  const root = h('div', { class: 'browse-view' });
  installArtFallback(root);
  const headTitle = h('h1', {}, meta.title);
  const countLabel = h('p', { class: 'sub' }, meta.kicker);
  const actions = h('div', { class: 'row wrap browse-head-actions' },
    h('a', { class: 'btn small ghost', href: '/search', 'data-link': true, 'data-focus': true }, '⌕ Search'),
    h('button', {
      class: 'btn small',
      type: 'button',
      'data-focus': true,
      onclick: () => { shuffle(); },
    }, '🎲 Surprise me'),
  );
  const header = h('header', { class: 'page-head browse-head' },
    h('div', {}, headTitle, countLabel),
    actions,
  );
  const filterHost = h('div', { class: 'browse-filters', 'aria-label': 'Filters' });
  const chipHost = h('div', { class: 'chip-row active-filters' });
  const gridHost = h('div', { class: 'browse-grid-host' }, skeletonGrid());
  const footHost = h('div', { class: 'browse-foot' });
  root.append(
    h('div', { class: 'browse-banner' },
      h('span', { class: 'pill accent' }, 'library'),
      h('span', { class: 'browse-joke' }, 'Filtering is just vibes with parameters.'),
    ),
    header,
    filterHost,
    chipHost,
    gridHost,
    footHost,
  );
  container.append(root);

  const setBusy = (busy) => { root.setAttribute('aria-busy', String(busy)); };
  const canLoadMore = () => items.length < total;
  const clearFilter = (key) => {
    if (key === 'yearFrom' || key === 'yearTo') {
      delete filters.yearFrom;
      delete filters.yearTo;
    } else {
      delete filters[key];
    }
    page = 1;
    syncUrl(filters, kind, page);
    load();
  };

  function shuffle() {
    filters.sort = 'random';
    delete filters.order;
    page = 1;
    syncUrl(filters, kind, page);
    load();
    toast('Chaos engaged. Good luck, soldier.', 'fun', { emoji: '🎲' });
  }

  function renderFilters() {
    const genres = normalizeStrings(filterOptions.genres).map((genre) => ({ value: genre, label: genre }));
    const years = yearsBetween(filterOptions.years);
    const libraries = normalizeLibraries(filterOptions.libraries);
    const ratings = normalizeStrings(filterOptions.contentRatings).map((rating) => ({ value: rating, label: rating }));
    const sortOptions = SORTS;
    const active = hasActiveFilters(filters, kind);

    const flagChip = (flag, label) => h('button', {
      class: `chip flag-chip${filters[flag] ? ' active' : ''}`,
      type: 'button',
      'data-focus': true,
      'aria-pressed': String(Boolean(filters[flag])),
      onclick: () => {
        if (filters[flag]) delete filters[flag];
        else {
          filters[flag] = true;
          for (const other of flag === 'favorites' ? [] : ['watched', 'unwatched', 'inProgress']) {
            if (other !== flag) delete filters[other];
          }
        }
        page = 1;
        syncUrl(filters, kind, page);
        renderFilters();
        load();
      },
    }, label);

    filterHost.replaceChildren(
      h('div', { class: 'filter-bar' },
        optionSelect('Genre', filters.genre || '', genres, (value) => {
          if (value) filters.genre = value; else delete filters.genre;
          page = 1; syncUrl(filters, kind, page); renderFilters(); load();
        }, { anyLabel: 'All genres' }),
        optionSelect('Year', filters.yearFrom === filters.yearTo ? filters.yearFrom || '' : filters.yearFrom || '', years, (value) => {
          if (value) { filters.yearFrom = value; filters.yearTo = value; } else { delete filters.yearFrom; delete filters.yearTo; }
          page = 1; syncUrl(filters, kind, page); renderFilters(); load();
        }, { anyLabel: 'Any year' }),
        optionSelect('Rating', filters.contentRating || '', ratings, (value) => {
          if (value) filters.contentRating = value; else delete filters.contentRating;
          page = 1; syncUrl(filters, kind, page); renderFilters(); load();
        }, { anyLabel: 'Any rating' }),
        optionSelect('Library', filters.libraryId || '', libraries, (value) => {
          if (value) filters.libraryId = value; else delete filters.libraryId;
          page = 1; syncUrl(filters, kind, page); renderFilters(); load();
        }, { anyLabel: 'All libraries' }),
        optionSelect('Sort', filters.sort || defaultSort(kind), sortOptions, (value) => {
          filters.sort = value;
          if (value === 'random' || value === defaultSort(kind)) delete filters.order;
          page = 1; syncUrl(filters, kind, page); renderFilters(); load();
        }, { anyLabel: 'Default' }),
      ),
      h('div', { class: 'filter-bar filter-flags' },
        flagChip('favorites', '♥ Favorites'),
        flagChip('watched', '✓ Watched'),
        flagChip('unwatched', '◻ Unwatched'),
        flagChip('inProgress', '▶ In progress'),
        h('span', { class: 'filter-spacer' }),
        h('button', {
          class: 'btn small ghost',
          type: 'button',
          disabled: !active,
          'data-focus': true,
          onclick: () => {
            for (const key of Object.keys(filters)) delete filters[key];
            page = 1;
            syncUrl(filters, kind, page);
            renderFilters();
            load();
          },
        }, 'Reset filters'),
        h('button', {
          class: 'chip sort-dir',
          type: 'button',
          title: filters.order === 'asc' ? 'Ascending' : 'Descending',
          'aria-label': filters.order === 'asc' ? 'Sort ascending' : 'Sort descending',
          'data-focus': true,
          onclick: () => {
            filters.order = filters.order === 'asc' ? 'desc' : 'asc';
            syncUrl(filters, kind, page);
            renderFilters();
            load();
          },
        }, filters.order === 'asc' ? '↑ ascending' : '↓ descending'),
      ),
    );
  }

  function renderChips() {
    chipHost.replaceChildren(...activeChips(filters, kind, clearFilter));
    chipHost.hidden = chipHost.childElementCount === 0;
  }

  function renderResults({ append = false, additions = items } = {}) {
    if (!items.length) {
      gridHost.replaceChildren(hasActiveFilters(filters, kind)
        ? emptyState('Nothing matches. L + ratio for your filters.', meta.empty, '🫠',
          { href: `/browse/${meta.slug}`, label: 'Clear filters' })
        : emptyState('Empty shelf. No thoughts, head empty.', state.user?.role === 'admin'
          ? 'Scan a library or add some files. The slop will not smuggle itself in.'
          : 'Nothing here yet. Ask an admin to feed the server.', '🫠',
          state.user?.role === 'admin' ? { href: '/admin#libraries', label: 'Add media' } : undefined));
      footHost.replaceChildren();
      countLabel.textContent = `0 titles · ${meta.kicker}`;
      return;
    }
    const fresh = buildGrid(additions);
    const existing = append ? gridHost.querySelector('.browse-grid') : null;
    if (existing) {
      for (const cell of [...fresh.children]) existing.append(cell);
    } else {
      gridHost.replaceChildren(fresh);
    }
    countLabel.textContent = `${total.toLocaleString()} ${total === 1 ? 'title' : 'titles'} · ${meta.kicker}`;

    footHost.replaceChildren();
    if (canLoadMore()) {
      footHost.append(h('div', { class: 'load-more' },
        h('button', {
          class: 'btn primary',
          type: 'button',
          'data-focus': true,
          onclick: () => { if (!loading) load({ append: true, nextPage: page + 1 }); },
        }, `Load more (${(total - items.length).toLocaleString()} left)`),
      ));
    } else {
      footHost.append(h('div', { class: 'browse-end faint mono' },
        items.length ? '— that is the whole shelf. Touch grass. —' : '— nothing to touch —',
      ));
    }
  }

  async function fetchFilters() {
    try {
      filterOptions = await get('/api/browse/filters', { signal: ctx.signal });
      filterOptions = filterOptions || {};
    } catch (error) {
      if (error?.name === 'AbortError') return;
      filterOptions = {};
    }
    if (!disposed) renderFilters();
  }

  async function load({ append = false, nextPage = 1 } = {}) {
    if (disposed) return;
    requestController?.abort();
    requestController = new AbortController();
    const controller = requestController;
    loading = true;
    setBusy(true);
    if (!append) {
      gridHost.replaceChildren(skeletonGrid(18));
      footHost.replaceChildren();
    }
    const request = { ...filters, kind, page: nextPage, pageSize: PAGE_SIZE };
    for (const flag of ['favorites', 'watched', 'unwatched', 'inProgress']) {
      if (request[flag]) request[flag] = '1';
    }
    if (kind === 'track') request.includeChildren = '1';
    try {
      const data = await get('/api/browse' + qs(request), { signal: controller.signal });
      if (disposed) return;
      const nextItems = Array.isArray(data?.items) ? data.items : [];
      if (append) items = items.concat(nextItems);
      else items = nextItems;
      total = Number(data?.total) || items.length;
      page = Number(data?.page) || nextPage;
      syncUrl(filters, kind, page);
      renderChips();
      renderResults({ append, additions: append ? nextItems : items });
    } catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      if (error?.status === 401) return;
      if (append && items.length) {
        toast(`Could not fetch more: ${error.message}`, 'error');
      } else {
        gridHost.replaceChildren(errorState(error.message || 'The server said no.', () => load()));
        countLabel.textContent = `0 titles · ${meta.kicker}`;
        footHost.replaceChildren();
        toast('Browse failed. The vibes are rancid.', 'error');
      }
    } finally {
      if (requestController === controller) {
        loading = false;
        setBusy(false);
      }
    }
  }

  await fetchFilters();
  await load();

  return () => {
    disposed = true;
    requestController?.abort();
  };
}
