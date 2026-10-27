// Ingestion: provider health, drop-folder sources, review queue, recent activity, live SSE.
import { placeholderArt } from '../api.js';
import {
  h, adminGet, adminPost, adminPatch, adminDel, pageHead, card, btn, badge, emptyState, errorState,
  skeletonGrid, skeletonRows, formModal, formGrid, textField, selectField, field, textInput, confirmDialog,
  toast, withBusy, fmtBytesSafe, fmtNum, fmtAgo, fmtPct, safeText, apiError, onAdminEvent, pagination, dataTable,
  copyToClipboard,
} from './core.js';

const KIND_OPTIONS = [
  { value: 'movies', label: 'Movies — video files' },
  { value: 'shows', label: 'Shows — episodes and season folders' },
  { value: 'music', label: 'Music — tracks and albums' },
  { value: 'photos', label: 'Photos — images' },
];
const ACTION_OPTIONS = [
  { value: 'move', label: 'Move (rename into the library)' },
  { value: 'copy', label: 'Copy (leave the drop file in place)' },
  { value: 'hardlink', label: 'Hardlink (zero extra space)' },
  { value: 'symlink', label: 'Symlink (points back at the drop file)' },
];
const STATUS_OPTIONS = [
  { value: 'organized', label: 'Organized' },
  { value: 'error', label: 'Errors' },
  { value: 'ignored', label: 'Ignored' },
];
const DROP_PATHS = [
  { kind: 'movies', path: '/data/ingest/movies' },
  { kind: 'shows', path: '/data/ingest/tv' },
  { kind: 'music', path: '/data/ingest/music' },
  { kind: 'photos', path: '/data/ingest/photos' },
];

function isLocalAsset(url) {
  if (!url) return false;
  if (/^(data|blob):/i.test(url)) return true;
  if (url.startsWith('/')) return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function candidatePoster(candidate) {
  if (isLocalAsset(candidate?.posterUrl)) return candidate.posterUrl;
  return placeholderArt(`${candidate?.provider || 'provider'}:${candidate?.providerId || candidate?.title}`, 'poster', candidate?.title || '');
}

function providerKindFor(sourceKind) {
  if (sourceKind === 'movies') return 'movie';
  if (sourceKind === 'shows') return 'show';
  return null;
}

function countOf(source, key) {
  const value = Number(source?.counts?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function lastResultText(result) {
  if (result === null || result === undefined || result === '') return '—';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const bits = [];
    for (const key of ['processed', 'discovered', 'organized', 'review', 'error', 'errors', 'skipped', 'mapped', 'ignored', 'total']) {
      const value = Number(result[key]);
      if (Number.isFinite(value)) bits.push(`${key} ${fmtNum(value)}`);
    }
    if (result.message) bits.unshift(String(result.message));
    if (bits.length) return bits.join(' · ');
    try { return JSON.stringify(result).slice(0, 160); } catch { return '—'; }
  }
  return String(result);
}

function providerCard(provider) {
  const hosts = Array.isArray(provider?.hosts) ? provider.hosts.filter(Boolean) : [];
  const kinds = Array.isArray(provider?.kinds) ? provider.kinds : [];
  return h('article', { class: 'adm-provider' },
    h('div', { class: 'adm-provider-head' },
      h('div', { style: { minWidth: 0 } },
        h('h3', {}, safeText(provider?.label, provider?.id || 'provider')),
        h('div', { class: 'row wrap', style: { gap: '5px', marginTop: '6px' } },
          badge('neutral', safeText(provider?.id, 'provider')),
          provider?.configured ? badge('good', 'configured') : badge('neutral', 'not configured'),
          provider?.enabled ? badge('running', 'auto-enabled') : badge('neutral', 'auto off'),
          provider?.keyless ? badge('neutral', 'keyless') : badge('neutral', 'needs key'),
          ...kinds.map((kind) => badge('neutral', kind)),
        ),
      ),
    ),
    hosts.length
      ? h('div', { class: 'adm-provider-hosts' },
        h('div', { class: 'adm-field-label' }, 'Outbound hosts'),
        h('div', { class: 'row wrap', style: { gap: '4px' } }, ...hosts.map((host) => h('code', { class: 'adm-provider-host' }, host))))
      : h('div', { class: 'adm-provider-hosts faint small' }, 'No outbound hosts reported.'),
    provider?.note ? h('p', { class: 'adm-provider-note' }, safeText(provider.note)) : null,
  );
}

function renderProviders(providers) {
  if (!providers.length) {
    return h('div', {},
      emptyState('No provider registry yet', 'The server returned no providers. Keys and keyless toggles live in Settings; when one is configured it appears here with its hosts.', {
        emoji: '📡',
        actions: [h('a', { class: 'mini-link', href: '#settings' }, 'Open provider settings →')],
      }),
    );
  }
  const sorted = [...providers].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || String(a.label || a.id).localeCompare(String(b.label || b.id)));
  return h('div', {},
    h('div', { class: 'adm-provider-grid' }, ...sorted.map(providerCard)),
    h('div', { class: 'adm-note', style: { marginTop: '10px' } },
      h('strong', {}, 'Gating: '),
      'manual provider search works for a configured provider even when autoMatch is off. Automatic scanning needs both the global autoMatch setting and the provider enabled. Disabled providers are never called. ',
      h('a', { class: 'mini-link', href: '#settings' }, 'Provider keys & toggles →'),
    ),
  );
}

function countFrom(stats, keys) {
  const containers = [stats?.counts, stats?.totals, stats?.items, stats];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of keys) {
      const value = container[key];
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) return Number(value);
    }
  }
  return null;
}

function watcherFrom(stats) {
  const watcher = stats?.watcher || stats?.watch || {};
  const enabled = typeof watcher.enabled === 'boolean'
    ? watcher.enabled
    : typeof stats?.ingestWatch === 'boolean' ? stats.ingestWatch : null;
  const interval = watcher.intervalSeconds ?? stats?.ingestIntervalSeconds ?? null;
  return { enabled, interval: Number.isFinite(Number(interval)) ? Number(interval) : null };
}

function renderStats(stats, progress) {
  const pending = countFrom(stats, ['pending']);
  const review = countFrom(stats, ['review']);
  const organized = countFrom(stats, ['organized']);
  const errors = countFrom(stats, ['error', 'errors']);
  const ignored = countFrom(stats, ['ignored']);
  const watcher = watcherFrom(stats);
  const values = [
    { label: 'pending', value: pending, foot: 'waiting for a run' },
    { label: 'review', value: review, foot: 'need a human', accent: Number(review) > 0 },
    { label: 'organized', value: organized, foot: 'moved into libraries' },
    { label: 'errors', value: errors, foot: 'retry lives below', bad: Number(errors) > 0 },
    { label: 'ignored', value: ignored, foot: 'left where they were' },
  ];
  const statTiles = values.map((item) => h('div', { class: 'adm-stat' },
    h('div', { class: 'label' }, item.label),
    h('div', { class: `value${item.accent ? ' accent' : ''}`, style: item.bad ? { color: 'var(--error)' } : undefined }, item.value === null ? '—' : fmtNum(item.value)),
    h('div', { class: 'foot' }, item.foot),
  ));
  statTiles.push(h('div', { class: 'adm-stat' },
    h('div', { class: 'label' }, 'watcher'),
    h('div', { class: 'value small' }, watcher.enabled === null ? '—' : watcher.enabled ? 'on' : 'off'),
    h('div', { class: 'foot' }, watcher.activeJobId ? `job ${safeText(watcher.activeJobId)} running` : watcher.interval === null ? 'interval unknown' : `every ${fmtNum(watcher.interval)}s`),
  ));
  const nodes = [h('div', { class: 'adm-ingest-stats' }, ...statTiles)];
  if (progress) {
    const total = Number(progress.total) || 0;
    const processed = Number(progress.processed) || 0;
    const pct = total > 0 ? Math.round(Math.min(1, processed / total) * 100) : 0;
    const status = String(progress.status || 'running');
    nodes.push(h('div', { class: 'adm-ingest-progress', 'aria-live': 'polite' },
      h('div', { class: 'adm-meter-foot', style: { marginTop: '0', marginBottom: '5px' } },
        h('span', {}, h('strong', {}, status), progress.sourceId ? ` · source #${progress.sourceId}` : '', progress.message ? ` · ${progress.message}` : ''),
        h('span', {}, total > 0 ? `${fmtNum(processed)} / ${fmtNum(total)}` : `${fmtNum(processed)} processed`),
      ),
      h('div', { class: `adm-meter${status === 'error' ? ' bad' : ''}`.trim() }, h('i', { style: { width: `${total > 0 ? pct : 18}%` } })),
    ));
  }
  return h('div', {}, ...nodes);
}

function sourceCard(source, { onEdit, onDelete, onPatch, onScan }) {
  const counts = ['pending', 'review', 'organized', 'error'].map((key) => h('div', { class: 'adm-audit-item' },
    h('div', { class: 'label' }, key === 'error' ? 'errors' : key),
    h('div', { class: 'value' }, fmtNum(countOf(source, key))),
  ));
  const autoToggle = h('input', { type: 'checkbox', checked: source.autoMatch ? true : undefined });
  autoToggle.addEventListener('change', async () => {
    autoToggle.disabled = true;
    try {
      await onPatch(source, { autoMatch: autoToggle.checked }, `Auto-match ${autoToggle.checked ? 'on' : 'off'} for “${source.name}”.`);
    } catch {
      autoToggle.checked = !autoToggle.checked;
    } finally {
      autoToggle.disabled = false;
    }
  });
  const enabledToggle = h('input', { type: 'checkbox', checked: source.enabled ? true : undefined });
  enabledToggle.addEventListener('change', async () => {
    enabledToggle.disabled = true;
    try {
      await onPatch(source, { enabled: enabledToggle.checked }, `Source “${source.name}” ${enabledToggle.checked ? 'enabled' : 'paused'}.`);
    } catch {
      enabledToggle.checked = !enabledToggle.checked;
    } finally {
      enabledToggle.disabled = false;
    }
  });
  const threshold = Number.isFinite(Number(source.minConfidence)) ? fmtPct(Number(source.minConfidence) * 100) : '—';
  return h('article', { class: 'adm-card adm-ingest-source' },
    h('div', { class: 'adm-card-head' },
      h('div', { style: { minWidth: 0 } },
        h('h2', { class: 'truncate', title: source.name }, safeText(source.name)),
        h('div', { class: 'row wrap', style: { gap: '5px', marginTop: '5px' } },
          badge('neutral', safeText(source.kind)),
          badge(source.enabled ? 'good' : 'neutral', source.enabled ? 'enabled' : 'paused'),
          badge('neutral', safeText(source.action, 'move')),
          badge('neutral', `min ${threshold}`),
          source.autoMatch ? badge('accent', 'auto-match') : badge('neutral', 'manual match only'),
        ),
      ),
      h('div', { class: 'spacer' }),
      h('div', { class: 'adm-ingest-switches' },
        h('label', { class: 'adm-ingest-switch', title: 'Search providers automatically for this source (needs a configured provider and the global autoMatch setting)' },
          autoToggle, h('span', {}, 'Auto-match')),
        h('label', { class: 'adm-ingest-switch', title: 'Watcher and Scan all process this source' },
          enabledToggle, h('span', {}, 'Enabled')),
      ),
    ),
    h('div', { class: 'adm-ingest-path' }, safeText(source.path)),
    h('div', { class: 'adm-ingest-dest' },
      h('span', { class: 'adm-field-label' }, 'Destination'),
      h('span', {}, source.libraryName ? `${source.libraryName}` : 'Auto — first matching library, or a new “Ingested” library'),
      source.destinationPath ? h('span', { class: 'mono small faint', title: source.destinationPath }, source.destinationPath) : null,
    ),
    h('div', { class: 'adm-audit adm-ingest-counts' }, ...counts),
    h('div', { class: 'adm-ingest-last' },
      h('span', {}, h('strong', {}, 'Last run: '), source.lastScanAt ? fmtAgo(source.lastScanAt) : 'never'),
      h('span', { class: 'truncate', title: lastResultText(source.lastResult) }, h('strong', {}, 'Result: '), lastResultText(source.lastResult)),
      h('span', {}, h('strong', {}, 'Recursive: '), source.recursive ? 'yes' : 'no', ` · settle ${fmtNum(source.settleSeconds ?? 15)}s`),
    ),
    h('div', { class: 'row wrap', style: { marginTop: '12px', gap: '6px' } },
      btn('Scan now', (event) => onScan(event.currentTarget, source), { kind: 'primary', iconText: '⚡' }),
      btn('Edit', () => onEdit(source), { iconText: '✎' }),
      btn('Delete', () => onDelete(source), { kind: 'danger', small: true }),
    ),
  );
}

function sourceForm(source, libraries, refresh) {
  const editing = Boolean(source?.id);
  let name = source?.name || '';
  let kind = source?.kind || 'movies';
  let path = source?.path || '';
  let libraryId = source?.libraryId ? String(source.libraryId) : '';
  let action = source?.action || 'move';
  let confidencePct = Math.round((Number(source?.minConfidence ?? 0.5)) * 100);
  let settleSeconds = source?.settleSeconds ?? 15;
  let autoMatch = source?.autoMatch ?? true;
  let holdUnmatched = source?.holdUnmatched ?? true;
  let recursive = source?.recursive ?? true;
  let enabled = source?.enabled ?? true;
  const libraryOptions = [
    { value: '', label: 'Auto — first matching library, or create one' },
    ...libraries.map((library) => ({ value: String(library.id), label: `${library.name} (${library.kind})` })),
  ];
  const toggle = (label, help, get, set) => {
    const box = h('input', { type: 'checkbox', checked: get() ? true : undefined });
    box.addEventListener('change', () => set(box.checked));
    return h('label', { class: 'adm-check span-2' }, box, h('span', { class: 'adm-check-copy' }, h('strong', {}, label), h('span', {}, help)));
  };
  const body = h('div', {},
    formGrid(
      textField({ label: 'Name', value: name, placeholder: 'Movies drop', required: true, maxlength: 120, onInput: (value) => { name = value; } }),
      selectField({ label: 'Kind', value: kind, options: KIND_OPTIONS, onInput: (value) => { kind = value; }, help: 'Controls accepted file types and destination naming.' }),
      textField({
        label: 'Source folder', value: path, placeholder: '/data/ingest/movies', required: true, span: true,
        onInput: (value) => { path = value; },
        help: 'Absolute path on the server. Defaults: /data/ingest/movies (movies), /data/ingest/tv (shows), /data/ingest/music, /data/ingest/photos. The optional MEDIA_HOST_DIR mount appears read-only at /media.',
      }),
      selectField({ label: 'Destination library', value: libraryId, options: libraryOptions, span: true, onInput: (value) => { libraryId = value; }, help: 'Leaving this on Auto creates or reuses a library for this kind. The destination is always a library root.' }),
      selectField({ label: 'File action', value: action, options: ACTION_OPTIONS, onInput: (value) => { action = value; }, help: 'Move is the default. Symlinks point at the drop file — deleting the source later breaks playback.' }),
      h('div', { class: 'adm-field' },
        h('label', { for: 'adm-ingest-confidence' }, 'Confidence threshold (%)'),
        h('input', {
          class: 'input', id: 'adm-ingest-confidence', type: 'number', min: 0, max: 100, step: 1,
          value: String(confidencePct),
          oninput: (event) => { confidencePct = event.currentTarget.value === '' ? '' : Number(event.currentTarget.value); },
        }),
        h('div', { class: 'help' }, 'Below this score, held items go to the review queue (when “hold unmatched” is on). 50% is the default.'),
      ),
      h('div', { class: 'adm-field' },
        h('label', { for: 'adm-ingest-settle' }, 'Settle seconds'),
        h('input', {
          class: 'input', id: 'adm-ingest-settle', type: 'number', min: 0, max: 3600, step: 1,
          value: String(settleSeconds),
          oninput: (event) => { settleSeconds = event.currentTarget.value === '' ? '' : Number(event.currentTarget.value); },
        }),
        h('div', { class: 'help' }, 'Skip files modified more recently than this, so active downloads are not moved mid-write. 0–3600; 15 is the default.'),
      ),
      toggle('Auto-match with providers', 'Search configured providers for this source. The global autoMatch setting still has to be on.', () => autoMatch, (value) => { autoMatch = value; }),
      toggle('Hold unmatched in review', 'Keep uncertain files in place and queue them for review instead of organizing with parsed names.', () => holdUnmatched, (value) => { holdUnmatched = value; }),
      toggle('Recursive discovery', 'Walk subfolders. Useful for season folders and album directories.', () => recursive, (value) => { recursive = value; }),
      toggle('Enabled', 'Include this source in watcher runs and Scan all. Scan now still works while paused.', () => enabled, (value) => { enabled = value; }),
    ),
    h('div', { class: 'adm-note' }, editing
      ? 'Editing a source never touches files or existing items. Settings apply to the next run.'
      : 'The drop folder must already exist as an absolute directory on the server. New files are discovered only after they settle.'),
  );
  formModal({
    title: editing ? `Edit “${source.name}”` : 'Add drop folder',
    body,
    wide: true,
    submitLabel: editing ? 'Save source' : 'Add source',
    onSubmit: async () => {
      const cleanName = String(name || '').trim();
      const cleanPath = String(path || '').trim();
      if (!cleanName) throw new Error('Give the source a name.');
      if (cleanName.length > 120) throw new Error('Name must be 120 characters or fewer.');
      if (!cleanPath.startsWith('/')) throw new Error('Source path must be absolute — start with /.');
      const pct = Number(confidencePct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Confidence threshold must be between 0 and 100.');
      const settle = Number(settleSeconds);
      if (!Number.isInteger(settle) || settle < 0 || settle > 3600) throw new Error('Settle seconds must be an integer between 0 and 3600.');
      const payload = {
        name: cleanName,
        kind,
        path: cleanPath,
        libraryId: libraryId ? Number(libraryId) : null,
        action,
        autoMatch,
        minConfidence: Math.round(pct) / 100,
        holdUnmatched,
        recursive,
        settleSeconds: settle,
        enabled,
      };
      if (editing) {
        await adminPatch(`/api/ingest/sources/${source.id}`, payload);
        toast(`Source “${cleanName}” updated.`, 'success');
      } else {
        await adminPost('/api/ingest/sources', payload);
        toast(`Drop folder “${cleanName}” added.`, 'success');
      }
      refresh();
    },
  });
}

function dropHintCard() {
  return card('Where to drop files', [
    h('p', { class: 'adm-ingest-lead' },
      'Drop folders are created under DATA_DIR. These are the default host paths — create or point a source at any mounted absolute directory. Files are only processed after they stop changing.'),
    h('div', { class: 'adm-ingest-drop-grid' },
      ...DROP_PATHS.map((entry) => h('div', { class: 'adm-ingest-drop' },
        h('div', { class: 'adm-field-label' }, entry.kind),
        h('code', {}, entry.path),
        btn('Copy', () => copyToClipboard(entry.path, 'Path copied.'), { small: true }),
      )),
    ),
    h('div', { class: 'adm-note', style: { marginTop: '10px' } },
      h('strong', {}, 'Host media mount: '),
      'the optional MEDIA_HOST_DIR is mounted read-only at ',
      h('code', {}, '/media'),
      '. For large existing collections, use a source pointing inside /media with the ',
      h('strong', {}, 'symlink'),
      ' action — organize writes only symlinks into the library. Removing the mount later will break playback.',
    ),
  ], { className: 'adm-ingest-drop-card' });
}

function candidateCard(candidate, onUse) {
  const remotePoster = candidate?.posterUrl && !isLocalAsset(candidate.posterUrl);
  const score = Number(candidate?.score);
  const useButton = btn('Use this', (event) => onUse(event.currentTarget, candidate), {
    kind: 'primary', small: true, disabled: !candidate?.provider || !candidate?.providerId,
    title: candidate?.provider && candidate?.providerId ? `Organize with ${candidate.provider}` : 'This candidate has no provider id',
  });
  return h('article', { class: 'adm-ingest-cand' },
    h('div', { class: 'adm-ingest-cand-art' },
      h('img', { src: candidatePoster(candidate), alt: '', loading: 'lazy' }),
    ),
    h('div', { class: 'adm-ingest-cand-body' },
      h('div', { class: 'row wrap', style: { gap: '5px' } },
        badge('neutral', safeText(candidate?.provider)),
        badge(score >= 0.8 ? 'good' : score >= 0.55 ? 'warn' : 'neutral', Number.isFinite(score) ? fmtPct(score * 100) : '—'),
        candidate?.year ? badge('neutral', candidate.year) : null,
        candidate?.kind ? badge('neutral', candidate.kind) : null,
      ),
      h('strong', { class: 'adm-ingest-cand-title', title: candidate?.title }, safeText(candidate?.title, 'Untitled')),
      candidate?.originalTitle && candidate.originalTitle !== candidate.title
        ? h('div', { class: 'faint small truncate' }, candidate.originalTitle)
        : null,
      candidate?.rating !== null && candidate?.rating !== undefined
        ? h('div', { class: 'faint small mono' }, `rating ${Number(candidate.rating).toFixed(1)}`)
        : null,
      h('div', { class: 'row wrap', style: { gap: '6px', marginTop: 'auto' } },
        useButton,
        remotePoster
          ? h('a', { class: 'mini-link', href: candidate.posterUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Open the provider poster; the app CSP blocks third-party images' }, 'Poster ↗')
          : null,
      ),
    ),
  );
}

function reviewCard(item, refresh) {
  const parsed = item.parsed || {};
  const providerKind = providerKindFor(item.sourceKind);
  const confidence = Number(item.confidence);
  const errors = [];
  const runAction = async (button, path, body, busyLabel, successMessage) => {
    await withBusy(button, async () => {
      try {
        await adminPost(path, body);
        toast(successMessage, 'success');
        await refresh();
      } catch (error) {
        toast(apiError(error), 'error');
      }
    }, busyLabel);
  };
  const candidates = Array.isArray(item.candidates) ? item.candidates : [];
  const searchInput = textInput({ value: '', placeholder: parsed.title ? `Blank uses “${parsed.title}”` : 'Title to search for' });
  searchInput.setAttribute('aria-label', `Search providers for ${item.name}`);
  const searchButton = btn('Search providers', async (event) => {
    const query = searchInput.value.trim();
    await runAction(event.currentTarget, `/api/ingest/items/${item.id}/search`, query ? { query } : {}, 'Searching…', query ? `Searched providers for “${query}”.` : 'Searched providers with the parsed title.');
  }, { iconText: '⌕' });

  const titleInput = textInput({ value: item.title || parsed.title || '', placeholder: 'Canonical title' });
  titleInput.setAttribute('aria-label', 'Manual title');
  const yearInput = textInput({ value: item.year ?? parsed.year ?? '', type: 'number', min: 1870, max: 2200, placeholder: 'Year' });
  yearInput.setAttribute('aria-label', 'Manual year');
  const seasonInput = textInput({ value: item.seasonNumber ?? parsed.season ?? '', type: 'number', min: 0, max: 999, placeholder: 'Season' });
  seasonInput.setAttribute('aria-label', 'Manual season number');
  const episodeInput = textInput({ value: item.episodeNumber ?? parsed.episode ?? '', type: 'number', min: 0, max: 9999, placeholder: 'Episode' });
  episodeInput.setAttribute('aria-label', 'Manual episode number');
  const manualButton = btn('Organize with this', async (event) => {
    const title = titleInput.value.trim();
    const yearRaw = yearInput.value.trim();
    const seasonRaw = seasonInput.value.trim();
    const episodeRaw = episodeInput.value.trim();
    if (!title) {
      toast('Enter a title first. Manual organizing needs a name to write.', 'error');
      titleInput.focus();
      return;
    }
    const year = yearRaw ? Number(yearRaw) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1870 || year > 2200)) {
      toast('Year must be an integer between 1870 and 2200, or blank.', 'error');
      yearInput.focus();
      return;
    }
    const body = { title, year };
    if (item.sourceKind === 'shows') {
      const season = seasonRaw ? Number(seasonRaw) : null;
      const episode = episodeRaw ? Number(episodeRaw) : null;
      if (season !== null && (!Number.isInteger(season) || season < 0 || season > 999)) {
        toast('Season must be an integer between 0 and 999, or blank.', 'error');
        return;
      }
      if (episode !== null && (!Number.isInteger(episode) || episode < 0 || episode > 9999)) {
        toast('Episode must be an integer between 0 and 9999, or blank.', 'error');
        return;
      }
      body.season = season;
      body.episode = episode;
    }
    await runAction(event.currentTarget, `/api/ingest/items/${item.id}/match`, body, 'Organizing…', `Organized “${title}”.`);
  }, { kind: 'primary' });

  if (providerKind) {
    errors.push(h('div', { class: 'adm-ingest-search' }, searchInput, searchButton));
    errors.push(candidates.length
      ? h('div', { class: 'adm-ingest-cand-grid' }, ...candidates.map((candidate) => candidateCard(candidate, (button, chosen) => {
        runAction(button, `/api/ingest/items/${item.id}/match`, { provider: chosen.provider, providerId: chosen.providerId }, 'Organizing…', `Organized with ${chosen.provider}: “${chosen.title}”.`);
      })))
      : h('div', { class: 'adm-ingest-no-candidates' }, 'No candidates stored yet. Search providers, or enter a title manually below.'));
  } else {
    errors.push(h('div', { class: 'adm-note' }, 'Music and photos are not identified by public providers. Organize uses parsed tags and folder names, or enter a manual title below.'));
  }

  const manualFields = [field('Title', titleInput, { span: true }), field('Year', yearInput)];
  if (item.sourceKind === 'shows') {
    manualFields.push(field('Season', seasonInput), field('Episode', episodeInput));
  }
  return h('article', { class: 'adm-ingest-review' },
    h('div', { class: 'adm-ingest-review-head' },
      h('div', { style: { minWidth: 0 } },
        h('h3', { class: 'truncate', title: item.name }, safeText(item.name, 'Untitled file')),
        h('div', { class: 'row wrap', style: { gap: '5px', marginTop: '6px' } },
          badge('review', safeText(item.status)),
          badge('neutral', safeText(item.sourceKind)),
          item.provider ? badge('accent', safeText(item.provider)) : null,
          badge(confidence >= 0.8 ? 'good' : confidence >= 0.55 ? 'warn' : 'bad', Number.isFinite(confidence) ? `${fmtPct(confidence * 100)} confidence` : 'confidence unknown'),
          badge('neutral', item.sizeBytes ? fmtBytesSafe(item.sizeBytes) : 'size unknown'),
        ),
        h('div', { class: 'adm-ingest-path small' }, safeText(item.path)),
      ),
      h('div', { class: 'adm-ingest-review-bits' },
        h('span', {}, h('strong', {}, 'parsed: '), safeText(parsed.title, '—'), parsed.year ? ` (${parsed.year})` : ''),
        item.sourceKind === 'shows' ? h('span', {}, h('strong', {}, 'episode: '), `S${safeText(parsed.season, '?')}E${safeText(parsed.episode, '?')}`) : null,
        h('span', {}, h('strong', {}, 'source: '), safeText(item.sourceName, `#${item.sourceId}`)),
        h('span', {}, h('strong', {}, 'updated: '), fmtAgo(item.updatedAt)),
      ),
    ),
    item.error ? h('div', { class: 'adm-ingest-error', role: 'alert' }, h('strong', {}, 'Last error: '), safeText(item.error)) : null,
    item.notes ? h('div', { class: 'faint small' }, h('strong', {}, 'Notes: '), safeText(item.notes)) : null,
    ...errors,
    h('div', { class: 'adm-ingest-manual' },
      formGrid(...manualFields),
      h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '4px' } },
        manualButton,
        btn('Organize parsed', (event) => runAction(event.currentTarget, `/api/ingest/items/${item.id}/organize`, {}, 'Organizing…', 'Organized with parsed fields.'), { title: 'Use the parsed title/year without provider metadata' }),
        btn('Ignore', (event) => runAction(event.currentTarget, `/api/ingest/items/${item.id}/ignore`, {}, 'Ignoring…', 'Item ignored. The file was not touched.'), { kind: 'ghost', title: 'Hide this item from the queue; the source file stays in place' }),
        btn('Retry', (event) => runAction(event.currentTarget, `/api/ingest/items/${item.id}/retry`, {}, 'Retrying…', 'Retry processed — queue refreshed.'), { kind: 'ghost', title: 'Reset to pending and process again' }),
      ),
    ),
  );
}

function queueBlock(items, meta, refresh, setPage) {
  const sub = meta.total ? `${fmtNum(meta.total)} item${meta.total === 1 ? '' : 's'} waiting · confidence and provider candidates are cached with each item` : 'nothing waiting for a human';
  const body = [
    h('div', { class: 'adm-note' }, 'Pick a provider candidate, search again, or enter the title manually. “Organize parsed” uses filename/folder fields only. Organizing moves or links the file according to the source action; ignoring never touches the file.'),
  ];
  if (!items.length) {
    body.push(emptyState('Review queue is empty', 'No ambiguous files right now. New arrivals below the source confidence threshold land here. Drop something into a watched folder, then hit Scan now.', {
      emoji: '🕵️',
      actions: [
        btn('Refresh queue', refresh, { small: true }),
        h('a', { class: 'btn ghost small', href: '#settings' }, 'Tune thresholds'),
      ],
    }));
  } else {
    body.push(h('div', { class: 'adm-ingest-queue' }, ...items.map((item) => reviewCard(item, refresh))));
    if (meta.total > meta.pageSize) {
      body.push(pagination({ page: meta.page, pageSize: meta.pageSize, total: meta.total, onPage: setPage }));
    }
    if (meta.counts && Number(meta.counts.pending) > 0) {
      body.push(h('div', { class: 'faint small mono' }, `${fmtNum(meta.counts.pending)} pending item(s) are still being processed; they appear here if confidence stays low.`));
    }
  }
  return card('Review queue', body, {
    sub,
    actions: [btn('Refresh', refresh, { iconText: '↻' })],
  });
}

function activityBlock(items, meta, state, { refresh, setStatus, setPage, retry }) {
  const columns = [
    {
      label: 'Item',
      className: 'adm-cell-title',
      render: (item) => h('div', {},
        h('strong', { title: item.name }, safeText(item.name, '—')),
        h('span', {}, `${safeText(item.sourceKind)} · ${safeText(item.sourceName, `source #${item.sourceId}`)}`),
      ),
    },
    { label: 'Status', render: (item) => badge(item.status, safeText(item.status)) },
    {
      label: 'Provider',
      render: (item) => item.provider
        ? h('div', { class: 'mono small' }, safeText(item.provider), h('div', { class: 'faint small truncate', title: item.providerId }, safeText(item.providerId, '')))
        : h('span', { class: 'adm-muted' }, '—'),
    },
    {
      label: 'Destination',
      className: 'wrap',
      render: (item) => h('div', {},
        item.destPath ? h('div', { class: 'mono small', style: { overflowWrap: 'anywhere' } }, item.destPath) : h('span', { class: 'adm-muted' }, 'not organized'),
        item.mediaId ? h('a', { class: 'mini-link', href: `/item/${item.mediaId}`, target: '_blank', rel: 'noopener' }, `Media #${item.mediaId} ↗`) : null,
      ),
    },
    { label: 'Size', render: (item) => h('span', { class: 'num' }, item.sizeBytes ? fmtBytesSafe(item.sizeBytes) : '—') },
    { label: 'Updated', render: (item) => h('span', { class: 'num', title: item.updatedAt }, fmtAgo(item.updatedAt)) },
    {
      label: 'Error / actions',
      className: 'wrap',
      render: (item) => h('div', {},
        item.error ? h('div', { class: 'adm-ingest-error small', title: item.error }, safeText(item.error)) : null,
        item.status === 'error'
          ? btn('Retry', (event) => retry(event.currentTarget, item), { small: true, iconText: '↻' })
          : null,
        item.mediaId
          ? h('a', { class: 'mini-link', href: `/item/${item.mediaId}`, target: '_blank', rel: 'noopener' }, 'Open ↗')
          : null,
      ),
    },
  ];
  const table = dataTable({
    columns,
    rows: items,
    caption: `Ingestion activity — ${fmtNum(items.length)} row(s) on this page`,
    empty: emptyState('No ingestion activity yet', 'Organized, ignored and failed items show up after a run. Start with Scan now on a source, or drop files into a watched folder.', { emoji: '🧹' }),
  });
  const filter = selectField({
    label: 'Status filter',
    value: state.activityStatus,
    options: STATUS_OPTIONS,
  });
  filter.classList.add('adm-ingest-filter');
  filter.querySelector('select')?.addEventListener('change', (event) => setStatus(event.currentTarget.value));
  const pageSize = selectField({
    label: 'Rows',
    value: String(state.activityPageSize),
    options: [25, 50, 100].map((value) => ({ value: String(value), label: `${value} rows` })),
  });
  pageSize.classList.add('adm-ingest-filter');
  pageSize.querySelector('select')?.addEventListener('change', (event) => setStatus(state.activityStatus, Number(event.currentTarget.value)));
  return card('Recent activity', [
    h('div', { class: 'adm-ingest-activity-tools' }, filter, pageSize,
      h('span', { class: 'spacer' }),
      btn('Refresh', refresh, { iconText: '↻' })),
    table,
    meta.total > meta.pageSize ? pagination({ page: meta.page, pageSize: meta.pageSize, total: meta.total, onPage: setPage }) : null,
  ], { sub: `${fmtNum(meta.total)} item(s) in this filter · newest first` });
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' }, skeletonRows(10)));
    let disposed = false;
    let progress = null;
    let latestStats = null;
    let latestSources = [];
    let statsFailed = false;
    let lastItemErrorToast = 0;
    let queueDirty = false;
    const timers = new Map();
    const ui = {
      queuePage: 1,
      queuePageSize: 20,
      activityStatus: 'organized',
      activityPage: 1,
      activityPageSize: 25,
    };
    const providerSlot = h('div');
    const statsSlot = h('div');
    const sourceSlot = h('div', { class: 'adm-ingest-source-grid' });
    const queueSlot = h('div');
    const activitySlot = h('div');

    const isGone = () => disposed || !host.isConnected;
    const isAbort = (error) => error?.name === 'AbortError';
    const schedule = (key, fn, wait = 900) => {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        if (!isGone()) fn();
      }, wait));
    };

    function sourceFallbackCounts() {
      const counts = { pending: 0, review: 0, organized: 0, error: 0, ignored: 0 };
      for (const source of latestSources) {
        for (const key of Object.keys(counts)) counts[key] += countOf(source, key);
      }
      return counts;
    }

    function paintStats(stats, note) {
      if (isGone()) return;
      const fallback = latestSources.length ? sourceFallbackCounts() : null;
      const effective = stats || (fallback ? { counts: fallback } : null);
      if (!effective) {
        statsSlot.replaceChildren(h('div', { class: 'adm-note warn' },
          note || 'Stats are unavailable right now.',
          btn('Retry stats', loadStats, { small: true }),
        ));
        return;
      }
      statsSlot.replaceChildren(...[
        renderStats(effective, progress),
        note ? h('div', { class: 'adm-note warn', style: { marginTop: '8px' } },
          note,
          ' ',
          btn('Retry stats', loadStats, { small: true })) : null,
      ].filter(Boolean));
    }

    async function loadProviders() {
      providerSlot.replaceChildren(skeletonGrid(3));
      try {
        const res = await adminGet('/api/ingest/providers', { signal: ctx.signal });
        if (isGone()) return;
        const providers = Array.isArray(res) ? res : Array.isArray(res?.providers) ? res.providers : [];
        providerSlot.replaceChildren(renderProviders(providers));
      } catch (error) {
        if (isAbort(error) || isGone()) return;
        providerSlot.replaceChildren(errorState(error, loadProviders, { title: 'Provider status did not load' }));
      }
    }

    async function loadStats() {
      try {
        const res = await adminGet('/api/ingest/stats', { signal: ctx.signal });
        if (isGone()) return;
        latestStats = res?.stats || res || {};
        statsFailed = false;
        paintStats(latestStats, null);
      } catch (error) {
        if (isAbort(error) || isGone()) return;
        latestStats = null;
        statsFailed = true;
        paintStats(null, `Stats did not load: ${apiError(error)}${latestSources.length ? ' Tiles below are summed from per-source counts.' : ''}`);
      }
    }

    async function loadSources() {
      sourceSlot.replaceChildren(skeletonGrid(2));
      try {
        const res = await adminGet('/api/ingest/sources', { signal: ctx.signal });
        if (isGone()) return;
        const sources = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
        latestSources = sources;
        if (!sources.length) {
          sourceSlot.replaceChildren(emptyState('No drop folders yet', 'The server bootstraps four default sources when the table is empty: movies, tv, music and photos under /data/ingest. Add a source manually if yours are missing.', {
            emoji: '📥',
            actions: [btn('Add the first source', () => openSourceForm(null), { kind: 'primary', small: false })],
          }));
        } else {
          sourceSlot.replaceChildren(...sources.map((source) => sourceCard(source, {
            onEdit: (item) => openSourceForm(item),
            onDelete: deleteSource,
            onPatch: patchSource,
            onScan: scanSource,
          })));
        }
        if (!latestStats && statsFailed) paintStats(null, 'Stats did not load. Tiles are summed from per-source counts.');
      } catch (error) {
        if (isAbort(error) || isGone()) return;
        sourceSlot.replaceChildren(errorState(error, loadSources, { title: 'Drop folders did not load' }));
      }
    }

    async function loadQueue(force = false) {
      queueSlot.replaceChildren(skeletonRows(4));
      const params = new URLSearchParams({ status: 'review', page: String(ui.queuePage), pageSize: String(ui.queuePageSize) });
      try {
        const res = await adminGet(`/api/ingest/items?${params.toString()}`, { signal: ctx.signal });
        if (isGone()) return;
        const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
        const total = Number.isFinite(Number(res?.total)) ? Number(res.total) : items.length;
        const page = Number(res?.page) || ui.queuePage;
        const pageSize = Number(res?.pageSize) || ui.queuePageSize;
        if (!items.length && total > 0 && ui.queuePage > 1 && !force) {
          ui.queuePage = Math.max(1, Math.ceil(total / pageSize));
          await loadQueue(true);
          return;
        }
        ui.queuePage = page;
        ui.queuePageSize = pageSize;
        queueSlot.replaceChildren(queueBlock(items, { total, page, pageSize, counts: res?.counts }, () => refreshQueueData(), (next) => {
          ui.queuePage = next;
          loadQueue();
        }));
      } catch (error) {
        if (isAbort(error) || isGone()) return;
        queueSlot.replaceChildren(h('div', { class: 'adm-card' }, errorState(error, () => loadQueue(), { title: 'Review queue did not load' })));
      }
    }

    async function loadActivity() {
      activitySlot.replaceChildren(skeletonRows(5));
      const params = new URLSearchParams({ page: String(ui.activityPage), pageSize: String(ui.activityPageSize) });
      if (ui.activityStatus) params.set('status', ui.activityStatus);
      try {
        const res = await adminGet(`/api/ingest/items?${params.toString()}`, { signal: ctx.signal });
        if (isGone()) return;
        const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
        const total = Number.isFinite(Number(res?.total)) ? Number(res.total) : items.length;
        const page = Number(res?.page) || ui.activityPage;
        const pageSize = Number(res?.pageSize) || ui.activityPageSize;
        ui.activityPage = page;
        activitySlot.replaceChildren(activityBlock(items, { total, page, pageSize }, ui, {
          refresh: loadActivity,
          setStatus: (status, size) => {
            ui.activityStatus = status;
            ui.activityPage = 1;
            if (size) ui.activityPageSize = size;
            loadActivity();
          },
          setPage: (next) => { ui.activityPage = next; loadActivity(); },
          retry: retryActivity,
        }));
      } catch (error) {
        if (isAbort(error) || isGone()) return;
        activitySlot.replaceChildren(h('div', { class: 'adm-card' }, errorState(error, loadActivity, { title: 'Activity did not load' })));
      }
    }

    async function refreshQueueData() {
      await Promise.all([loadStats(), loadSources(), loadQueue(), loadActivity()]);
    }

    async function scanSource(button, source) {
      await withBusy(button, async () => {
        try {
          const result = await adminPost(`/api/ingest/sources/${source.id}/scan`, {});
          const jobId = result?.jobId ?? result?.job?.id;
          toast(jobId ? `Scan queued for “${source.name}” — job #${jobId}.` : `Scan requested for “${source.name}”.`, 'success');
          schedule('stats', loadStats, 600);
          schedule('sources', loadSources, 1200);
        } catch (error) {
          const hint = error?.code === 'ingest_in_progress' && error?.details?.jobId ? ` Job #${error.details.jobId} is already running.` : '';
          toast(`${apiError(error)}${hint}`, 'error');
        }
      }, 'Queueing…');
    }

    async function patchSource(source, payload, message) {
      try {
        await adminPatch(`/api/ingest/sources/${source.id}`, payload);
        toast(message, 'success');
        await Promise.all([loadSources(), loadStats()]);
      } catch (error) {
        toast(apiError(error), 'error');
        throw error;
      }
    }

    async function deleteSource(source) {
      const ok = await confirmDialog(`Delete source “${source.name}”?`, 'Removes the source row and its ingestion history from SQLite. Files in the drop folder and destination library are never deleted.', { confirmLabel: 'Delete source', danger: true });
      if (!ok) return;
      try {
        const result = await adminDel(`/api/ingest/sources/${source.id}`);
        const removed = Number(result?.removedItems);
        toast(Number.isFinite(removed) && removed > 0 ? `Source deleted; ${fmtNum(removed)} item row(s) removed. Files untouched.` : 'Source deleted. The files survived.', 'success');
        await Promise.all([loadSources(), loadStats(), loadQueue(), loadActivity()]);
      } catch (error) {
        toast(apiError(error), 'error');
      }
    }

    async function retryActivity(button, item) {
      await withBusy(button, async () => {
        try {
          await adminPost(`/api/ingest/items/${item.id}/retry`, {});
          toast(`Retry processed for “${item.name}”.`, 'success');
          await Promise.all([loadActivity(), loadStats(), loadQueue(), loadSources()]);
        } catch (error) {
          toast(apiError(error), 'error');
        }
      }, 'Retrying…');
    }

    async function openSourceForm(source) {
      let libraries = [];
      try {
        const res = await adminGet('/api/libraries', { signal: ctx.signal });
        libraries = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      } catch (error) {
        if (isAbort(error) || isGone()) return;
        toast(`Library list unavailable (${apiError(error)}). Auto destination still works.`, 'info');
      }
      sourceForm(source, libraries, () => { loadSources(); loadStats(); });
    }

    async function scanAll(button) {
      await withBusy(button, async () => {
        try {
          const result = await adminPost('/api/ingest/scan-all', {});
          const jobId = result?.jobId ?? result?.job?.id;
          toast(jobId ? `Scan-all queued — job #${jobId}.` : 'Scan-all requested.', 'success');
          schedule('stats', loadStats, 700);
          schedule('sources', loadSources, 1400);
        } catch (error) {
          const hint = error?.code === 'ingest_in_progress' && error?.details?.jobId ? ` Job #${error.details.jobId} is already running.` : '';
          toast(`${apiError(error)}${hint}`, 'error');
        }
      }, 'Queueing…');
    }

    const sourceHead = h('div', { class: 'adm-ingest-source-head' },
      h('div', {},
        h('h2', {}, 'Drop-folder sources'),
        h('span', { class: 'adm-card-sub' }, 'each source owns a folder, a destination library and a file action'),
      ),
      h('span', { class: 'spacer' }),
      btn('Add source', () => openSourceForm(null), { kind: 'primary', iconText: '＋' }),
    );

    const section = h('div', { class: 'adm-section' },
      pageHead('Ingestion', 'Drop folders get identified through public providers, organized into libraries, and anything ambiguous waits in the review queue.', [
        btn('Scan all', (event) => scanAll(event.currentTarget), { iconText: '⚡', title: 'Queue one ingest job for every enabled source' }),
        btn('Add source', () => openSourceForm(null), { kind: 'primary', iconText: '＋' }),
        btn('Refresh', async (event) => {
          await withBusy(event.currentTarget, async () => {
            await Promise.all([loadProviders(), loadStats(), loadSources(), loadQueue(), loadActivity()]);
          }, 'Refreshing…');
        }, { iconText: '↻' }),
      ]),
      statsSlot,
      card('Providers', [providerSlot], { sub: 'configured/enabled state and every outbound host, straight from the provider registry' }),
      dropHintCard(),
      h('section', { class: 'adm-ingest-sources' }, sourceHead, sourceSlot),
      queueSlot,
      activitySlot,
      h('div', { class: 'adm-note' },
        h('strong', {}, 'Files are sacred: '),
        'deleting a source or ignoring an item removes database rows only. The organizer never overwrites existing files; collisions get a “ (2)” suffix. Symlinked destinations break if the drop file is later removed.'),
    );
    host.replaceChildren(section);

    const offProgress = onAdminEvent('ingest.progress', (data) => {
      progress = { ...(data || {}), receivedAt: Date.now() };
      if (latestStats || latestSources.length) paintStats(latestStats, null);
      schedule('stats', loadStats, 800);
      schedule('sources', loadSources, 1600);
    });
    const offItem = onAdminEvent('ingest.item', (data) => {
      schedule('stats', loadStats, 600);
      schedule('sources', loadSources, 1400);
      schedule('activity', loadActivity, 900);
      if (queueSlot.contains(document.activeElement)) queueDirty = true;
      else schedule('queue', loadQueue, 1000);
      if (data?.status === 'error' && Date.now() - lastItemErrorToast > 8000) {
        lastItemErrorToast = Date.now();
        toast(`Ingest item #${data.itemId ?? '?'} failed — details in Recent activity.`, 'error');
      }
    });
    const onQueueFocusOut = () => {
      if (!queueDirty) return;
      queueDirty = false;
      schedule('queue', loadQueue, 250);
    };
    queueSlot.addEventListener('focusout', onQueueFocusOut);

    await Promise.all([loadProviders(), loadStats(), loadSources(), loadQueue(), loadActivity()]);

    return () => {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      offProgress();
      offItem();
      queueSlot.removeEventListener('focusout', onQueueFocusOut);
    };
  },
};

