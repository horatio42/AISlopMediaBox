// Dashboard: /api/admin/overview + /api/stats fallback. SVG donut, CSS bars, dense cards.
import { fmtDuration } from '../api.js';
import {
  h, adminGet, pageHead, card, btn, badge, emptyState, errorState, skeletonGrid,
  fmtBytesSafe, fmtNum, fmtPct, fmtUptime, fmtAgo, fmtWhen, num, kv, listRow, safeText,
} from './core.js';

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--accent)', 'var(--muted)'];

function statCard(label, value, foot, { accent = false, small = false } = {}) {
  return h('div', { class: 'adm-stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value${accent ? ' accent' : ''}${small ? ' small' : ''}`.trim() }, value),
    foot ? h('div', { class: 'foot' }, foot) : null,
  );
}

function diskCard(disk, storage) {
  const percent = num(disk.percentUsed ?? (disk.totalBytes ? (disk.usedBytes / disk.totalBytes) * 100 : 0));
  return card('Disk usage', [
    h('div', { style: { marginBottom: '10px', fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--faint)', overflowWrap: 'anywhere' } },
      safeText(disk.path || storage?.cache?.root, 'unknown mount')),
    h('div', { class: `adm-meter ${percent >= 95 ? 'bad' : percent >= 85 ? 'warn' : ''}`.trim(), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent) },
      h('i', { style: { width: `${Math.max(0, Math.min(100, percent))}%` } })),
    h('div', { class: 'adm-meter-foot' },
      h('span', {}, `${fmtBytesSafe(disk.usedBytes)} used · ${fmtPct(percent, 1)}`),
      h('span', {}, `${fmtBytesSafe(disk.freeBytes)} free`),
    ),
    h('dl', { class: 'adm-kv', style: { marginTop: '14px' } },
      h('dt', {}, 'capacity'), h('dd', {}, fmtBytesSafe(disk.totalBytes)),
      h('dt', {}, 'media'), h('dd', {}, `${fmtBytesSafe(storage?.mediaBytes)} across ${fmtNum(storage?.mediaItems)} items`),
      h('dt', {}, 'cache'), h('dd', {}, `${fmtBytesSafe(storage?.cache?.totalBytes)} · ${fmtNum(storage?.cache?.totalFiles)} files`),
      h('dt', {}, 'database'), h('dd', {}, `${fmtBytesSafe(storage?.db?.bytes ?? storage?.db?.totalBytes)} (WAL ${fmtBytesSafe(storage?.db?.walBytes)})`),
    ),
  ], { sub: 'statfs' });
}

function storageDonut(items) {
  const rows = (items || []).filter((row) => num(row.bytes) > 0).sort((a, b) => num(b.bytes) - num(a.bytes));
  const total = rows.reduce((sum, row) => sum + num(row.bytes), 0);
  if (!rows.length || total <= 0) {
    return emptyState('No storage data yet', 'Scan a library and the bytes will show up here. Physics is undefeated.', { emoji: '🗄' });
  }
  const circumference = 100;
  let offset = 0;
  const svgCircles = [];
  rows.forEach((row, index) => {
    const pct = (num(row.bytes) / total) * circumference;
    svgCircles.push(h('circle', {
      cx: 21, cy: 21, r: 15.9155,
      stroke: PALETTE[index % PALETTE.length],
      'stroke-dasharray': `${pct.toFixed(3)} ${(circumference - pct).toFixed(3)}`,
      'stroke-dashoffset': `${(-offset).toFixed(3)}`,
      'aria-hidden': 'true',
    }));
    offset += pct;
  });
  const svg = h('div', { class: 'adm-donut' },
    h('svg', { viewBox: '0 0 42 42', role: 'img', 'aria-label': `Storage by kind, total ${fmtBytesSafe(total)}` },
      h('circle', { cx: 21, cy: 21, r: 15.9155, stroke: 'var(--surface-2)' }),
      ...svgCircles,
      h('circle', { cx: 21, cy: 21, r: 11, fill: 'var(--surface)', stroke: 'none' }),
    ),
  );
  const legend = h('div', { class: 'adm-legend' },
    ...rows.map((row, index) => h('div', { class: 'adm-legend-row' },
      h('span', { class: 'adm-legend-swatch', style: { background: PALETTE[index % PALETTE.length] } }),
      h('span', { class: 'truncate', title: row.kind }, `${row.kind} · ${fmtNum(row.items)}`),
      h('span', { class: 'num' }, `${fmtBytesSafe(row.bytes)} · ${fmtPct((num(row.bytes) / total) * 100)}`),
    )),
  );
  return h('div', { class: 'adm-chart' }, svg, legend);
}

function activeStreams(streams) {
  const items = Array.isArray(streams?.items) ? streams.items : [];
  return card('Active streams', [
    items.length
      ? h('div', {},
        ...items.slice(0, 6).map((stream) => listRow(
          h('div', { class: 'row', style: { gap: '7px', minWidth: 0 } },
            h('strong', { class: 'truncate' }, safeText(stream.title, `media #${stream.mediaId}`)),
            badge(stream.mode, stream.mode === 'transcode' ? 'transcode' : stream.mode),
          ),
          h('div', { class: 'adm-list-main' },
            h('span', {}, `@${stream.username || 'ghost'} · ${fmtDuration(num(stream.position), { clock: true })} · ${fmtAgo(stream.lastSeenAt)}`),
          ),
        )),
        items.length > 6 ? h('div', { style: { marginTop: '8px' }, class: 'faint small' }, `+${items.length - 6} more stream${items.length - 6 === 1 ? '' : 's'}`) : null,
      )
      : emptyState('No active streams', 'Nobody is watching. Either it is quiet or the transcoder is coping.', { emoji: '📺' }),
  ], {
    sub: `${fmtNum(streams?.active ?? items.length)} active`,
    actions: [h('a', { class: 'mini-link', href: '#jobs' }, 'jobs →')],
  });
}

function serverCard(overview) {
  const server = overview.server || {};
  const memory = overview.memory || {};
  const database = overview.database || {};
  const heapPct = memory.heapTotalBytes ? (num(memory.heapUsedBytes) / num(memory.heapTotalBytes)) * 100 : 0;
  return card('Server vitals', [
    kv([
      ['name', `${safeText(server.name)} v${safeText(server.version)}`],
      ['env', safeText(server.env)],
      ['uptime', `${fmtUptime(server.uptimeSeconds)}`],
      ['node', safeText(server.node)],
      ['host', server.port ? `${safeText(server.host)}:${server.port}` : safeText(server.host)],
      ['platform', [server.platform, server.arch].filter(Boolean).join(' / ') || '—'],
      ['pid', server.pid ?? '—'],
      ['sse', `${fmtNum(server.sseClients)} clients`],
      ['db', `${safeText(database.journalMode)} · ${fmtNum(database.pageCount)} pages · ${fmtBytesSafe(database.totalBytes)}`],
    ]),
    h('div', { style: { marginTop: '12px' } },
      h('div', { class: 'adm-meter-foot', style: { marginBottom: '4px', marginTop: 0 } },
        h('span', {}, 'JS heap'), h('span', {}, `${fmtBytesSafe(memory.heapUsedBytes)} / ${fmtBytesSafe(memory.heapTotalBytes)}`)),
      h('div', { class: `adm-meter ${heapPct > 90 ? 'warn' : ''}`.trim() }, h('i', { style: { width: `${Math.min(100, heapPct)}%` } })),
    ),
  ], { sub: 'live process' });
}

function jobsCard(jobs) {
  const recent = Array.isArray(jobs?.recent) ? jobs.recent : [];
  const counts = jobs?.counts || {};
  return card('Recent jobs', [
    h('div', { class: 'row wrap', style: { gap: '6px', marginBottom: '10px' } },
      badge('running', `running ${fmtNum(counts.running)}`),
      badge('queued', `queued ${fmtNum(counts.queued)}`),
      badge('done', `done ${fmtNum(counts.done)}`),
      badge('error', `error ${fmtNum(counts.error)}`),
    ),
    recent.length
      ? h('div', {}, ...recent.slice(0, 6).map((job) => listRow(
        h('div', { class: 'row', style: { gap: '7px', minWidth: 0 } },
          h('strong', {}, safeText(job.type)),
          badge(job.status),
        ),
        h('div', { class: 'adm-list-main' }, h('span', {}, `${safeText(job.message)} · ${fmtAgo(job.createdAt)}`)),
      )))
      : h('p', { class: 'faint small' }, 'No jobs yet. The queue is suspiciously chill.'),
  ], { sub: `${fmtNum(counts.total)} total`, actions: [h('a', { class: 'mini-link', href: '#jobs' }, 'open jobs →')] });
}

function logsCard(logs) {
  const recent = Array.isArray(logs?.recent) ? logs.recent : [];
  return card('Recent logs', [
    recent.length
      ? h('div', {}, ...recent.slice(0, 7).map((entry) => listRow(
        h('div', { class: 'row', style: { gap: '7px', minWidth: 0 } },
          badge(entry.level, entry.level),
          h('strong', { class: 'truncate', title: entry.scope }, safeText(entry.scope)),
        ),
        h('div', { class: 'adm-list-main' }, h('span', { class: 'truncate', title: entry.message }, `${safeText(entry.message)} · ${fmtAgo(entry.createdAt)}`)),
      )))
      : h('p', { class: 'faint small' }, 'No log lines in the window. Quiet logs, clear conscience.'),
  ], {
    sub: logs?.byLevel ? `${fmtNum(logs.byLevel.error)} errors · ${fmtNum(logs.total)} total` : undefined,
    actions: [h('a', { class: 'mini-link', href: '#logs' }, 'all logs →')],
  });
}

function humanSpan(seconds) {
  const value = num(seconds);
  if (value <= 0) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  return fmtDuration(value);
}

function topMediaCard(topMedia) {
  const largest = topMedia?.largest || [];
  const played = topMedia?.mostPlayed || [];
  const largestList = largest.length
    ? h('div', {}, ...largest.slice(0, 5).map((entry) => listRow(
      h('div', { class: 'row', style: { gap: '8px', minWidth: 0 } },
        h('img', { class: 'adm-thumb', src: entry.item?.art?.poster || '/img/favicon.svg', alt: '', loading: 'lazy' }),
        h('div', { style: { minWidth: 0 } },
          h('strong', { class: 'truncate', title: entry.item?.title }, safeText(entry.item?.title)),
          h('span', {}, `${safeText(entry.item?.kind)} · ${fmtBytesSafe(entry.bytes)}`),
        ),
      ),
      h('a', { class: 'mini-link', href: `/item/${entry.item?.id}`, target: '_blank', rel: 'noopener' }, 'open'),
    )))
    : h('p', { class: 'faint small' }, 'No storage hogs yet.');
  const playedList = played.length
    ? h('div', {}, ...played.slice(0, 5).map((entry) => listRow(
      h('div', { style: { minWidth: 0 } },
        h('strong', { class: 'truncate', title: entry.item?.title }, safeText(entry.item?.title)),
        h('span', {}, `${fmtNum(entry.plays)} plays · ${humanSpan(entry.seconds)}`),
      ),
      h('a', { class: 'mini-link', href: `/item/${entry.item?.id}`, target: '_blank', rel: 'noopener' }, 'open'),
    )))
    : h('p', { class: 'faint small' }, 'No play counts yet. Everyone is lurking.');
  return card('Top media', [
    h('div', { class: 'adm-grid-2 even' },
      h('div', {}, h('div', { class: 'eyebrow', style: { marginBottom: '6px' } }, 'largest files'), largestList),
      h('div', {}, h('div', { class: 'eyebrow', style: { marginBottom: '6px' } }, 'most played'), playedList),
    ),
  ], { sub: 'bytes + attention' });
}

function watchCard(watch) {
  const genres = Array.isArray(watch?.topGenres) ? watch.topGenres : [];
  const maxSeconds = genres.reduce((max, row) => Math.max(max, num(row.seconds)), 0);
  return card('Watch stats', [
    h('div', { class: 'adm-stat-grid', style: { marginBottom: '12px' } },
      statCard('watch time', humanSpan(watch?.totalSeconds), `${fmtNum(watch?.totalPlays)} plays`, { accent: true }),
      statCard('finished', fmtNum(watch?.finishedCount), `${fmtNum(watch?.watchers)} watchers`),
      statCard('last 24h', humanSpan(watch?.last24hSeconds), 'recent attention'),
    ),
    genres.length
      ? h('div', {},
        h('div', { class: 'eyebrow', style: { marginBottom: '4px' } }, 'top genres'),
        ...genres.slice(0, 6).map((row) => h('div', { class: 'adm-bar-row' },
          h('span', { class: 'truncate', title: row.genre }, safeText(row.genre)),
          h('span', { class: 'adm-bar' }, h('i', { style: { width: `${maxSeconds ? Math.max(2, (num(row.seconds) / maxSeconds) * 100) : 0}%` } })),
          h('span', { class: 'num' }, humanSpan(row.seconds)),
        )))
      : h('p', { class: 'faint small' }, 'No genre data yet. Watch something questionable.'),
  ], { sub: 'aggregate, all users' });
}

function degradedNote(error) {
  return h('div', { class: 'adm-note warn' }, h('strong', {}, 'Partial data: '), `overview failed (${error?.message || error}). Showing what /api/stats can prove.`);
}

async function loadDashboard(ctx) {
  const [overviewResult, statsResult, activeResult] = await Promise.allSettled([
    adminGet('/api/admin/overview', { signal: ctx.signal }),
    adminGet('/api/stats', { signal: ctx.signal }),
    adminGet('/api/jobs/active', { signal: ctx.signal }),
  ]);
  if (overviewResult.status === 'rejected' && overviewResult.reason?.name === 'AbortError') throw overviewResult.reason;
  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
  if (overviewResult.status === 'rejected' && !stats) throw overviewResult.reason;
  const overview = overviewResult.status === 'fulfilled' ? overviewResult.value : null;
  return {
    overview: overview || {},
    stats: stats || {},
    activeJobs: activeResult.status === 'fulfilled' ? (activeResult.value?.items || []) : [],
    overviewError: overviewResult.status === 'rejected' ? overviewResult.reason : null,
  };
}

function buildDashboard(data, onRefresh) {
  const { overview, stats, activeJobs, overviewError } = data;
  const counts = overview.counts || {};
  const storage = overview.storage || {};
  const disk = overview.disk || storage.disk || {};
  const streams = overview.streams || {};
  const jobs = overview.jobs || { active: activeJobs };
  const logs = overview.logs || {};
  const server = overview.server || {};
  const watch = overview.watch || {};
  const mediaByKind = counts.mediaByKind || stats.counts || {};
  const totalItems = counts.media ?? stats.items ?? 0;
  const users = counts.users ?? stats.users ?? 0;
  const libraries = counts.libraries ?? stats.libraries ?? 0;
  const storageBytes = storage.mediaBytes ?? stats.bytes ?? 0;
  const openReports = counts.openReports ?? 0;
  const pendingRequests = counts.requests ?? 0;
  const activeStreamCount = streams.active ?? streams.items?.length ?? 0;
  const summary = overview.settingsSummary || {};
  const warnings = [];
  if (summary.maintenanceMode) warnings.push(h('div', { class: 'adm-note warn' }, h('strong', {}, 'Maintenance mode is ON. '), 'Users see the maintenance notice; streaming still works unless you say otherwise.'));
  if (!summary.tmdbConfigured) warnings.push(h('div', { class: 'adm-note' }, h('strong', {}, 'TMDB is not configured. '), 'Metadata matching stays local-first. Paste a key in Settings if you want enrichment.'));

  return h('div', { class: 'adm-section' },
    pageHead('Control room', `${safeText(server.name, 'AISlopMediaBox')} v${safeText(server.version, '?')} · ${safeText(server.env, 'unknown env')} · up ${fmtUptime(server.uptimeSeconds)} · generated ${fmtWhen(overview.generatedAt)}`, [
      btn('Refresh', onRefresh, { kind: 'primary', iconText: '↻' }),
    ]),
    overviewError ? degradedNote(overviewError) : null,
    ...warnings,
    h('div', { class: 'adm-stat-grid' },
      statCard('media items', fmtNum(totalItems), `${fmtNum(mediaByKind.movie)} movies · ${fmtNum(mediaByKind.show)} shows · ${fmtNum(mediaByKind.track)} tracks · ${fmtNum(mediaByKind.photo)} photos`),
      statCard('users', fmtNum(users), `${fmtNum(counts.admins)} admins · ${fmtNum(counts.sessions)} sessions`),
      statCard('libraries', fmtNum(libraries), `${fmtNum(counts.invitesActive)} active invites`),
      statCard('library size', fmtBytesSafe(storageBytes), `${fmtNum(storage.mediaItems)} items · DB ${fmtBytesSafe(storage.db?.bytes)}`),
      statCard('active streams', fmtNum(activeStreamCount), `${fmtNum(server.sseClients)} SSE clients`, { accent: activeStreamCount > 0 }),
      statCard('open reports', fmtNum(openReports), openReports ? 'moderation needs a look' : 'nothing to moderate'),
      statCard('requests', fmtNum(pendingRequests), 'all statuses'),
      statCard('watch time', humanSpan(watch.totalSeconds), `${fmtNum(watch.totalPlays)} plays`, { small: true }),
    ),
    h('div', { class: 'adm-grid-2 even' },
      diskCard(disk, storage),
      card('Storage by kind', [storageDonut(storage.byKind)], { sub: `${fmtBytesSafe(storage.mediaBytes)} media` }),
    ),
    h('div', { class: 'adm-grid-2' },
      activeStreams(streams),
      serverCard(overview),
    ),
    h('div', { class: 'adm-grid-2 even' },
      jobsCard(jobs),
      logsCard(logs),
    ),
    h('div', { class: 'adm-grid-2' },
      topMediaCard(overview.topMedia),
      watchCard(watch),
    ),
  );
}

export default {
  async render(host, ctx) {
    host.replaceChildren(h('div', { class: 'adm-section' },
      h('div', { class: 'adm-skel-grid' }, ...Array.from({ length: 4 }, () => h('div', { class: 'adm-skeleton', style: { height: '96px' } }))),
      skeletonGrid(3),
    ));
    const draw = async () => {
      try {
        const data = await loadDashboard(ctx);
        host.replaceChildren(buildDashboard(data, draw));
      } catch (error) {
        if (error?.name === 'AbortError') return;
        host.replaceChildren(h('div', { class: 'adm-section' },
          errorState(error, draw, { title: 'Overview unavailable' }),
          h('p', { class: 'faint small' }, 'If the backend is still booting, retry in a moment. The slop pipeline needs a second.'),
        ));
      }
    };
    await draw();
  },
};
