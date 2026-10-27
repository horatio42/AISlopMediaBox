// Home — cinematic hero, resume rail, and every shelf worth scrolling.
import { artFor, fmtBytes, fmtClock, fmtDuration, get, memeLine, placeholderArt } from '../api.js';
import { state } from '../app.js';
import { navigate } from '../router.js';
import { emptyState, h, rail, skeletonCards, toast } from '../ui.js';

const HOME = '/api/browse/home';

function installArtFallback(scope) {
  scope.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.artFallback === '1') return;
    img.dataset.artFallback = '1';
    const kind = img.classList.contains('hero-bg-img') ? 'backdrop'
      : img.closest('.poster-card.landscape, .resume-card, .ep-thumb, .next-episode-card') ? 'thumb'
        : 'poster';
    img.src = placeholderArt(img.alt || img.src || 'slop', kind, img.alt || '');
  }, true);
}

function patchPhotoCards(scope, items) {
  const byId = new Map((items || []).map((item) => [String(item.id), item]));
  for (const card of scope.querySelectorAll('[data-media-id]')) {
    const item = byId.get(card.dataset.mediaId);
    if (item?.kind !== 'photo') continue;
    const img = card.querySelector('img');
    if (img) img.src = artFor(item, 'thumb');
  }
}

function heroSlides(data) {
  const seen = new Set();
  const slides = [];
  for (const item of [...(data.hero || []), ...(data.recentlyAdded || []), ...(data.rows || []).flatMap((row) => row.items || [])]) {
    if (!item || !['movie', 'show', 'episode', 'video'].includes(item.kind)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    slides.push(item);
    if (slides.length >= 12) break;
  }
  return slides;
}

function heroFacts(item) {
  return [
    item.year ? String(item.year) : '',
    item.contentRating || '',
    item.kind === 'episode' && item.seasonNumber != null ? `S${item.seasonNumber}E${item.episodeNumber}` : '',
    item.runtimeSeconds ? fmtDuration(item.runtimeSeconds) : '',
    item.rating ? `★ ${Number(item.rating).toFixed(1)}` : '',
  ].filter(Boolean);
}

function heroCopy(item, slides = []) {
  const index = Math.max(0, slides.indexOf(item));
  const resume = item.progress && !item.progress.finished && item.progress.positionSeconds > 30 ? item.progress : null;
  const playable = Boolean(item.playable || ['movie', 'episode', 'video'].includes(item.kind));
  return h('div', { class: 'hero-inner hero-copy', 'data-slide': index },
    h('div', { class: 'hero-kicker' },
      h('span', { class: 'pill accent' }, index === 0 ? 'tonight’s slop' : 'certified banger'),
      ...heroFacts(item).map((fact) => h('span', { class: 'pill' }, fact)),
    ),
    h('h1', { class: 'hero-title' }, item.title || 'Untitled slop'),
    item.tagline ? h('p', { class: 'hero-tagline' }, item.tagline) : null,
    item.description ? h('p', { class: 'hero-desc' }, item.description) : h('p', { class: 'hero-desc' }, memeLine(item.id / 17)),
    h('div', { class: 'hero-actions' },
      h('a', {
        class: 'btn primary',
        href: playable ? `/watch/${item.id}` : `/item/${item.id}`,
        'data-link': true,
        'data-focus': true,
      }, playable
        ? (resume ? `▶ Resume ${fmtClock(resume.positionSeconds)}` : '▶ Play')
        : 'Open details'),
      playable ? h('a', { class: 'btn', href: `/item/${item.id}`, 'data-link': true, 'data-focus': true }, 'More info') : null,
    ),
  );
}

function setupHero(hero, slides) {
  if (slides.length === 0) return { destroy() {}, show() {} };
  hero.classList.toggle('multi', slides.length > 1);

  const bgs = slides.map((item, index) => h('img', {
    class: `hero-bg-img${index === 0 ? ' active' : ''}`,
    src: artFor(item, 'backdrop'),
    alt: '',
    loading: index < 2 ? 'eager' : 'lazy',
    decoding: 'async',
    'aria-hidden': 'true',
  }));
  const stage = h('div', { class: 'hero-stage' }, ...bgs);
  const copyHost = h('div', { class: 'hero-copy-host', id: 'hero-copy' }, heroCopy(slides[0], slides));
  const dots = h('div', { class: 'hero-dots', role: 'tablist', 'aria-label': 'Featured titles' });
  const dotButtons = slides.map((item, index) => h('button', {
    class: `hero-dot${index === 0 ? ' active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-label': `Feature ${item.title}`,
    'aria-controls': 'hero-copy',
    'aria-selected': String(index === 0),
    onclick: () => { show(index); restart(); },
  }));
  dots.append(...dotButtons);
  hero.append(stage, copyHost, dots);
  if (slides.length > 1) {
    hero.append(h('div', { class: 'hero-progress' }, h('i', {})));
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let index = 0;
  let timer = null;
  let paused = false;
  let destroyed = false;

  const show = (next) => {
    index = (next + slides.length) % slides.length;
    bgs.forEach((img, i) => img.classList.toggle('active', i === index));
    dotButtons.forEach((dot, i) => {
      dot.classList.toggle('active', i === index);
      dot.setAttribute('aria-selected', String(i === index));
    });
    const copy = heroCopy(slides[index], slides);
    copy.classList.add('swapping');
    copyHost.replaceChildren(copy);
    requestAnimationFrame(() => copy.classList.remove('swapping'));
    const bar = hero.querySelector('.hero-progress > i');
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width = '0%';
      if (!paused && !reduce && !destroyed) {
        requestAnimationFrame(() => {
          bar.style.transition = 'width 8.6s linear';
          bar.style.width = '100%';
        });
      }
    }
  };

  const start = () => {
    if (reduce || slides.length < 2 || destroyed || paused) return;
    stop();
    timer = setInterval(() => show(index + 1), 8800);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const restart = () => { stop(); start(); };

  const pause = () => {
    paused = true;
    stop();
    hero.classList.add('paused');
  };
  const resume = () => {
    paused = false;
    hero.classList.remove('paused');
    start();
  };
  let hovering = false;
  let focused = false;
  const maybeResume = () => {
    if (!hovering && !focused) resume();
    else pause();
  };
  const onMouseEnter = () => { hovering = true; pause(); };
  const onMouseLeave = () => { hovering = false; maybeResume(); };
  const onFocusIn = () => { focused = true; pause(); };
  const onFocusOut = (event) => {
    if (hero.contains(event.relatedTarget)) return;
    focused = false;
    maybeResume();
  };
  const onVisibility = () => { if (document.hidden) stop(); else maybeResume(); };
  hero.addEventListener('mouseenter', onMouseEnter);
  hero.addEventListener('mouseleave', onMouseLeave);
  hero.addEventListener('focusin', onFocusIn);
  hero.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', onVisibility);

  show(0);
  start();

  return {
    show,
    restart,
    destroy() {
      destroyed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      hero.removeEventListener('mouseenter', onMouseEnter);
      hero.removeEventListener('mouseleave', onMouseLeave);
      hero.removeEventListener('focusin', onFocusIn);
      hero.removeEventListener('focusout', onFocusOut);
    },
  };
}

function resumeRail(items) {
  if (!items?.length) return null;
  const scroller = h('div', { class: 'rail', role: 'list' });
  for (const item of items) {
    const position = item.progress?.positionSeconds || 0;
    const duration = item.progress?.durationSeconds || item.runtimeSeconds || 0;
    const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    const wrapper = h('div', { class: 'resume-card', role: 'listitem' },
      h('a', {
        class: 'poster-card landscape',
        href: `/item/${item.id}`,
        'data-link': true,
        'data-focus': true,
        'data-media-id': item.id,
        title: `Resume ${item.title}`,
      },
        h('div', { class: 'poster' },
          h('img', { src: artFor(item, 'thumb'), alt: '', loading: 'lazy', decoding: 'async' }),
          h('div', { class: 'poster-play' }, '▶'),
          h('div', { class: 'poster-badges' },
            item.kind === 'episode' && item.showTitle ? h('span', { class: 'pill accent' }, item.showTitle) : null,
            h('span', { class: 'pill hot' }, 'resume'),
          ),
          pct > 0 ? h('div', { class: 'progress-bar' }, h('i', { style: { width: `${pct}%` } })) : null,
        ),
        h('div', { class: 'title clamp-2' }, item.title || 'Untitled slop'),
        h('div', { class: 'meta truncate' },
          item.kind === 'episode' && item.seasonNumber != null ? `S${item.seasonNumber}E${item.episodeNumber} · ` : '',
          `paused at ${fmtClock(position)}`,
        ),
      ),
      h('button', {
        class: 'resume-play',
        type: 'button',
        'data-focus': true,
        'aria-label': `Resume ${item.title}`,
        onclick: () => navigate(item.kind === 'track'
          ? (item.albumId ? `/music?album=${item.albumId}` : `/music?track=${item.id}`)
          : `/watch/${item.id}`),
      }, `▶ resume · ${fmtClock(Math.max(0, duration - position))} left`),
    );
    scroller.append(wrapper);
  }
  return h('section', { class: 'section', 'data-rail': 'Continue Watching' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Continue watching'),
      h('span', { class: 'count' }, `${items.length} half-watched`),
      h('span', { class: 'section-joke' }, memeLine(0.34)),
    ),
    h('div', { class: 'rail-wrap' }, scroller),
  );
}

function collectionCards(collections) {
  if (!collections?.length) return null;
  const grid = h('div', { class: 'collection-grid' });
  for (const collection of collections) {
    const art = collection.art?.poster || placeholderArt(`collection:${collection.id}:${collection.name}`, 'poster', collection.name);
    grid.append(h('a', {
      class: 'collection-card home-collection',
      href: `/collections/${collection.id}`,
      'data-link': true,
      'data-focus': true,
    },
      h('div', { class: 'bg', style: { backgroundImage: `url("${art}")` } }),
      h('div', { class: 'body' },
        h('strong', {}, collection.name),
        h('span', {}, `${collection.itemCount || 0} titles · ${collection.kind === 'smart' ? 'auto-curated' : 'hand-picked'}`),
      ),
    ));
  }
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Collections'),
      h('span', { class: 'count' }, 'curated by your fellow gremlins'),
      h('a', { class: 'mini-link', href: '/collections', 'data-link': true, style: { marginLeft: 'auto' } }, 'See all'),
    ),
    grid,
  );
}

function genreRow(genres) {
  const names = (genres || []).map((genre) => (typeof genre === 'string' ? genre : genre.genre || genre.name)).filter(Boolean);
  if (!names.length) return null;
  return h('section', { class: 'section genre-section' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Browse by vibes'),
      h('span', { class: 'count' }, 'genre roulette, but curated'),
    ),
    h('div', { class: 'chip-row' }, ...names.map((genre) => h('a', {
      class: 'chip genre-chip',
      href: `/browse/movies?genre=${encodeURIComponent(genre)}`,
      'data-link': true,
      'data-focus': true,
    }, genre))),
  );
}

function statsStrip(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const entries = [
    ['movies', stats.movies],
    ['shows', stats.shows],
    ['episodes', stats.episodes],
    ['albums', stats.albums],
    ['tracks', stats.tracks],
    ['photos', stats.photos],
    ['storage', stats.totalBytes ? fmtBytes(stats.totalBytes) : null],
  ].filter(([, value]) => value !== undefined && value !== null && value !== 0);
  if (!entries.length) return null;
  return h('div', { class: 'home-stats' }, ...entries.map(([label, value]) => h('div', { class: 'home-stat' },
    h('span', { class: 'label' }, label),
    h('strong', { class: 'value' }, typeof value === 'number' ? value.toLocaleString() : value),
  )));
}

function renderHome(root, data, ctx, hero) {
  root.replaceChildren();
  root.dataset.loaded = '1';
  const slides = heroSlides(data);
  const heroEl = h('section', { class: 'hero home-hero', 'aria-label': 'Featured titles' });
  root.append(heroEl);

  const stats = statsStrip(data.stats);
  if (stats) root.append(stats);

  const controls = setupHero(heroEl, slides);
  if (!slides.length) heroEl.remove();

  const resume = resumeRail(data.continueWatching || data.inProgress || []);
  if (resume) root.append(resume);

  const recent = data.recentlyAdded || [];
  if (recent.length) {
    const recentSection = rail('Recently added', recent, { action: { href: '/browse/movies?sort=added', label: 'All fresh slop' }, count: recent.length });
    patchPhotoCards(recentSection, recent);
    root.append(recentSection);
  }

  const skip = new Set(['continue watching', 'recently added']);
  for (const collection of data.collections || []) {
    if (collection?.name) skip.add(String(collection.name).toLowerCase());
  }
  for (const row of data.rows || []) {
    if (!row?.items?.length) continue;
    if (skip.has(String(row.title || '').toLowerCase())) continue;
    const rowSection = rail(row.title || 'More slop', row.items, { action: rowAction(row), landscape: row.kind === 'episode' || row.landscape });
    patchPhotoCards(rowSection, row.items);
    root.append(rowSection);
  }

  const collections = collectionCards(data.collections || []);
  if (collections) root.append(collections);
  const genreSection = genreRow(data.genres || []);
  if (genreSection) root.append(genreSection);

  if (!slides.length && !recent.length && !(data.rows || []).some((row) => row.items?.length) && !(data.collections || []).length) {
    const isAdmin = state.user?.role === 'admin';
    root.append(emptyState(
      'The library is empty. No thoughts, head empty.',
      isAdmin
        ? 'Point a library at a folder and hit scan. Your slop awaits sweet release.'
        : 'Nothing scanned yet. Ping your admin — they are probably touching grass.',
      '🫠',
      isAdmin ? { href: '/admin#libraries', label: 'Add a library' } : undefined,
    ));
  }
  return controls;
}

function rowAction(row) {
  const kindMap = { movie: 'movies', show: 'shows', episode: 'shows', album: 'music', artist: 'music', track: 'music', photo: 'photos', video: 'videos' };
  const slug = kindMap[row.kind] || 'movies';
  if (slug === 'music') return { href: '/music', label: 'Open music' };
  if (slug === 'photos') return { href: '/photos', label: 'Open photos' };
  const genre = row.id && typeof row.id === 'string' && row.id.includes(':') ? row.id.split(':').slice(1).join(':') : '';
  return { href: `/browse/${slug}${genre ? `?genre=${encodeURIComponent(genre)}` : ''}`, label: 'See all' };
}

function skeletonHome(root) {
  root.replaceChildren(
    h('div', { class: 'hero skeleton hero-skeleton', 'aria-hidden': 'true' }),
    h('section', { class: 'section', 'aria-hidden': 'true' },
      h('div', { class: 'section-head' }, h('div', { class: 'skeleton', style: { height: '20px', width: '180px' } })),
      h('div', { class: 'rail' }, ...skeletonCards(7, true)),
    ),
    ...Array.from({ length: 2 }, () => h('section', { class: 'section', 'aria-hidden': 'true' },
      h('div', { class: 'section-head' }, h('div', { class: 'skeleton', style: { height: '20px', width: '140px' } })),
      h('div', { class: 'rail' }, ...skeletonCards(8)),
    )),
  );
  root.setAttribute('aria-busy', 'true');
}

export default async function render(container, ctx) {
  const root = h('div', { class: 'home-view' });
  document.title = `${state.branding?.serverName || 'AISlopMediaBox'} — certified slop`;
  installArtFallback(root);
  container.append(root);
  skeletonHome(root);

  let heroControls = null;
  let refreshTimer = null;
  let disposed = false;

  const load = async ({ quiet = false } = {}) => {
    try {
      const data = await get(HOME, { signal: ctx.signal });
      if (disposed) return;
      heroControls?.destroy();
      heroControls = renderHome(root, data || {}, ctx);
      root.removeAttribute('aria-busy');
    } catch (error) {
      if (error?.name === 'AbortError' || disposed) return;
      if (quiet) {
        toast(`Could not refresh home: ${error.message}`, 'error');
        return;
      }
      root.removeAttribute('aria-busy');
      const failure = emptyState('The home screen took a nap', error.message || 'Server said no. Rude.', '💀');
      failure.append(h('button', { class: 'btn primary', type: 'button', onclick: () => { skeletonHome(root); load(); } }, 'Try again'));
      root.replaceChildren(failure);
    }
  };

  const scheduleQuietRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!document.hidden) load({ quiet: true });
    }, 900);
  };

  const onScanDone = (event) => {
    const detail = event.detail || {};
    if (detail.status === 'done' || detail.ok) scheduleQuietRefresh();
  };

  window.addEventListener('slop:scan-done', onScanDone);
  window.addEventListener('slop:media-changed', scheduleQuietRefresh);

  await load();

  if (ctx.meta?.tv && !document.body.classList.contains('tv-mode')) {
    // /tv renders the same shelves; nudge focus to the first actionable card.
    requestAnimationFrame(() => container.querySelector('.hero-actions a, [data-focus]')?.focus());
  }

  return () => {
    disposed = true;
    clearTimeout(refreshTimer);
    heroControls?.destroy();
    window.removeEventListener('slop:scan-done', onScanDone);
    window.removeEventListener('slop:media-changed', scheduleQuietRefresh);
  };
}
