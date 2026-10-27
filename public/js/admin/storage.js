// Storage: disk/meter, per-library sizes, cache breakdown, DB size, maintenance actions.
import {
  h, adminGet, adminPost, pageHead, card, btn, badge, emptyState, errorState, skeletonRows,
  confirmDialog, toast, modal, withBusy, fmtBytesSafe, fmtNum, fmtPct, num, safeText, apiError, jsonPretty,
} from './core.js';

function cacheRows(cache) {
  const labels = {
    images: 'Artwork cache',
    transcode: 'HLS / transcode',
    subtitles: 'Converted subtitles',
    temp: 'Temp files',
    logs: 'Log files',
  };
  return ['images', 'transcode', 'subtitles', 'temp', 'logs'].map((key) => {
    const entry = cache?.[key] || {};
    return h('tr', {},
      h('td', {}, labels[key]),
      h('td', { class: 'num' }, fmtBytesSafe(entry.bytes ?? entry.sizeBytes ?? 0)),
      h('td', { class: 'num' }, fmtNum(entry.files ?? entry.count ?? 0)),
    );
  });
}

function libBars(libraries, mediaBytes) {
  const rows = [...libraries].sort((a, b) => num(b.bytes) - num(a.bytes));
  const max = Math.max(num(mediaBytes), ...rows.map((lib) => num(lib.bytes)), 1);
  return h('div', {},
    ...rows.map((lib) => h('div', { class: 'adm-bar-row', style: { gridTemplateColumns: 'minmax(120px, 220px) minmax(0, 1fr) 150px' } },
      h('span', { title: lib.path, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        safeText(lib.name),
        lib.exists === false ? ' ⚠' : '',
      ),
      h('span', { class: 'adm-bar' }, h('i', { style: { width: `${Math.max(num(lib.bytes) > 0 ? 1 : 0, (num(lib.bytes) / max) * 100)}%` } })),
      h('span', { class: 'num' }, `${fmtBytesSafe(lib.bytes)} · ${fmtNum(lib.items)}`),
    )),
    h('div', { class: 'adm-meter-foot', style: { marginTop: '10px' } },
      h('span', {}, `${rows.length} libraries · ${fmtBytesSafe(mediaBytes)} media`),
      h('span', {}, 'bars scale to the largest library'),
    ),
  );
}

async function runMaintenance(action, draw, event, { confirmTitle, confirmMessage, confirmLabel, danger = false }) {
  if (confirmMessage) {
    const ok = await confirmDialog(confirmTitle, confirmMessage, { confirmLabel, danger });
    if (!ok) return;
  }
  const button = event?.currentTarget;
  await withBusy(button, async () => {
    try {
      const result = await adminPost('/api/admin/maintenance', { action });
      if (action === 'optimize' || action === 'vacuum') {
        modal({
          title: action === 'vacuum' ? 'Vacuum complete' : 'Optimize complete',
          body: h('div', {},
            h('div', { class: 'adm-note' }, action === 'vacuum'
              ? 'SQLite rewrote the database file and reclaimed free pages. Media files were not touched.'
              : 'PRAGMA optimize + ANALYZE updated query planner statistics. No data moved.'),
            h('pre', { class: 'adm-code' }, jsonPretty(result)),
          ),
          wide: true,
          actions: [{ label: 'Close' }],
        });
      } else if (action === 'clear-cache') {
        toast(`Cache cleared: ${fmtNum(result?.removedFiles ?? 0)} files, ${fmtBytesSafe(result?.freedBytes ?? 0)} freed.`, 'success');
      } else {
        if (result?.jobId) toast(`${action === 'reindex' ? 'Reindex' : 'Art regeneration'} job queued. Track it in Jobs.`, 'success');
        else toast(`${action} request accepted${result?.queued ? '' : ''}.`, 'success');
      }
      draw();
    } catch (error) {
      if (error?.status === 503) {
        toast(`${apiError(error)} — the job handler is not registered yet. The queue will refuse rather than fake it.`, 'error');
      } else {
        toast(apiError(error), 'error');
      }
      if (button?.isConnected) button.disabled = false;
    }
  }, 'Running…');
}

function actionButton({ title, description, action, draw, confirmTitle, confirmMessage, confirmLabel, danger }) {
  return h('button', {
    class: `adm-action${danger ? ' danger' : ''}`,
    type: 'button',
    onclick: (event) => runMaintenance(action, draw, event, { confirmTitle, confirmMessage, confirmLabel, danger }),
  },
  h('strong', {}, title),
  h('span', {}, description),
  );
}

async function drawStorage(host, ctx) {
  try {
    const storage = await adminGet('/api/admin/storage', { signal: ctx.signal });
    const disk = storage.disk || {};
    const cache = storage.cache || {};
    const db = storage.db || {};
    const libraries = Array.isArray(storage.libraries) ? storage.libraries : [];
    const byKind = Array.isArray(storage.byKind) ? storage.byKind : [];
    const percent = num(disk.percentUsed ?? (disk.totalBytes ? (num(disk.usedBytes) / num(disk.totalBytes)) * 100 : 0));
    host.replaceChildren(h('div', { class: 'adm-section' },
      pageHead('Storage', 'What occupies the disk, what is disposable, and the buttons that rewrite SQLite on purpose', [
        btn('Refresh', () => drawStorage(host, ctx), { iconText: '↻' }),
      ]),
      h('div', { class: 'adm-stat-grid' },
        h('div', { class: 'adm-stat' }, h('div', { class: 'label' }, 'media library'), h('div', { class: 'value' }, fmtBytesSafe(storage.mediaBytes)), h('div', { class: 'foot' }, `${fmtNum(storage.mediaItems)} items`)),
        h('div', { class: 'adm-stat' }, h('div', { class: 'label' }, 'artwork cache'), h('div', { class: 'value' }, fmtBytesSafe(storage.art?.bytes)), h('div', { class: 'foot' }, `${fmtNum(storage.art?.count)} images`)),
        h('div', { class: 'adm-stat' }, h('div', { class: 'label' }, 'cache total'), h('div', { class: 'value' }, fmtBytesSafe(cache.totalBytes)), h('div', { class: 'foot' }, `${fmtNum(cache.totalFiles)} files`)),
        h('div', { class: 'adm-stat' }, h('div', { class: 'label' }, 'database'), h('div', { class: 'value' }, fmtBytesSafe(db.bytes)), h('div', { class: 'foot' }, `WAL ${fmtBytesSafe(db.walBytes)}`)),
        h('div', { class: 'adm-stat' }, h('div', { class: 'label' }, 'free disk'), h('div', { class: 'value accent' }, fmtBytesSafe(disk.freeBytes)), h('div', { class: 'foot' }, `${fmtPct(percent, 1)} used`)),
      ),
      h('div', { class: 'adm-grid-2 even' },
        card('Disk usage', [
          h('div', { class: 'mono small', style: { color: 'var(--faint)', marginBottom: '8px', overflowWrap: 'anywhere' } }, safeText(cache.root || db.path, 'unknown')),
          h('div', { class: `adm-meter ${percent >= 95 ? 'bad' : percent >= 85 ? 'warn' : ''}`.trim(), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent) },
            h('i', { style: { width: `${Math.min(100, Math.max(0, percent))}%` } })),
          h('div', { class: 'adm-meter-foot' }, h('span', {}, `${fmtBytesSafe(disk.usedBytes)} used`), h('span', {}, `${fmtBytesSafe(disk.totalBytes)} total`)),
          h('div', { class: 'adm-audit', style: { marginTop: '14px' } },
            h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'free'), h('div', { class: 'value' }, fmtBytesSafe(disk.freeBytes))),
            h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'database path'), h('div', { class: 'value mono small', style: { overflowWrap: 'anywhere' } }, safeText(db.path))),
            h('div', { class: 'adm-audit-item' }, h('div', { class: 'label' }, 'cache root'), h('div', { class: 'value mono small', style: { overflowWrap: 'anywhere' } }, safeText(cache.root))),
          ),
        ], { sub: 'statfs' }),
        card('Cache breakdown', [
          h('div', { class: 'adm-table-wrap' },
            h('table', { class: 'adm-table' },
              h('caption', {}, 'Transient + persistent cache'),
              h('thead', {}, h('tr', {}, h('th', {}, 'Area'), h('th', {}, 'Bytes'), h('th', {}, 'Files'))),
              h('tbody', {}, ...cacheRows(cache)),
            ),
          ),
          h('div', { class: 'adm-note', style: { marginTop: '10px' } }, 'Clearing cache removes transcode segments, converted subtitles and temp files — not artwork, not the database.'),
        ], { sub: `${fmtNum(cache.totalFiles)} files` }),
      ),
      card('By kind', [
        byKind.length
          ? h('div', {}, ...byKind.sort((a, b) => num(b.bytes) - num(a.bytes)).map((kind) => {
            const max = Math.max(...byKind.map((entry) => num(entry.bytes)), 1);
            return h('div', { class: 'adm-bar-row' },
              h('span', {}, safeText(kind.kind)),
              h('span', { class: 'adm-bar' }, h('i', { style: { width: `${Math.max(0, (num(kind.bytes) / max) * 100)}%` } })),
              h('span', { class: 'num' }, `${fmtBytesSafe(kind.bytes)} · ${fmtNum(kind.items)}`),
            );
          }))
          : h('p', { class: 'faint small' }, 'No media bytes recorded yet.'),
      ], { sub: 'media table' }),
      card('Libraries', [
        libraries.length
          ? libBars(libraries, storage.mediaBytes)
          : emptyState('No libraries', 'Add one in Libraries. Then the bytes will have somewhere to live.', { emoji: '🗄' }),
      ], { sub: `${libraries.length} registered` }),
      card('Maintenance', [
        h('p', { class: 'help', style: { marginBottom: '12px' } }, 'These actions operate on the local SQLite database and caches. Source media files are never moved or deleted.'),
        h('div', { class: 'adm-action-grid' },
          actionButton({
            title: 'Optimize database',
            description: 'PRAGMA optimize + ANALYZE. Safe, quick, updates planner stats.',
            action: 'optimize', draw: () => drawStorage(host, ctx),
            confirmTitle: 'Optimize SQLite?',
            confirmMessage: 'Runs PRAGMA optimize and ANALYZE. No rows are deleted. Queries may get faster; the vibes remain identical.',
            confirmLabel: 'Optimize',
          }),
          actionButton({
            title: 'Vacuum database',
            description: 'Rewrite the DB file to reclaim free pages. Needs free space and exclusive use.',
            action: 'vacuum', draw: () => drawStorage(host, ctx),
            confirmTitle: 'Vacuum SQLite?',
            confirmMessage: 'Vacuuming rewrites the database file and can take a while. It may need up to roughly the current DB size in free disk. Streaming metadata reads may pause during the rewrite.',
            confirmLabel: 'Vacuum now', danger: true,
          }),
          actionButton({
            title: 'Clear transient cache',
            description: 'Delete transcode, subtitle and temp caches. Artwork stays.',
            action: 'clear-cache', draw: () => drawStorage(host, ctx),
            confirmTitle: 'Clear transient cache?',
            confirmMessage: 'Deletes HLS sessions, converted subtitles and temp files. Active playback may need to restart a transcode. Artwork and DB untouched.',
            confirmLabel: 'Clear cache', danger: true,
          }),
          actionButton({
            title: 'Regenerate artwork',
            description: 'Queue an art job for the scanner. Safer than deleting images by hand.',
            action: 'regenerate-art', draw: () => drawStorage(host, ctx),
            confirmTitle: 'Regenerate artwork?',
            confirmMessage: 'Queues regenerated posters/thumbnails using ffmpeg for existing items. Custom uploaded art may be overwritten depending on the scanner — use media-level locks if you care.',
            confirmLabel: 'Queue art job',
          }),
          actionButton({
            title: 'Reindex media',
            description: 'Re-probe all media rows. Heavy; queues a job. Local files only.',
            action: 'reindex', draw: () => drawStorage(host, ctx),
            confirmTitle: 'Reindex everything?',
            confirmMessage: 'Re-probes every media row and may rewrite technical metadata. Long-running and CPU-heavy. It does not delete source files. Do this when you suspect stale probe data.',
            confirmLabel: 'Queue reindex', danger: true,
          }),
        ),
        h('div', { class: 'adm-note', style: { marginTop: '12px' } }, 'If a maintenance handler is not registered, the server returns 503 job_handler_missing instead of pretending to work. That is the honest failure mode.'),
      ], { sub: 'destructive? sort of' }),
    ));
  } catch (error) {
    if (error?.name === 'AbortError') return;
    host.replaceChildren(h('div', { class: 'adm-section' },
      pageHead('Storage', 'Disk, caches, database'),
      errorState(error, () => drawStorage(host, ctx), { title: 'Storage did not load' }),
    ));
  }
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(8)));
    await drawStorage(host, ctx);
  },
};
