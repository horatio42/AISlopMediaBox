// Libraries: CRUD, folder picker, scan-all, live SSE scan progress.
import {
  h, adminGet, adminPost, adminPatch, adminDel, pageHead, card, btn, badge, emptyState, errorState,
  skeletonGrid, formModal, formGrid, textField, selectField, field, textInput, confirmDialog, toast,
  withBusy, fmtBytesSafe, fmtNum, fmtAgo, safeText, apiError, onAdminEvent, modal,
} from './core.js';

const KIND_OPTIONS = [
  { value: 'movies', label: 'Movies' },
  { value: 'shows', label: 'Shows' },
  { value: 'music', label: 'Music' },
  { value: 'photos', label: 'Photos' },
  { value: 'mixed', label: 'Mixed' },
];
const SCHEDULE_OPTIONS = [
  { value: 'manual', label: 'Manual only' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

const scanStates = new Map();

function absolutePath(value) {
  return typeof value === 'string' && value.startsWith('/');
}

function joinPath(base, name) {
  if (!name) return base || '/';
  if (absolutePath(name)) return name;
  const clean = String(base || '/').replace(/\/+$/, '');
  return `${clean}/${name}`.replace(/^$/, '/');
}

function scanStateFor(libraryId) {
  return scanStates.get(String(libraryId)) || scanStates.get(Number(libraryId));
}

function paintScan(host, libraryId) {
  const slot = host.querySelector(`[data-scan-slot="${libraryId}"]`);
  if (!slot) return;
  const scan = scanStateFor(libraryId);
  if (!scan) {
    slot.replaceChildren();
    return;
  }
  const pct = Math.round(Math.max(0, Math.min(1, Number(scan.progress) || 0)) * 100);
  const finished = ['done', 'error', 'cancelled', 'finished'].includes(String(scan.status || '').toLowerCase());
  slot.replaceChildren(h('div', { style: { marginTop: '4px' } },
    h('div', { class: 'adm-meter-foot', style: { marginTop: '0', marginBottom: '4px' } },
      h('span', {}, `${finished ? 'last scan' : 'scanning'} · ${safeText(scan.message, '')}`),
      h('span', {}, `${pct}%`),
    ),
    h('div', { class: `adm-meter ${scan.status === 'error' ? 'bad' : ''}`.trim() },
      h('i', { style: { width: `${pct}%` } })),
  ));
}

function recordScan(host, libraryId, status, progress, message, jobId) {
  if (libraryId === undefined || libraryId === null) return;
  const key = String(libraryId);
  const previous = scanStates.get(key) || {};
  scanStates.set(key, {
    ...previous,
    status: status || previous.status || 'running',
    progress: Number.isFinite(Number(progress)) ? Number(progress) : previous.progress || 0,
    message: message || previous.message || '',
    jobId: jobId || previous.jobId,
  });
  if (host?.isConnected) paintScan(host, key);
}

function scanFromJob(job) {
  if (!job || job.type !== 'scan') return null;
  const payload = job.payload || {};
  const libraryId = payload.libraryId ?? payload.library ?? payload.id;
  if (libraryId === undefined || libraryId === null) return null;
  return { libraryId, status: job.status, progress: job.progress, message: job.message, jobId: job.id };
}

function libraryCard(library, host, refresh) {
  const scan = scanStateFor(library.id);
  const activeScan = scan && ['queued', 'running', 'active'].includes(String(scan.status || '').toLowerCase());
  const scanButton = btn('Scan now', async (event) => {
    await withBusy(event.currentTarget, async () => {
      try {
        const result = await adminPost(`/api/libraries/${library.id}/scan`, {});
        const jobId = result?.jobId || result?.job?.id;
        recordScan(host, library.id, 'queued', 0, 'Queued. Vibes pending.', jobId);
        toast(`Scan queued for ${library.name}.`, 'success');
      } catch (error) {
        toast(apiError(error), 'error');
      }
    }, 'Queueing…');
  }, { kind: 'primary', title: 'Create a scan job for this library' });

  return h('article', { class: 'adm-card' },
    h('div', { class: 'adm-card-head' },
      h('div', { style: { minWidth: 0 } },
        h('h2', { class: 'truncate', title: library.name }, safeText(library.name)),
        h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '5px' } },
          badge('neutral', library.kind),
          badge('neutral', library.scanSchedule || library.scan_schedule || 'manual'),
          library.exists === false ? badge('error', 'path missing') : null,
          activeScan ? badge('running', 'scanning') : null,
        ),
      ),
      h('div', { class: 'spacer' }),
      h('div', { class: 'row', style: { gap: '2px' } },
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Edit library',
          'aria-label': `Edit ${library.name}`,
          onclick: () => editLibrary(library, host, refresh),
        }, '✎'),
      ),
    ),
    h('div', { class: 'mono small', style: { color: 'var(--faint)', overflowWrap: 'anywhere', marginBottom: '10px' } }, safeText(library.path)),
    h('div', { class: 'adm-stat-grid', style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', marginBottom: '10px' } },
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'items'), h('div', { class: 'value' }, fmtNum(library.itemCount))),
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'size'), h('div', { class: 'value' }, fmtBytesSafe(library.totalBytes))),
      h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'last scan'), h('div', { class: 'value small', style: { fontSize: '11px' } }, library.lastScanAt ? fmtAgo(library.lastScanAt) : 'never')),
    ),
    h('div', { 'data-scan-slot': library.id }),
    h('div', { class: 'row wrap', style: { marginTop: '12px', gap: '6px' } },
      scanButton,
      btn('Edit', () => editLibrary(library, host, refresh), { small: true }),
      btn('Delete', async () => {
        const items = fmtNum(library.itemCount);
        const ok = await confirmDialog(
          `Delete “${library.name}”?`,
          `This removes the library, ${items} DB item(s), and cached art. Your files on disk are never touched — this console only deletes database rows.`,
          { confirmLabel: 'Delete library', danger: true },
        );
        if (!ok) return;
        try {
          await adminDel(`/api/libraries/${library.id}`);
          scanStates.delete(String(library.id));
          toast('Library deleted. The files survived, don’t worry.', 'success');
          refresh();
        } catch (error) {
          toast(apiError(error), 'error');
        }
      }, { kind: 'danger' }),
    ),
  );
}

function browseFolders(startPath, onPick, hostLabel) {
  let currentPath = absolutePath(startPath) ? startPath : '/';
  const pathInput = textInput({ value: currentPath, placeholder: '/absolute/path' });
  const listHost = h('div', { style: { minHeight: '180px' } });
  const status = h('div', { class: 'help' });
  let handle = null;
  const setPath = (value) => {
    currentPath = value || '/';
    pathInput.value = currentPath;
  };
  const load = async () => {
    const requested = pathInput.value.trim() || '/';
    if (!absolutePath(requested)) {
      status.textContent = 'Absolute paths only, e.g. /data/media/movies.';
      return;
    }
    status.textContent = 'Reading directory…';
    listHost.replaceChildren(h('div', { class: 'adm-skel-stack' }, ...Array.from({ length: 4 }, () => h('div', { class: 'adm-skeleton', style: { height: '28px' } }))));
    try {
      const res = await adminGet(`/api/libraries/folders?path=${encodeURIComponent(requested)}`);
      const dirs = res?.dirs || res?.items || res?.folders || [];
      const parent = res?.parent || (requested === '/' ? null : requested.replace(/\/+[^/]+\/?$/, '') || '/');
      setPath(res?.path || requested);
      status.textContent = `${dirs.length} folder${dirs.length === 1 ? '' : 's'} · ${res?.mediaCount ?? res?.files ?? 0} media file(s) here`;
      const rows = [];
      if (parent) {
        rows.push(h('button', {
          class: 'adm-list-row', type: 'button', style: { width: '100%', background: 'none', textAlign: 'left', border: '0', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
          onclick: async () => { setPath(parent); await load(); },
        },
        h('span', { class: 'adm-nav-icon', 'aria-hidden': 'true' }, '↩'),
        h('span', { class: 'adm-list-main' }, h('strong', {}, '..'), h('span', {}, parent)),
        null));
      }
      for (const entry of dirs) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const path = typeof entry === 'string' ? joinPath(currentPath, entry) : (entry.path || joinPath(currentPath, entry.name));
        const count = typeof entry === 'object' ? (entry.mediaCount ?? entry.itemCount ?? entry.files ?? entry.count ?? 0) : 0;
        rows.push(h('div', { class: 'adm-list-row' },
          h('span', { class: 'adm-nav-icon', 'aria-hidden': 'true' }, '📁'),
          h('div', { class: 'adm-list-main' },
            h('strong', { title: path }, name),
            h('span', {}, count ? `${fmtNum(count)} media file(s)` : path),
          ),
          h('div', { class: 'row', style: { gap: '2px' } },
            h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { setPath(path); await load(); } }, 'Open'),
            h('button', {
              class: 'btn small', type: 'button', onclick: () => { onPick(path); handle?.close(); },
            }, 'Use'),
          ),
        ));
      }
      listHost.replaceChildren(rows.length ? h('div', {}, ...rows) : emptyState('Empty folder', 'No subfolders here. Use this folder or climb up.', { emoji: '📂' }));
    } catch (error) {
      status.textContent = apiError(error);
      listHost.replaceChildren(errorState(error, load, { title: 'Cannot browse that path' }));
    }
  };
  pathInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); load(); } });
  const body = h('div', {},
    h('div', { class: 'row', style: { marginBottom: '8px' } },
      pathInput,
      h('button', { class: 'btn small', type: 'button', onclick: load }, 'Go'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { const parent = currentPath === '/' ? '/' : currentPath.replace(/\/+[^/]+\/?$/, '') || '/'; setPath(parent); await load(); } }, 'Up'),
    ),
    status,
    h('div', { class: 'divider', style: { margin: '10px 0' } }),
    listHost,
    h('div', { class: 'adm-note', style: { marginTop: '10px' } }, `Filesystem browsing only. Nothing is leaked to the internet — this looks at ${hostLabel || 'the server'} directly.`),
  );
  handle = modal({
    title: 'Choose library folder',
    body,
    wide: true,
    actions: [
      { label: 'Cancel' },
      { label: 'Use this folder', kind: 'primary', onClick: () => onPick(currentPath) },
    ],
  });
  load();
  return handle;
}

function libraryForm(library, host, refresh) {
  const editing = Boolean(library?.id);
  let name = library?.name || '';
  let path = library?.path || '';
  let kind = library?.kind || 'movies';
  let schedule = library?.scanSchedule || library?.scan_schedule || 'daily';
  const pathInput = textInput({ value: path, placeholder: '/data/media/movies', onInput: (value) => { path = value; } });
  pathInput.id = 'adm-library-path';
  const body = h('div', {},
    formGrid(
      textField({
        label: 'Name', value: name, placeholder: 'Movies', required: true, maxlength: 120,
        onInput: (value) => { name = value; },
      }),
      selectField({
        label: 'Kind', value: kind, options: KIND_OPTIONS,
        onInput: (value) => { kind = value; },
        help: 'Determines how the scanner classifies files.',
      }),
      h('div', { class: 'adm-field span-2' },
        h('label', { for: pathInput.id }, 'Path'),
        h('div', { class: 'adm-input-row' },
          pathInput,
          h('button', {
            class: 'btn small', type: 'button', title: 'Browse folders on the server',
            onclick: () => browseFolders(path || '/', (picked) => { path = picked; pathInput.value = picked; }, stateName()),
          }, 'Browse…'),
        ),
        h('div', { class: 'help' }, 'Absolute path to the folder the server can read. Symlink loops are skipped.'),
      ),
      selectField({
        label: 'Scan schedule', value: schedule, options: SCHEDULE_OPTIONS, span: true,
        onInput: (value) => { schedule = value; },
        help: 'Manual is safest if your storage spins down when idle.',
      }),
    ),
    h('div', { class: 'adm-note' }, editing
      ? 'Editing metadata only. Item rows are rebuilt by the next scan; source files are never changed.'
      : 'The library is registered immediately; run a scan to import items. Source files are never moved or deleted.'),
  );
  formModal({
    title: editing ? `Edit “${library.name}”` : 'Add library',
    body,
    submitLabel: editing ? 'Save library' : 'Create library',
    onSubmit: async () => {
      const cleanName = name.trim();
      const cleanPath = path.trim();
      if (!cleanName) throw new Error('Give the library a name. Any name. “Stuff” is valid.');
      if (!absolutePath(cleanPath)) throw new Error('Path must be absolute — start with /. The folder picker can help.');
      const payload = { name: cleanName, kind, path: cleanPath, scanSchedule: schedule };
      if (editing) {
        await adminPatch(`/api/libraries/${library.id}`, payload);
        toast('Library updated.', 'success');
      } else {
        await adminPost('/api/libraries', payload);
        toast('Library added. Scan it when you are ready.', 'success');
      }
      refresh();
    },
  });
}

function stateName() {
  return document.getElementById('adm-brand-name')?.textContent || 'this server';
}

function editLibrary(library, host, refresh) {
  libraryForm(library, host, refresh);
}

async function loadLibraries(host, ctx) {
  try {
    const [libsRes, jobsRes] = await Promise.all([
      adminGet('/api/libraries', { signal: ctx.signal }),
      adminGet('/api/jobs/active', { signal: ctx.signal }).catch(() => null),
    ]);
    const libraries = libsRes?.items || libsRes || [];
    for (const job of jobsRes?.items || []) {
      const scan = scanFromJob(job);
      if (scan) recordScan(null, scan.libraryId, scan.status, scan.progress, scan.message, scan.jobId);
    }
    return libraries;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw error;
  }
}

function buildLibraries(libraries, host, refresh) {
  const scanning = [...scanStates.values()].filter((scan) => ['queued', 'running', 'active'].includes(String(scan.status || '').toLowerCase())).length;
  const section = h('div', { class: 'adm-section' },
    pageHead('Libraries', `${fmtNum(libraries.length)} root folder${libraries.length === 1 ? '' : 's'} · scan progress streams live over SSE${scanning ? ` · ${scanning} scan(s) active` : ''}`, [
      btn('Scan all', async (event) => {
        await withBusy(event.currentTarget, async () => {
          try {
            const result = await adminPost('/api/libraries/scan-all', {});
            const count = Array.isArray(result?.jobIds) ? result.jobIds.length : 1;
            toast(`Scan-all queued ${count === 1 ? 'a job' : `${count} jobs`}. Watch the bars.`, 'success');
            refresh();
          } catch (error) {
            toast(apiError(error), 'error');
          }
        }, 'Queueing…');
      }, { iconText: '⚡' }),
      btn('Add library', () => libraryForm(null, host, refresh), { kind: 'primary', iconText: '＋' }),
    ]),
    libraries.length
      ? h('div', { class: 'adm-grid-2 even' }, ...libraries.map((library) => libraryCard(library, host, refresh)))
      : emptyState('No libraries yet', 'Point the server at a folder of certified slop. Movies, shows, music, photos — it does the parsing.', {
        emoji: '🗄',
        actions: [btn('Add the first library', () => libraryForm(null, host, refresh), { kind: 'primary', small: false })],
      }),
    h('div', { class: 'adm-note' }, 'Delete removes database rows and cached art only. The scanner never deletes source files, ever.'),
  );
  for (const library of libraries) paintScan(section, library.id);
  return section;
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonGrid(4)));
    let timer = null;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (host.isConnected) draw(); }, 1200);
    };
    const offProgress = onAdminEvent('scan.progress', (data) => {
      const libraryId = data?.libraryId ?? data?.library?.id;
      recordScan(host, libraryId, data?.status || (data?.active ? 'running' : 'done'), data?.progress, data?.message || data?.libraryName, data?.jobId);
      if (data?.status === 'done' || data?.active === false) scheduleRefresh();
    });
    const offJob = onAdminEvent('job.update', (job) => {
      const scan = scanFromJob(job);
      if (!scan) return;
      recordScan(host, scan.libraryId, scan.status, scan.progress, scan.message, scan.jobId);
      if (['done', 'error', 'cancelled'].includes(String(scan.status))) scheduleRefresh();
    });
    const draw = async () => {
      try {
        const libraries = await loadLibraries(host, ctx);
        host.replaceChildren(buildLibraries(libraries, host, draw));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' }, errorState(error, draw, { title: 'Libraries did not load' })));
      }
    };
    await draw();
    return () => {
      offProgress();
      offJob();
      clearTimeout(timer);
    };
  },
};
