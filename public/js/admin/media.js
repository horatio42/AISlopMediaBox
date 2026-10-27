// Media manager: browse table, filters, per-row edit modal, art upload/remove, hide/delete, bulk hide.
import { artFor } from '../api.js';
import {
  h, adminGet, adminPatch, adminDel, adminPost, adminRaw, pageHead, btn, emptyState, errorState,
  skeletonRows, formModal, formGrid, textField, textareaInput, field, textInput, selectInput, confirmDialog, toast,
  fmtBytesSafe, fmtNum, fmtAgo, safeText, apiError, onAdminEvent, pagination, dataTable, toolbar,
  debounce,
} from './core.js';

const KIND_OPTIONS = ['movie', 'show', 'season', 'episode', 'artist', 'album', 'track', 'photo', 'video'];
const SORT_OPTIONS = [
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'year', label: 'Year' },
  { value: 'rating', label: 'Rating' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'random', label: 'Random' },
];
const uiState = {
  q: '',
  kind: '',
  libraryId: '',
  genre: '',
  yearFrom: '',
  yearTo: '',
  sort: 'added',
  page: 1,
  pageSize: 50,
};

function kindOptions() {
  return [{ value: '', label: 'All kinds' }, ...KIND_OPTIONS.map((kind) => ({ value: kind, label: kind }))];
}

function kindLabel(kind) {
  return safeText(kind, 'media');
}

function genreList(filters) {
  const raw = filters?.genres || [];
  return raw.map((genre) => (typeof genre === 'string' ? genre : genre?.genre || genre?.name)).filter(Boolean);
}

function libraryList(filters, libraries) {
  const source = libraries?.length ? libraries : (filters?.libraries || []);
  return source.map((lib) => ({ value: String(lib.id), label: lib.name || `Library ${lib.id}` }));
}

function artSection(item, onFile, onRemove) {
  const poster = h('img', { src: artFor(item, 'poster'), alt: 'Current poster', loading: 'lazy' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/avif,image/gif', 'aria-label': 'Upload poster image' });
  const note = h('div', { class: 'help' }, 'PNG, JPEG, WebP, AVIF or GIF · max 20 MB. Previewed locally, uploaded only when you save.');
  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    if (!picked) return;
    if (picked.size > 20 * 1024 * 1024) {
      toast('That image is over 20 MB. Compress it first.', 'error');
      file.value = '';
      return;
    }
    if (!picked.type.startsWith('image/')) {
      toast('That is not an image type the server accepts.', 'error');
      file.value = '';
      return;
    }
    poster.src = URL.createObjectURL(picked);
    note.textContent = `Selected: ${picked.name} (${fmtBytesSafe(picked.size)}) — uploads on save.`;
    onFile(picked);
  });
  return h('div', { class: 'adm-art-editor' },
    h('div', { class: 'adm-art-preview' }, poster),
    h('div', {},
      h('div', { class: 'adm-field-label', style: { marginBottom: '5px' } }, 'Poster art'),
      h('div', { class: 'adm-media-pick' }, file, h('button', {
        class: 'btn ghost small', type: 'button',
        onclick: async () => {
          const ok = await confirmDialog('Remove poster art?', 'Deletes the cached poster for this item. The next metadata/art refresh can regenerate it.', { confirmLabel: 'Remove poster', danger: true });
          if (!ok) return;
          try {
            await onRemove('poster');
            poster.src = artFor({ ...item, art: { ...(item.art || {}), poster: undefined } }, 'poster');
            note.textContent = 'Poster removed from cache.';
            toast('Poster art removed.', 'success');
          } catch (error) {
            toast(apiError(error), 'error');
          }
        },
      }, 'Remove')),
      note,
    ),
  );
}

function editMedia(item, draw) {
  let artFile = null;
  let previewUrl = null;
  const titleInput = textInput({ value: item.title || '' });
  titleInput.maxLength = 300;
  const yearInput = textInput({ value: item.year ?? '', type: 'number', min: 1800, max: 2200 });
  const ratingInput = textInput({ value: item.rating ?? '', type: 'number', min: 0, max: 10, step: 0.1 });
  const contentRatingInput = textInput({ value: item.contentRating || '', placeholder: 'PG-13 / TV-MA / unrated' });
  contentRatingInput.maxLength = 20;
  const taglineInput = textInput({ value: item.tagline || '' });
  taglineInput.maxLength = 300;
  const descriptionInput = textareaInput({ value: item.description || '', rows: 5, maxlength: 4000 });
  const genresInput = textInput({ value: (item.genres || []).join(', '), placeholder: 'Drama, Comedy' });
  const lockedInput = h('input', { type: 'checkbox', checked: item.metadataLocked ? true : undefined });
  const identity = h('div', { class: 'adm-note' },
    h('div', {}, item.title, ' · ', h('span', { class: 'mono' }, `#${item.id}`)),
    h('div', { class: 'mono small', style: { marginTop: '4px', color: 'var(--faint)', overflowWrap: 'anywhere' } }, safeText(item.libraryName, `library ${item.libraryId}`)),
    item.path ? h('div', { class: 'mono small', style: { marginTop: '4px', color: 'var(--faint)', overflowWrap: 'anywhere' } }, `file: ${item.path}`) : null,
    h('div', { class: 'mono small', style: { marginTop: '4px', color: 'var(--faint)' } }, `${kindLabel(item.kind)} · added ${fmtAgo(item.addedAt)} · ${fmtBytesSafe(item.sizeBytes)}`),
  );

  const body = h('div', {},
    identity,
    artSection(item, (file) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      artFile = file;
      previewUrl = URL.createObjectURL(file);
    }, async (kind) => {
      await adminDel(`/api/art/${item.id}/${kind}`);
    }),
    formGrid(
      field('Title', titleInput, { span: true }),
      field('Year', yearInput),
      field('Rating (0–10)', ratingInput),
      field('Content rating', contentRatingInput),
      field('Genres', genresInput, { help: 'Comma-separated. Replaces the existing genre list.' }),
      field('Tagline', taglineInput, { span: true }),
      field('Description', descriptionInput, { span: true }),
      h('label', { class: 'adm-check span-2' },
        lockedInput,
        h('span', { class: 'adm-check-copy' },
          h('strong', {}, 'Lock metadata'),
          h('span', {}, 'Scanner and TMDB refreshes will not overwrite edits for this item.'),
        ),
      ),
    ),
    h('div', { class: 'adm-note' }, 'Saving edits never renames or deletes the source file. Art uploads land in the local cache.'),
  );
  const handle = formModal({
    title: `Edit “${item.title}”`,
    body,
    wide: true,
    submitLabel: 'Save changes',
    onClose: () => { if (previewUrl) URL.revokeObjectURL(previewUrl); },
    extraActions: [
      {
        label: 'Refresh metadata',
        onClick: async ({ close }) => {
          try {
            await adminPost(`/api/media/${item.id}/refresh`, {});
            toast('Metadata refresh queued—or done, depending on the scanner’s mood.', 'success');
            close();
            draw();
          } catch (error) {
            toast(apiError(error), 'error');
            return false;
          }
          return false;
        },
      },
      {
        label: 'TMDB match…',
        onClick: () => { matchMedia(item, draw); },
      },
    ],
    onSubmit: async () => {
      const genreValues = [...new Set(genresInput.value.split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 20);
      const yearRaw = yearInput.value.trim();
      const ratingRaw = ratingInput.value.trim();
      const year = yearRaw ? Number(yearRaw) : null;
      const rating = ratingRaw ? Number(ratingRaw) : null;
      if (year !== null && (!Number.isInteger(year) || year < 1800 || year > 2200)) throw new Error('Year must be an integer between 1800 and 2200, or blank.');
      if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 10)) throw new Error('Rating must be between 0 and 10, or blank.');
      const cleanTitle = titleInput.value.trim();
      if (!cleanTitle) throw new Error('Title cannot be empty. Even “Untitled Slop #4” is better.');
      if (cleanTitle.length > 300) throw new Error('Title must be 300 characters or fewer.');
      if (contentRatingInput.value.trim().length > 20) throw new Error('Content rating must be 20 characters or fewer.');
      if (taglineInput.value.trim().length > 300) throw new Error('Tagline must be 300 characters or fewer.');
      await adminPatch(`/api/media/${item.id}`, {
        title: cleanTitle,
        year,
        rating,
        contentRating: contentRatingInput.value.trim() || null,
        tagline: taglineInput.value.trim() || null,
        description: descriptionInput.value.trim(),
        genres: genreValues,
        metadataLocked: lockedInput.checked,
      });
      if (artFile) {
        await adminRaw(`/api/art/${item.id}/poster`, {
          method: 'POST',
          headers: { 'Content-Type': artFile.type },
          body: artFile,
        });
      }
      toast('Media updated.', 'success');
      draw();
    },
  });
  return handle;
}

function matchMedia(item, draw) {
  const query = textInput({ value: '', placeholder: 'TMDB id or search query, e.g. 603 or “The Matrix”' });
  const body = h('div', {},
    h('div', { class: 'adm-note' }, 'Manual match requires a TMDB API key in Settings. A numeric value is treated as a TMDB id; anything else is searched. Local metadata is never deleted, only matched.'),
    field('Match target', query, { help: 'Use the exact title and year for better results.' }),
  );
  formModal({
    title: 'Match with TMDB',
    body,
    submitLabel: 'Run match',
    onSubmit: async () => {
      const value = query.value.trim();
      if (!value) throw new Error('Enter a TMDB id or search query.');
      const payload = /^\d+$/.test(value) ? { id: value } : { query: value };
      await adminPost(`/api/media/${item.id}/match`, payload);
      toast('Match request sent.', 'success');
      draw();
    },
  });
}

function filterSelect(label, value, options, onChange) {
  const select = selectInput({ value, options, onInput: onChange });
  select.setAttribute('aria-label', label);
  return select;
}

function itemSubLine(item) {
  const bits = [`#${item.id}`, item.kind];
  if (item.kind === 'episode') bits.push(`S${safeText(item.seasonNumber, '?')}E${safeText(item.episodeNumber, '?')}`);
  if (item.kind === 'track' && item.trackNumber) bits.push(`track ${item.trackNumber}`);
  if (item.contentRating) bits.push(item.contentRating);
  return bits.join(' · ');
}

function buildTable(items, draw) {
  const selected = new Set();
  const bulkText = h('span', {}, '0 selected');
  const hideSelected = btn('Hide selected', async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirmDialog(`Hide ${ids.length} item(s)?`, 'They disappear from the catalog. Rows and source files remain, and a rescan can bring them back. Cached art stays until cleanup.', { confirmLabel: `Hide ${ids.length}` });
    if (!ok) return;
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try { await adminDel(`/api/media/${id}`); done += 1; } catch { failed += 1; }
    }
    toast(failed ? `Hid ${done}, failed ${failed}. The slop resisted.` : `Hid ${done} item(s).`, failed ? 'error' : 'success');
    selected.clear();
    draw();
  }, { kind: 'danger', small: true });
  const clearSelection = btn('Clear', () => {
    selected.clear();
    document.querySelectorAll('#adm-media-table tbody input[data-id]').forEach((box) => { box.checked = false; });
    document.querySelectorAll('#adm-media-table tbody tr').forEach((row) => row.classList.remove('is-selected'));
    syncBulk();
  }, { small: true });
  const bulkBar = h('div', { class: 'adm-bulk-bar', hidden: true }, bulkText, h('span', { class: 'spacer' }), hideSelected, clearSelection);

  const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select all media on this page' });
  selectAll.addEventListener('change', () => {
    selected.clear();
    if (selectAll.checked) items.forEach((item) => selected.add(item.id));
    document.querySelectorAll('#adm-media-table input[data-id]').forEach((box) => { box.checked = selectAll.checked; });
    syncBulk();
    document.querySelectorAll('#adm-media-table tr[data-id]').forEach((row) => row.classList.toggle('is-selected', selected.has(Number(row.dataset.id))));
  });

  function syncBulk() {
    bulkText.textContent = `${selected.size} selected`;
    bulkBar.hidden = selected.size === 0;
    hideSelected.disabled = selected.size === 0;
    selectAll.indeterminate = selected.size > 0 && selected.size < items.length;
    selectAll.checked = items.length > 0 && selected.size === items.length;
  }

  function toggleRow(item, checked) {
    if (checked) selected.add(item.id); else selected.delete(item.id);
    const row = document.querySelector(`#adm-media-table tr[data-id="${item.id}"]`);
    row?.classList.toggle('is-selected', checked);
    syncBulk();
  }

  const columns = [
    {
      label: selectAll,
      className: 'adm-check-cell',
      render: (item) => {
        const box = h('input', { type: 'checkbox', 'data-id': item.id, 'aria-label': `Select ${item.title}` });
        box.addEventListener('change', () => toggleRow(item, box.checked));
        return box;
      },
    },
    {
      label: 'Title',
      className: 'adm-cell-title',
      render: (item) => {
        const art = h('img', {
          class: `adm-thumb${['episode', 'track', 'video'].includes(item.kind) ? ' wide' : ''}`,
          src: artFor(item, ['episode', 'track', 'video'].includes(item.kind) ? 'thumb' : 'poster'),
          alt: '',
          loading: 'lazy',
        });
        return h('div', { class: 'adm-row-title' }, art,
          h('div', { style: { minWidth: 0 } },
            h('a', { class: 'adm-title-link', href: `/item/${item.id}`, target: '_blank', rel: 'noopener', title: item.title }, item.title),
            h('span', {}, itemSubLine(item)),
          ),
        );
      },
    },
    { label: 'Library', render: (item) => h('span', { class: 'adm-muted' }, safeText(item.libraryName, `#${item.libraryId}`)) },
    { label: 'Year', render: (item) => h('span', { class: 'num' }, item.year ?? '—') },
    { label: 'Rating', render: (item) => h('span', { class: 'num' }, Number.isFinite(item.rating) ? Number(item.rating).toFixed(1) : '—') },
    { label: 'Size', render: (item) => h('span', { class: 'num' }, item.sizeBytes ? fmtBytesSafe(item.sizeBytes) : '—') },
    { label: 'Added', render: (item) => h('span', { class: 'num', title: item.addedAt }, fmtAgo(item.addedAt)) },
    {
      label: 'Actions',
      className: 'nowrap',
      render: (item) => h('div', { class: 'actions' },
        btn('Edit', () => editMedia(item, draw), { small: true, iconText: '✎' }),
        btn('Refresh', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await adminPost(`/api/media/${item.id}/refresh`, {});
            toast('Refresh requested.', 'success');
            draw();
          } catch (error) {
            toast(apiError(error), 'error');
            button.disabled = false;
          }
        }, { small: true, iconText: '↻', title: 'Re-probe and refresh metadata/art' }),
        btn('Hide', async () => {
          const ok = await confirmDialog(`Hide “${item.title}”?`, 'Removes it from the public catalog. The database row and source file remain; rescanning can bring it back.', { confirmLabel: 'Hide', danger: true });
          if (!ok) return;
          try { await adminDel(`/api/media/${item.id}`); toast('Item hidden.', 'success'); draw(); } catch (error) { toast(apiError(error), 'error'); }
        }, { small: true, title: 'Hide from catalog (row kept)' }),
        btn('Delete row', async () => {
          const ok = await confirmDialog(`Delete the DB row for “${item.title}”?`, 'This removes the catalog row only. The source file on disk stays. A future scan can re-import it, with a fresh id.', { confirmLabel: 'Delete row', danger: true });
          if (!ok) return;
          try { await adminDel(`/api/media/${item.id}?hard=1`); toast('Database row deleted. File untouched.', 'success'); draw(); } catch (error) { toast(apiError(error), 'error'); }
        }, { kind: 'danger', small: true, title: 'Delete database row only (?hard=1)' }),
      ),
    },
  ];
  const table = dataTable({
    columns,
    rows: items,
    caption: `Media rows — ${fmtNum(items.length)} on this page`,
    empty: emptyState('No media matches those filters', 'Loosen the filters, clear the search, or scan a library. The slop does not materialize itself.', { emoji: '🔍' }),
    rowClass: (item) => (selected.has(item.id) ? 'is-selected' : ''),
  });
  table.id = 'adm-media-table';
  table.querySelectorAll('tbody tr').forEach((row, index) => {
    if (items[index]) row.dataset.id = String(items[index].id);
  });
  syncBulk();
  return { table, bulkBar };
}

function filtersBar(libraries, filters, draw) {
  const search = textInput({
    value: uiState.q,
    placeholder: 'Search title, genre, cast…',
    onInput: debounce((value) => { uiState.q = value; uiState.page = 1; draw(); }, 320),
  });
  search.classList.add('grow');
  const genreOptions = [{ value: '', label: 'All genres' }, ...genreList(filters).map((genre) => ({ value: genre, label: genre }))];
  const libraryOptions = [{ value: '', label: 'All libraries' }, ...libraryList(filters, libraries)];
  const yearFrom = textInput({ value: uiState.yearFrom, type: 'number', placeholder: 'From', min: 1870, max: 2200, onInput: debounce((value) => { uiState.yearFrom = value; uiState.page = 1; draw(); }, 400) });
  const yearTo = textInput({ value: uiState.yearTo, type: 'number', placeholder: 'To', min: 1870, max: 2200, onInput: debounce((value) => { uiState.yearTo = value; uiState.page = 1; draw(); }, 400) });
  for (const input of [yearFrom, yearTo]) { input.style.width = '82px'; input.setAttribute('aria-label', input.placeholder); }
  const pageSize = filterSelect('Rows per page', String(uiState.pageSize), [25, 50, 100, 200].map((n) => ({ value: String(n), label: `${n} rows` })), (value) => { uiState.pageSize = Number(value); uiState.page = 1; draw(); });
  return toolbar([
    search,
    filterSelect('Kind', uiState.kind, kindOptions(), (value) => { uiState.kind = value; uiState.page = 1; draw(); }),
    filterSelect('Library', uiState.libraryId, libraryOptions, (value) => { uiState.libraryId = value; uiState.page = 1; draw(); }),
    filterSelect('Genre', uiState.genre, genreOptions, (value) => { uiState.genre = value; uiState.page = 1; draw(); }),
    yearFrom,
    yearTo,
    filterSelect('Sort', uiState.sort, SORT_OPTIONS, (value) => { uiState.sort = value; uiState.page = 1; draw(); }),
    pageSize,
    btn('Clear filters', () => {
      uiState.q = ''; uiState.kind = ''; uiState.libraryId = ''; uiState.genre = '';
      uiState.yearFrom = ''; uiState.yearTo = ''; uiState.sort = 'added'; uiState.page = 1;
      draw();
    }, { small: true }),
  ]);
}

function browseQuery() {
  const params = new URLSearchParams();
  params.set('includeChildren', '1');
  params.set('page', String(uiState.page));
  params.set('pageSize', String(uiState.pageSize));
  params.set('sort', uiState.sort);
  params.set('order', uiState.sort === 'title' ? 'asc' : 'desc');
  for (const key of ['q', 'kind', 'libraryId', 'genre', 'yearFrom', 'yearTo']) {
    if (uiState[key]) params.set(key, uiState[key]);
  }
  return `/api/browse?${params.toString()}`;
}

export default {
  async render(host, ctx) {
    let libraries = [];
    let filters = {};
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(8)));
    try {
      const [libsRes, filterRes] = await Promise.all([
        adminGet('/api/libraries', { signal: ctx.signal }),
        adminGet('/api/browse/filters', { signal: ctx.signal }).catch(() => ({})),
      ]);
      libraries = libsRes?.items || libsRes || [];
      filters = filterRes || {};
    } catch (error) {
      if (error?.name === 'AbortError') return undefined;
      host.replaceChildren(h('div', { class: 'adm-section' }, errorState(error, () => this.render(host, ctx), { title: 'Media filters did not load' })));
      return undefined;
    }

    let timer = null;
    const offMedia = onAdminEvent('media.changed', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (host.isConnected) draw(); }, 1000);
    });

    const draw = async () => {
      if (!host.isConnected) return;
      try {
        const res = await adminGet(browseQuery(), { signal: ctx.signal });
        const items = res?.items || [];
        const total = res?.total ?? items.length;
        const page = res?.page ?? uiState.page;
        const pageSize = res?.pageSize ?? uiState.pageSize;
        if (page !== uiState.page) uiState.page = page;
        const built = buildTable(items, draw);
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Media', `${fmtNum(total)} rows including episodes, seasons and tracks · edits touch the database, never your files`, [
            btn('Refresh', draw, { iconText: '↻' }),
          ]),
          filtersBar(libraries, filters, draw),
          built.bulkBar,
          built.table,
          pagination({ page, pageSize, total, onPage: (next) => { uiState.page = next; draw(); } }),
          h('div', { class: 'adm-note' }, 'Bulk hide is sequential and honest: each row gets a DELETE call. “Delete row” is ?hard=1 — DB row only, file untouched. Nothing here deletes source media.'),
        ));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          pageHead('Media', 'Browse and manage catalog rows'),
          errorState(error, draw, { title: 'Media did not load' }),
        ));
      }
    };
    await draw();
    return () => {
      offMedia();
      clearTimeout(timer);
    };
  },
};

