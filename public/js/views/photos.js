// Photos: month-grouped timeline, folder chips, CSS-column masonry, lazy thumbs,
// and a keyboard/touch lightbox with zoom, metadata, download, and slideshow.
import { get, fmtBytes, fmtDate } from '../api.js';
import { h, toast, emptyState } from '../ui.js';

const PAGE = 48;

function photoDate(photo) {
  return photo?.captureDate || photo?.addedAt || photo?.releaseDate || photo?.createdAt || '';
}

function monthKeyOf(photo) {
  const date = new Date(photoDate(photo));
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabelOf(key) {
  if (!key || key === 'unknown') return 'Undated slop';
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function monthBounds(group) {
  let year = Number(group?.year);
  let month = Number(group?.month);
  if (!year || !month) {
    const parsed = String(group?.key || '').match(/^(\d{4})-(\d{1,2})/);
    if (parsed) { year = Number(parsed[1]); month = Number(parsed[2]); }
  }
  if (!year || !month) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1) - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function thumbUrl(photo) {
  return photo?.art?.thumb || `/api/photos/${photo?.id}/file`;
}

function photoTitle(photo) {
  return photo?.title || photo?.filename || `Photo ${photo?.id ?? ''}`;
}

function folderHref(path, libraryId) {
  const params = new URLSearchParams();
  if (path) params.set('folder', path);
  else if (libraryId) params.set('folder', '');
  if (libraryId) params.set('libraryId', String(libraryId));
  const query = params.toString();
  return query ? `/photos?${query}` : '/photos';
}

export default async function render(container, ctx) {
  const folder = typeof ctx.query.folder === 'string' ? ctx.query.folder : '';
  const libraryId = Number(ctx.query.libraryId) || null;
  const folderMode = typeof ctx.query.folder === 'string' || Boolean(libraryId);
  const view = {
    folder, libraryId, folderMode, months: [], folders: [], flatItems: [], flatTotal: 0, flatPage: 1,
    ordered: [], photoByMonth: new Map(), observer: null, lightbox: null,
    abort: new AbortController(), slideshow: null,
  };
  container.replaceChildren(h('div', { class: 'photos-loading' }, h('span', { class: 'spinner' }), 'developing the film…'));

  const [timelineResult, foldersResult] = await Promise.allSettled([
    get('/api/photos/timeline', { signal: ctx.signal }),
    get('/api/photos/folders', { signal: ctx.signal }),
  ]);
  if (ctx.signal?.aborted) return undefined;

  const timelineRaw = timelineResult.status === 'fulfilled' ? timelineResult.value : null;
  view.folders = foldersResult.status === 'fulfilled'
    ? foldersResult.value?.folders || foldersResult.value?.items || []
    : [];
  let groups = timelineRaw?.groups || timelineRaw?.months || [];
  if (!groups.length && Array.isArray(timelineRaw?.items)) groups = groupPhotos(timelineRaw.items);

  if (folderMode) {
    await loadFlat(view, ctx, { page: 1, replace: true });
  } else if (!groups.length) {
    const fallback = await get('/api/photos?pageSize=120&sort=captured', { signal: ctx.signal }).catch(() => null);
    const items = fallback?.items || [];
    groups = groupPhotos(items);
    view.flatItems = items;
    view.flatTotal = Number(fallback?.total) || items.length;
    view.flatPage = 1;
  }
  if (ctx.signal?.aborted) return undefined;

  view.months = groups.map((group) => normalizeGroup(group));
  buildLayout(view, ctx, container);

  view.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const model = view.months.find((month) => month.section === entry.target);
      if (!model || model.loaded || model.loading) continue;
      loadMonth(view, model, ctx).catch(() => {});
    }
  }, { rootMargin: '600px 0px' });
  if (!view.folderMode) {
    for (const month of view.months) {
      if (month.items?.length) {
        appendMonthPhotos(view, month, month.items);
      } else if (month.section) {
        view.observer.observe(month.section);
      }
    }
  }

  const cleanup = () => {
    view.observer?.disconnect();
    view.abort.abort();
    closeLightbox(view, { silent: true });
    document.body.classList.remove('photo-lightbox-open');
  };
  return cleanup;
}

function normalizeGroup(group) {
  const key = group.key || (group.year && group.month ? `${group.year}-${String(group.month).padStart(2, '0')}` : 'unknown');
  return {
    key,
    label: group.label || monthLabelOf(key),
    year: group.year,
    month: group.month,
    count: Number(group.count ?? group.items?.length ?? 0),
    cover: group.cover || group.items?.[0] || null,
    items: Array.isArray(group.items) ? group.items : [],
    photos: [],
    page: 0,
    loaded: Array.isArray(group.items) && group.items.length > 0,
    loading: false,
    total: Number(group.count ?? group.items?.length ?? 0),
    section: null,
    columns: null,
    status: null,
  };
}

function groupPhotos(items) {
  const map = new Map();
  for (const photo of items) {
    const key = monthKeyOf(photo);
    if (!map.has(key)) map.set(key, { key, label: monthLabelOf(key), count: 0, cover: photo, items: [] });
    const group = map.get(key);
    group.items.push(photo);
    group.count += 1;
  }
  return [...map.values()].sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

function buildLayout(view, ctx, container) {
  const count = view.folderMode ? view.flatTotal : view.months.reduce((sum, month) => sum + month.total, 0);
  const chipRow = h('div', { class: 'chip-row photo-folders' },
    h('a', {
      class: `chip${view.folderMode ? '' : ' active'}`, href: '/photos', 'data-link': true,
    }, 'All photos'),
    ...view.folders.map((entry) => {
      const path = entry.path || '';
      const active = view.folderMode && path === view.folder
        && (!view.libraryId || Number(entry.libraryId) === Number(view.libraryId));
      return h('a', {
        class: `chip${active ? ' active' : ''}`,
        href: folderHref(path, entry.libraryId), 'data-link': true,
        title: path || 'library root',
      }, entry.name || path || 'root', h('span', { class: 'chip-count' }, String(entry.count ?? '')));
    }),
  );

  const shell = h('div', { class: 'photos-view' },
    h('header', { class: 'page-head photos-head' },
      h('div', {},
        h('span', { class: 'eyebrow' }, 'photos'),
        h('h1', {}, 'The camera roll'),
        h('p', { class: 'sub' }, [ `${count} photos`, view.folderMode ? `folder: ${view.folder || 'library root'}` : 'grouped by month', 'zero cloud storage fees' ].join(' · '))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', type: 'button', onclick: () => startSlideshowFromGrid(view) }, '▶ Slideshow'),
        view.folderMode ? h('a', { class: 'btn ghost', href: '/photos', 'data-link': true }, 'Clear filter') : null)),
    chipRow,
    view.body = h('div', { class: 'photo-timeline' }),
  );
  view.container = shell;
  container.replaceChildren(shell);
  document.title = 'Photos — slop';
  if (!view.months.length && !view.flatItems.length) {
    view.body.replaceChildren(emptyState('No photos. No memories.', 'Scan a photo library, or go outside and make some. Touch grass, but bring a camera.', '📷'));
    return;
  }
  if (view.folderMode) {
    view.body.replaceChildren(h('div', { class: 'photo-folder-head' },
      h('span', { class: 'pill accent' }, `${view.flatTotal} photos`),
      h('span', { class: 'faint small' }, view.folder || 'library root')));
    renderFlat(view, ctx);
  } else {
    for (const month of view.months) {
      month.section = createMonthSection(view, month, ctx);
      view.body.append(month.section);
    }
  }
}

function createMonthSection(view, month, ctx) {
  const heading = h('div', { class: 'photo-month-head' },
    h('h2', {}, month.label),
    h('span', { class: 'pill' }, `${month.total} photos`));
  month.status = h('div', { class: 'photo-month-status' }, h('span', { class: 'spinner' }), h('span', {}, 'loading'));
  month.columns = h('div', { class: 'photo-columns' });
  const section = h('section', { class: 'photo-month', 'data-month': month.key }, heading, month.columns, month.status);
  return section;
}

async function loadMonth(view, month, ctx, { more = false } = {}) {
  if (month.loading) return;
  const bounds = monthBounds({ key: month.key, year: month.year, month: month.month });
  if (!bounds) { month.loaded = true; month.status?.remove(); return; }
  month.loading = true;
  month.page += 1;
  try {
    const page = await get(`/api/photos?from=${encodeURIComponent(bounds.from)}&to=${encodeURIComponent(bounds.to)}&page=${month.page}&pageSize=${PAGE}&sort=captured`, { signal: ctx.signal });
    const items = page?.items || [];
    month.total = Number(page?.total) || month.total || items.length;
    month.loaded = true;
    appendMonthPhotos(view, month, items);
    if (!items.length && month.page === 1) {
      month.columns.append(h('p', { class: 'muted small' }, 'This month is empty. Ghost month.'));
    }
    month.status?.replaceChildren();
    if (month.photos.length < month.total) {
      month.status?.append(h('button', {
        class: 'btn small', type: 'button',
        onclick: () => loadMonth(view, month, ctx, { more: true }).catch(() => {}),
      }, `Load more (${month.photos.length}/${month.total})`));
    }
    view.observer?.unobserve(month.section);
  } catch (error) {
    if (error.name === 'AbortError') return;
    month.loading = false;
    month.page = Math.max(0, month.page - 1);
    month.status?.replaceChildren(h('button', {
      class: 'btn small', type: 'button',
      onclick: () => loadMonth(view, month, ctx).catch(() => {}),
    }, 'Retry this month'));
    toast(error.message || 'Month refused to load.', 'error');
  } finally {
    month.loading = false;
  }
}

function appendMonthPhotos(view, month, items) {
  if (!month.columns || !items?.length) return;
  const newTiles = items.map((photo) => photoTile(view, photo));
  month.columns.append(...newTiles);
  month.photos.push(...items);
  for (const photo of items) { view.ordered.push(photo); }
}

function photoTile(view, photo) {
  const img = h('img', {
    src: thumbUrl(photo),
    alt: photoTitle(photo),
    loading: 'lazy',
    decoding: 'async',
    width: photo.width || undefined,
    height: photo.height || undefined,
  });
  img.addEventListener('error', () => {
    img.onerror = null;
    if (!img.src.endsWith(`/api/photos/${photo.id}/file`)) img.src = `/api/photos/${photo.id}/file`;
  }, { once: true });
  return h('button', {
    class: 'photo-tile', type: 'button', 'data-focus': true,
    'aria-label': `Open ${photoTitle(photo)}`,
    onclick: () => openLightbox(view, photo),
  },
    img,
    h('span', { class: 'photo-zoom', 'aria-hidden': 'true' }, '⤢'));
}

async function loadFlat(view, ctx, { page = 1 } = {}) {
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: '120', sort: 'captured' });
    if (view.folderMode) params.set('folder', view.folder);
    if (view.libraryId) params.set('libraryId', String(view.libraryId));
    const raw = await get(`/api/photos?${params.toString()}`, { signal: ctx.signal });
    const items = raw?.items || [];
    if (page === 1) { view.flatItems = items; view.flatPage = 1; }
    else { view.flatItems.push(...items); view.flatPage = page; }
    view.flatTotal = Number(raw?.total) || view.flatItems.length;
    view.flatError = null;
  } catch (error) {
    if (error.name === 'AbortError') return;
    view.flatError = error;
    view.flatItems = [];
    view.flatTotal = 0;
  }
}

function renderFlat(view, ctx) {
  for (const node of view.body.querySelectorAll('.photo-month, .photo-flat-status, .photo-folder-empty')) node.remove();
  if (view.flatError) {
    view.body.append(h('div', { class: 'photo-folder-empty' },
      emptyState('Folder filter failed', view.flatError.message || 'The photos API said no.', '💀'),
      h('button', { class: 'btn', type: 'button', onclick: () => { loadFlat(view, ctx).then(() => renderFlat(view, ctx)).catch(() => {}); } }, 'Retry')));
    return;
  }
  view.ordered = [];
  const groups = groupPhotos(view.flatItems).sort((a, b) => String(b.key).localeCompare(String(a.key)));
  for (const group of groups) {
    const month = normalizeGroup(group);
    month.loaded = true;
    month.section = createMonthSection(view, month, ctx);
    month.status.remove();
    view.body.append(month.section);
    appendMonthPhotos(view, month, group.items);
  }
  const status = h('div', { class: 'photo-flat-status' });
  if (view.flatItems.length < view.flatTotal) {
    status.append(h('button', {
      class: 'btn', type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Loading…';
        await loadFlat(view, ctx, { page: view.flatPage + 1 });
        renderFlat(view, ctx);
      },
    }, `Load more (${view.flatItems.length}/${view.flatTotal})`));
  } else if (view.flatItems.length) {
    status.append(h('span', { class: 'faint small' }, 'That is the whole roll. Go touch some grass.'));
  } else {
    view.body.append(h('div', { class: 'photo-folder-empty' },
      emptyState('Nothing in this folder', 'Zero photos. The folder is a vibe, not a collection.', '📷')));
  }
  view.body.append(status);
}

function startSlideshowFromGrid(view) {
  const photo = view.ordered[0] || view.months.find((month) => month.photos.length)?.photos[0];
  if (!photo) {
    toast('Nothing loaded to slideshow yet. Scroll a little.', 'info', { emoji: '📷' });
    return;
  }
  openLightbox(view, photo, { slideshow: true });
}

function mergePhotoMeta(item, data) {
  return {
    ...item,
    captureDate: data?.captureDate || item?.captureDate,
    folder: data?.folder ?? item?.folder,
    filename: data?.filename || item?.filename,
    width: item?.width || data?.width,
    height: item?.height || data?.height,
    sizeBytes: item?.sizeBytes || data?.sizeBytes,
  };
}

function openLightbox(view, photo, { slideshow = false } = {}) {
  if (!photo?.id) return;
  closeLightbox(view, { silent: true });
  const ac = new AbortController();
  const lb = {
    current: photo, detail: null, zoomed: false, infoOpen: false, slideshow: false,
    timer: null, ac, stepping: false,
  };
  const img = h('img', { class: 'plb-img', alt: photoTitle(photo), decoding: 'async' });
  const spinner = h('span', { class: 'plb-spinner spinner', 'aria-label': 'Loading photo' });
  const error = h('div', { class: 'plb-error', hidden: true }, h('span', { 'aria-hidden': 'true' }, '🫥'), h('p', {}, 'This file refused to load. It is shy.'));
  const stage = h('figure', { class: 'plb-stage' }, img, spinner, error);
  const title = h('span', { class: 'plb-title' }, photoTitle(photo));
  const date = h('span', { class: 'plb-date' }, fmtDate(photoDate(photo), true));
  const counter = h('span', { class: 'plb-counter' });
  const info = h('aside', { class: 'plb-info', hidden: true, 'aria-label': 'Photo metadata' });
  const prevBtn = h('button', { class: 'plb-nav prev', type: 'button', 'aria-label': 'Previous photo', disabled: true, onclick: () => stepLightbox(view, -1) }, '‹');
  const nextBtn = h('button', { class: 'plb-nav next', type: 'button', 'aria-label': 'Next photo', disabled: true, onclick: () => stepLightbox(view, 1) }, '›');
  const zoomBtn = h('button', { class: 'plb-tool', type: 'button', 'aria-label': 'Toggle zoom', 'aria-pressed': 'false', onclick: () => toggleLightboxZoom(view) }, '⤢');
  const infoBtn = h('button', { class: 'plb-tool', type: 'button', 'aria-label': 'Photo info', 'aria-pressed': 'false', onclick: () => toggleLightboxInfo(view) }, 'ⓘ');
  const slideBtn = h('button', { class: 'plb-tool', type: 'button', 'aria-label': 'Start slideshow', 'aria-pressed': 'false', onclick: () => toggleLightboxSlideshow(view) }, '▶');
  const download = h('a', { class: 'plb-tool', href: `/api/photos/${photo.id}/file?download=1`, download: '', 'aria-label': 'Download photo' }, '⇩');
  const closeBtn = h('button', { class: 'plb-close icon-btn', type: 'button', 'aria-label': 'Close photo (Esc)', onclick: () => closeLightbox(view) }, '✕');

  Object.assign(lb, { overlay: null, img, spinner, error, title, date, counter, info, prevBtn, nextBtn, zoomBtn, infoBtn, slideBtn, download, stage });
  const overlay = h('div', { class: 'photo-lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${photoTitle(photo)} photo viewer` },
    h('header', { class: 'plb-top' },
      closeBtn,
      h('div', { class: 'plb-crumb', style: { minWidth: '0' } }, title, date),
      counter),
    prevBtn,
    stage,
    nextBtn,
    info,
    h('footer', { class: 'plb-bar' },
      h('button', { class: 'plb-tool', type: 'button', 'aria-label': 'Previous photo', onclick: () => stepLightbox(view, -1) }, '‹ prev'),
      h('button', { class: 'plb-tool', type: 'button', 'aria-label': 'Next photo', onclick: () => stepLightbox(view, 1) }, 'next ›'),
      zoomBtn, infoBtn, slideBtn, download),
  );
  lb.overlay = overlay;
  document.body.append(overlay);
  document.body.classList.add('photo-lightbox-open');
  view.lightbox = lb;

  img.addEventListener('load', () => { lb.spinner.hidden = true; lb.error.hidden = true; });
  img.addEventListener('error', () => { lb.spinner.hidden = true; lb.error.hidden = false; });
  stage.addEventListener('click', (event) => {
    if (lb.ignoreClick || event.target.closest('button, a')) return;
    const rect = stage.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    toggleLightboxZoom(view, { x, y });
  });
  let swipe = null;
  stage.addEventListener('pointerdown', (event) => { if (!lb.zoomed) swipe = { x: event.clientX, y: event.clientY }; }, { signal: ac.signal });
  stage.addEventListener('pointerup', (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 55 && Math.abs(dy) < 90) {
      lb.ignoreClick = true;
      setTimeout(() => { lb.ignoreClick = false; }, 60);
      stepLightbox(view, dx < 0 ? 1 : -1);
    }
  }, { signal: ac.signal });
  document.addEventListener('keydown', (event) => onLightboxKey(view, event), { signal: ac.signal });

  refreshLightbox(view, photo);
  loadPhotoDetail(view, photo.id);
  closeBtn.focus({ preventScroll: true });
  if (slideshow) toggleLightboxSlideshow(view);
}

function refreshLightbox(view, photo) {
  const lb = view.lightbox;
  if (!lb || !photo) return;
  lb.current = photo;
  const same = String(lb.lastId) === String(photo.id);
  lb.lastId = photo.id;
  if (!same) lb.img.src = `/api/photos/${photo.id}/file`;
  lb.img.classList.toggle('is-zoomed', lb.zoomed);
  lb.download.href = `/api/photos/${photo.id}/file?download=1`;
  lb.title.textContent = photoTitle(photo);
  lb.date.textContent = fmtDate(photoDate(photo), true);
  const index = view.ordered.findIndex((entry) => String(entry.id) === String(photo.id));
  lb.counter.textContent = index >= 0 ? `${index + 1} / ${view.ordered.length}` : (photo.folder ? 'folder view' : '');
  const detail = lb.detail && String(lb.detail.item?.id ?? lb.detail.id ?? '') === String(photo.id) ? lb.detail : null;
  lb.prevBtn.disabled = detail ? !detail.prevId : true;
  lb.nextBtn.disabled = detail ? !detail.nextId : true;
  if (!same) {
    lb.spinner.hidden = false;
    lb.error.hidden = true;
  } else {
    lb.spinner.hidden = Boolean(lb.img.complete);
  }
  renderLightboxInfo(view, photo);
}

async function loadPhotoDetail(view, id) {
  const lb = view.lightbox;
  if (!lb) return;
  try {
    const data = await get(`/api/photos/${id}`, { signal: lb.ac.signal });
    if (!view.lightbox || view.lightbox !== lb) return;
    lb.detail = data;
    const photo = mergePhotoMeta(data.item || lb.current, data);
    refreshLightbox(view, photo);
  } catch (error) {
    if (error.name === 'AbortError') return;
    lb.spinner.hidden = true;
    toast(error.message || 'Could not fetch photo details.', 'error');
  }
}

async function stepLightbox(view, direction) {
  const lb = view.lightbox;
  if (!lb || lb.stepping || !lb.detail) return;
  const targetId = direction > 0 ? lb.detail.nextId : lb.detail.prevId;
  if (!targetId) {
    if (direction > 0) stopLightboxSlideshow(view);
    return;
  }
  lb.stepping = true;
  try {
    const data = await get(`/api/photos/${targetId}`, { signal: lb.ac.signal });
    if (!view.lightbox || view.lightbox !== lb) return;
    lb.detail = data;
    const photo = mergePhotoMeta(data.item || { id: targetId }, data);
    refreshLightbox(view, photo);
  } catch (error) {
    if (error.name === 'AbortError') return;
    toast(error.message || 'That photo direction is blocked.', 'error');
    stopLightboxSlideshow(view);
  } finally {
    lb.stepping = false;
  }
}

function renderLightboxInfo(view, photo) {
  const lb = view.lightbox;
  if (!lb) return;
  const capture = photo?.captureDate || photoDate(photo);
  const rows = [
    ['File', photo?.filename || photoTitle(photo)],
    ['Captured', capture ? fmtDate(capture, true) : '—'],
    ['Resolution', photo?.width && photo?.height ? `${photo.width} × ${photo.height}` : 'unknown'],
    ['Size', photo?.sizeBytes ? fmtBytes(photo.sizeBytes) : '—'],
    ['Folder', photo?.folder || 'library root'],
    ['Format', photo?.container || '—'],
  ];
  lb.info.replaceChildren(
    h('h3', {}, 'Metadata'),
    h('dl', { class: 'kv' }, ...rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, String(value))])));
}

function toggleLightboxZoom(view, origin) {
  const lb = view.lightbox;
  if (!lb) return;
  lb.zoomed = !lb.zoomed;
  lb.img.classList.toggle('is-zoomed', lb.zoomed);
  lb.img.style.transformOrigin = lb.zoomed && origin ? `${origin.x}% ${origin.y}%` : 'center';
  lb.zoomBtn.classList.toggle('active', lb.zoomed);
  lb.zoomBtn.setAttribute('aria-pressed', lb.zoomed ? 'true' : 'false');
}

function toggleLightboxInfo(view) {
  const lb = view.lightbox;
  if (!lb) return;
  lb.infoOpen = !lb.infoOpen;
  lb.info.hidden = !lb.infoOpen;
  lb.infoBtn.classList.toggle('active', lb.infoOpen);
  lb.infoBtn.setAttribute('aria-pressed', lb.infoOpen ? 'true' : 'false');
}

function toggleLightboxSlideshow(view) {
  const lb = view.lightbox;
  if (!lb) return;
  if (lb.slideshow) stopLightboxSlideshow(view);
  else {
    lb.slideshow = true;
    lb.slideBtn.textContent = '❚❚';
    lb.slideBtn.classList.add('active');
    lb.slideBtn.setAttribute('aria-pressed', 'true');
    lb.slideBtn.setAttribute('aria-label', 'Stop slideshow');
    lb.timer = setInterval(() => stepLightbox(view, 1), 5000);
  }
}

function stopLightboxSlideshow(view) {
  const lb = view.lightbox;
  if (!lb) return;
  clearInterval(lb.timer);
  lb.timer = null;
  lb.slideshow = false;
  lb.slideBtn.textContent = '▶';
  lb.slideBtn.classList.remove('active');
  lb.slideBtn.setAttribute('aria-pressed', 'false');
  lb.slideBtn.setAttribute('aria-label', 'Start slideshow');
}

function onLightboxKey(view, event) {
  const target = event.target;
  if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
  if (event.key === 'Escape') { event.preventDefault(); closeLightbox(view); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); stepLightbox(view, -1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); stepLightbox(view, 1); }
  else if (event.key.toLowerCase() === 'z') { event.preventDefault(); toggleLightboxZoom(view); }
  else if (event.key.toLowerCase() === 'i') { event.preventDefault(); toggleLightboxInfo(view); }
  else if (event.key.toLowerCase() === 's') { event.preventDefault(); toggleLightboxSlideshow(view); }
}

function closeLightbox(view, { silent = false } = {}) {
  const lb = view.lightbox;
  if (!lb) return;
  clearInterval(lb.timer);
  lb.ac.abort();
  lb.overlay.remove();
  view.lightbox = null;
  document.body.classList.remove('photo-lightbox-open');
  if (!silent) {
    const focusTarget = document.querySelector('.photos-view .photo-tile');
    focusTarget?.focus({ preventScroll: true });
  }
}

// __APPEND__
