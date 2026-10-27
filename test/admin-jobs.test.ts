import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminClient,
  assert,
  Client,
  createLibrary,
  makeVideo,
  newUserClient,
  pollJob,
  scanLibrary,
  startServer,
  writeNfo,
} from './helpers.ts';
import type { Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MediaItem {
  id: number;
  kind: string;
  title: string;
  playable: boolean;
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface Job {
  id: string;
  type: string;
  status: string;
  progress: number;
  message: string;
  payload: Record<string, unknown>;
  result: unknown;
  error?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

interface JobPage extends PagedItems<Job> {
  counts: Record<string, number>;
}

interface StorageBody {
  mediaBytes: number;
  mediaItems: number;
  byKind: { kind: string; items: number; bytes: number }[];
  libraries: { id: number; name: string; items: number; bytes: number; exists: boolean }[];
  cache: { root: string; totalBytes: number; totalFiles: number; images: { bytes: number; files: number }; transcode: { bytes: number; files: number } };
  db: { bytes: number; path: string; walBytes: number };
  art: { count: number; bytes: number };
  disk: { freeBytes: number };
}

interface PrivacyBody {
  zeroOutbound: boolean;
  telemetry: boolean;
  analytics: boolean;
  externalFonts: number;
  cdnAssets: number;
  thirdPartyScripts: number;
  outboundEndpoints: { host: string; enabled: boolean }[];
  tmdb: { configured: boolean; source: string; autoMatch: boolean; host: string };
  cookie: { name: string; httpOnly: boolean; sameSite: string; secure: boolean; sessionDays: number };
  passwordHashing: string;
  logs: { local: boolean; store: string };
  dataDir: string;
  exports: { user: string; instance: string };
}

interface ActivityBody {
  items: {
    id: string;
    mode: string;
    started_at: string;
    last_seen_at: string;
    position: number;
    username: string;
    display_name: string;
    title: string;
    kind: string;
  }[];
  sseClients: number;
  startedAt: string;
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let user: Client;
let moviesLibrary: Library;
let bulkLibrary: Library;
let movieId: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'jobs_manager', 'manager');
  user = await newUserClient(server, admin, 'jobs_user', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  const dir = path.join(moviesRoot, 'Jobs Movie (2021)');
  makeVideo(path.join(dir, 'Jobs Movie (2021).mp4'));
  writeNfo(path.join(dir, 'movie.nfo'), 'movie', { title: 'Jobs Movie', year: 2021, plot: 'Jobs plot.', rating: 8, genres: ['Action'] });
  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });

  const bulkRoot = path.join(server.mediaDir, 'bulk');
  for (let index = 0; index < 8; index += 1) {
    makeVideo(path.join(bulkRoot, `Bulk ${index + 1} (2022).mp4`));
  }
  bulkLibrary = await createLibrary(admin, { name: 'Bulk', kind: 'movies', path: bulkRoot });

  await scanLibrary(admin, moviesLibrary.id);
  const items = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  movieId = items.json!.items[0].id;
});

after(async () => {
  await server.stop();
});

test('job listing is manager-only, typed, paginated, and ownership-scoped', async () => {
  assert.equal((await user.get('/api/jobs')).status, 403);
  assert.equal((await new Client(server.baseUrl, 'anon-jobs').get('/api/jobs')).status, 401);
  const list = await manager.get<JobPage>('/api/jobs');
  assert.equal(list.status, 200);
  assert.ok((list.json?.total ?? 0) >= 1);
  assert.equal(list.json?.page, 1);
  assert.equal(list.json?.pageSize, 50);
  for (const key of ['queued', 'running', 'done', 'error', 'cancelled']) assert.ok(typeof list.json!.counts[key] === 'number');
  const scanJob = list.json!.items.find((job) => job.type === 'scan' && job.status === 'done')!;
  assert.equal(scanJob.payload.libraryId, moviesLibrary.id);
  assert.equal(scanJob.progress, 1);
  assert.equal(scanJob.message, 'Done. Slop secured.');
  assert.match(scanJob.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(scanJob.finishedAt);

  const done = await manager.get<JobPage>('/api/jobs?status=done&type=scan');
  assert.ok(done.json!.items.every((job) => job.status === 'done' && job.type === 'scan'));
  assert.equal((await manager.get('/api/jobs?status=bogus')).status, 400);
  assert.equal((await manager.get('/api/jobs?type=bogus')).status, 400);
  const paged = await manager.get<JobPage>('/api/jobs?pageSize=1&page=1');
  assert.equal(paged.json?.items.length, 1);
  assert.equal(paged.json?.pageSize, 1);

  const active = await manager.get<{ items: Job[] }>('/api/jobs/active');
  assert.equal(active.status, 200);
  assert.deepEqual(active.json?.items, []);
  const userActive = await user.get<{ items: Job[] }>('/api/jobs/active');
  assert.equal(userActive.status, 200);
  assert.deepEqual(userActive.json?.items, []);

  const detail = await manager.get<Job>(`/api/jobs/${scanJob.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json?.id, scanJob.id);
  assert.equal((await user.get(`/api/jobs/${scanJob.id}`)).status, 403);
  assert.equal((await admin.get('/api/jobs/not%20a%20job')).status, 400);
  assert.equal((await admin.get('/api/jobs/does-not-exist')).status, 404);
});

test('scan jobs can be cancelled while active and finished jobs cannot', async () => {
  const started = await admin.post<{ jobId: string }>(`/api/libraries/${bulkLibrary.id}/scan`);
  assert.equal(started.status, 202);
  const active = await admin.get<{ items: Job[] }>('/api/jobs/active');
  assert.ok(active.json!.items.some((job) => job.id === started.json!.jobId));
  const activeJob = active.json!.items.find((job) => job.id === started.json!.jobId)!;
  assert.equal(activeJob.type, 'scan');
  assert.equal(activeJob.payload.libraryId, bulkLibrary.id);

  const cancelled = await admin.post<{ ok: boolean; job: Job }>(`/api/jobs/${started.json!.jobId}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json?.ok, true);
  assert.equal(cancelled.json?.job.status, 'cancelled');
  assert.equal(cancelled.json?.job.message, 'Cancelled. The slop stopped.');
  assert.ok(cancelled.json?.job.finishedAt);
  const settled = await pollJob(admin, started.json!.jobId);
  assert.equal(settled.status, 'cancelled');

  const finished = await manager.get<JobPage>('/api/jobs?status=done&type=scan');
  const doneJob = finished.json!.items[0];
  const recancel = await admin.post(`/api/jobs/${doneJob.id}/cancel`, {});
  assert.equal(recancel.status, 409);
  assert.match((recancel.json as ErrorBody).error.message, /already done/);
  assert.equal((await admin.post('/api/jobs/does-not-exist/cancel', {})).status, 404);
  assert.equal((await user.post(`/api/jobs/${doneJob.id}/cancel`, {})).status, 403);
});

test('finished job history can be swept only by admins with bounded days', async () => {
  assert.equal((await manager.del('/api/jobs/history?olderThanDays=0')).status, 403);
  assert.equal((await admin.del('/api/jobs/history?olderThanDays=-1')).status, 400);
  assert.equal((await admin.del('/api/jobs/history?olderThanDays=4000')).status, 400);
  const before = await admin.get<JobPage>('/api/jobs');
  const swept = await admin.del<{ ok: boolean; deleted: number; olderThanDays: number }>('/api/jobs/history?olderThanDays=0');
  assert.equal(swept.status, 200);
  assert.equal(swept.json?.ok, true);
  assert.ok((swept.json?.deleted ?? 0) >= 1);
  assert.equal(swept.json?.olderThanDays, 0);
  const after = await admin.get<JobPage>('/api/jobs');
  assert.ok((after.json?.total ?? 0) < (before.json?.total ?? 0));
});

test('maintenance optimize, vacuum, clear-cache, regenerate-art, and reindex work', async () => {
  assert.equal((await user.post('/api/admin/maintenance', { action: 'optimize' })).status, 403);
  const optimize = await admin.post<{ ok: boolean; action: string; bytesBefore: number; bytesAfter: number; bytesFreed: number; durationMs: number }>(
    '/api/admin/maintenance',
    { action: 'optimize' },
  );
  assert.equal(optimize.status, 200);
  assert.equal(optimize.json?.action, 'optimize');
  assert.ok((optimize.json?.bytesBefore ?? 0) > 0);
  assert.ok((optimize.json?.bytesFreed ?? -1) >= 0);
  assert.ok((optimize.json?.durationMs ?? -1) >= 0);

  const vacuum = await admin.post<{ ok: boolean; action: string; bytesBefore: number; bytesAfter: number }>('/api/admin/maintenance', {
    action: 'vacuum',
  });
  assert.equal(vacuum.status, 200);
  assert.equal(vacuum.json?.action, 'vacuum');
  assert.ok((vacuum.json?.bytesAfter ?? 0) > 0);

  const cleared = await admin.post<{ ok: boolean; targets: string[]; freedBytes: number; removedFiles: number; artRowsCleared: number }>(
    '/api/admin/maintenance',
    { action: 'clear-cache' },
  );
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json?.targets, ['transcode', 'subtitles', 'temp']);
  assert.ok((cleared.json?.freedBytes ?? -1) >= 0);
  assert.ok((cleared.json?.removedFiles ?? -1) >= 0);
  assert.equal(cleared.json?.artRowsCleared, 0);

  const images = await admin.post<{ artRowsCleared: number; targets: string[] }>('/api/admin/maintenance', {
    action: 'clear-cache',
    targets: ['images'],
  });
  assert.equal(images.status, 200);
  assert.ok((images.json?.artRowsCleared ?? 0) >= 1);
  assert.deepEqual(images.json?.targets, ['images']);
  const placeholder = await admin.get(`/api/art/${movieId}/poster`);
  assert.equal(placeholder.status, 200);
  assert.match(placeholder.contentType, /image\/svg\+xml/);

  const regenerate = await admin.post<{ ok: boolean; queued: boolean; jobId: string; mode: string }>('/api/admin/maintenance', {
    action: 'regenerate-art',
  });
  assert.equal(regenerate.status, 202);
  assert.equal(regenerate.json?.queued, true);
  assert.equal(regenerate.json?.mode, 'job');
  const artJob = await pollJob(admin, regenerate.json!.jobId);
  assert.equal(artJob.status, 'done');
  const restored = await admin.get(`/api/art/${movieId}/poster`);
  assert.equal(restored.status, 200);
  assert.equal(restored.contentType, 'image/jpeg');
  assert.ok(restored.body.length > 100);

  const reindex = await admin.post<{ ok: boolean; queued: boolean; mode: string; jobId: string }>('/api/admin/maintenance', {
    action: 'reindex',
  });
  assert.equal(reindex.status, 202);
  assert.equal(reindex.json?.queued, true);
  assert.equal(reindex.json?.mode, 'probe');
  const probeJob = await pollJob(admin, reindex.json!.jobId);
  assert.equal(probeJob.status, 'done');
  const probeResult = probeJob.result as { processed: number; failed: number; skipped: number; total: number };
  assert.ok(probeResult.processed >= 1);
  assert.equal(typeof probeResult.failed, 'number');
  assert.ok(probeResult.total >= probeResult.processed);

  const invalid: Record<string, unknown>[] = [
    {},
    { action: 'nonsense' },
    { action: 'clear-cache', targets: [] },
    { action: 'clear-cache', targets: ['secrets'] },
    { action: 'regenerate-art', mediaId: 'x' },
    { action: 'regenerate-art', mediaId: 0 },
  ];
  for (const body of invalid) {
    const response = await admin.post('/api/admin/maintenance', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
  }
});

test('instance export is metadata-only and redacts secrets', async () => {
  assert.equal((await user.get('/api/admin/export')).status, 403);
  const response = await admin.get<{
    exportedAt: string;
    version: string;
    schemaVersion: string;
    settings: { serverName: string; tmdbApiKey: string };
    settingsMeta: { tmdbConfigured: boolean; tmdbKeyRedacted: boolean };
    users: { username: string; hasPin: boolean }[];
    libraries: { name: string; path: string }[];
    media: { id: number; title: string }[];
    mediaArt: { media_id: number; kind: string }[];
    genres: { media_id: number; genre: string }[];
    collections: unknown[];
    playlists: unknown[];
    counts: Record<string, number>;
  }>('/api/admin/export');
  assert.equal(response.status, 200);
  assert.match(response.contentType, /application\/json/);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="aislop-metadata-.*\.json"/);
  const payload = response.json!;
  assert.match(payload.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.schemaVersion, '1');
  assert.equal(payload.settings.serverName, 'AISlopMediaBox');
  assert.equal(payload.settings.tmdbApiKey, '');
  assert.deepEqual(payload.settingsMeta, { tmdbConfigured: false, tmdbKeyRedacted: true });
  assert.ok(payload.users.length >= 3);
  assert.ok(payload.users.some((entry) => entry.username === 'admin' && entry.hasPin === false));
  assert.equal(payload.libraries.length, 2);
  assert.ok(payload.libraries.some((entry) => entry.path === path.join(server.mediaDir, 'movies')));
  assert.ok(payload.libraries.some((entry) => entry.name === 'Bulk'));
  assert.equal(payload.media.length, 1);
  assert.equal(payload.media[0].id, movieId);
  assert.ok(payload.mediaArt.length >= 1);
  assert.ok(payload.genres.some((entry) => entry.media_id === movieId && entry.genre === 'Action'));
  assert.deepEqual(payload.collections, []);
  assert.deepEqual(payload.playlists, []);
  assert.deepEqual(payload.counts, { users: payload.users.length, libraries: 2, media: 1, art: payload.mediaArt.length, collections: 0, playlists: 0 });
  assert.ok(!response.text.includes('password_hash'));
  assert.ok(!response.text.includes('scrypt$'));
});

test('instance import validates untrusted metadata and skips conflicts', async () => {
  const importedRoot = path.join(server.mediaDir, 'imported-media');
  fs.mkdirSync(importedRoot, { recursive: true });
  const body = {
    settings: { serverName: 'Imported Box', tagline: 'Imported tagline', tmdbApiKey: '***redacted***' },
    libraries: [
      { name: 'Imported Library', kind: 'movies', path: importedRoot, scanSchedule: 'weekly', settings: { source: 'import', limit: 5 } },
      { name: 'Duplicate Import', kind: 'movies', path: importedRoot },
      { name: 'Bad Kind', kind: 'podcasts', path: importedRoot },
      { name: 'Missing Path', kind: 'movies', path: path.join(server.mediaDir, 'missing-import') },
      { name: 'Relative Path', kind: 'movies', path: 'relative/path' },
    ],
    collections: [
      { name: 'Imported Collection', kind: 'manual', description: 'imported', items: [{ mediaId: movieId }] },
      { name: 'Bad Collection', kind: 'vibes' },
    ],
    playlists: [
      { name: 'Imported Playlist', kind: 'mixed', isPublic: false, items: [{ mediaId: movieId }] },
      { name: '', kind: 'mixed' },
    ],
  };
  const imported = await admin.post<{
    ok: boolean;
    imported: { settings: number; libraries: number; collections: number; playlists: number };
    skipped: { kind: string; reason: string }[];
  }>('/api/admin/import', body);
  assert.equal(imported.status, 200);
  assert.equal(imported.json?.ok, true);
  assert.deepEqual(imported.json?.imported, { settings: 2, libraries: 1, collections: 1, playlists: 1 });
  const skippedKinds = imported.json!.skipped.map((entry) => entry.kind);
  for (const kind of ['library', 'collection', 'collection.items', 'playlist', 'playlist.items']) {
    assert.ok(skippedKinds.includes(kind), `expected skipped ${kind}: ${JSON.stringify(imported.json!.skipped)}`);
  }
  assert.ok(imported.json!.skipped.some((entry) => entry.reason.includes('already exists')));
  assert.ok(imported.json!.skipped.some((entry) => entry.reason.includes('Path does not exist')));

  const settings = await admin.get<{ serverName: string; tagline: string; tmdbApiKey: string }>('/api/admin/settings');
  assert.equal(settings.json?.serverName, 'Imported Box');
  assert.equal(settings.json?.tagline, 'Imported tagline');
  assert.equal(settings.json?.tmdbApiKey, '');
  const libraries = await admin.get<PagedItems<Library>>('/api/libraries');
  const importedLibrary = libraries.json!.items.find((library) => library.name === 'Imported Library')!;
  assert.equal(importedLibrary.path, importedRoot);
  assert.equal(importedLibrary.scan_schedule, 'weekly');
  assert.deepEqual(importedLibrary.settings, { source: 'import', limit: 5 });
  const collections = await admin.get<PagedItems<{ name: string; kind: string; createdBy: string | null }>>('/api/collections');
  assert.ok(collections.json!.items.some((collection) => collection.name === 'Imported Collection' && collection.kind === 'manual'));
  const playlists = await admin.get<PagedItems<{ name: string; isPublic: boolean; itemCount: number }>>('/api/playlists');
  const importedPlaylist = playlists.json!.items.find((playlist) => playlist.name === 'Imported Playlist')!;
  assert.equal(importedPlaylist.isPublic, false);
  assert.equal(importedPlaylist.itemCount, 0);

  const second = await admin.post<{ imported: { settings: number; libraries: number; collections: number; playlists: number }; skipped: { kind: string }[] }>(
    '/api/admin/import',
    body,
  );
  assert.equal(second.json?.imported.libraries, 0);
  assert.equal(second.json?.imported.collections, 0);
  assert.equal(second.json?.imported.playlists, 0);
  assert.equal(second.json?.imported.settings, 2);
  assert.ok(second.json!.skipped.filter((entry) => entry.kind === 'library').length >= 4);

  const empty = await admin.post<{ imported: { settings: number }; skipped: unknown[] }>('/api/admin/import', {});
  assert.deepEqual(empty.json?.imported, { settings: 0, libraries: 0, collections: 0, playlists: 0 });
  assert.deepEqual(empty.json?.skipped, []);
  assert.equal((await admin.post('/api/admin/import', [])).status, 400);
  const badSettings = await admin.post<{ imported: { settings: number }; skipped: { kind: string; reason: string }[] }>('/api/admin/import', {
    settings: { telemetry: true },
  });
  assert.equal(badSettings.status, 200);
  assert.equal(badSettings.json?.imported.settings, 0);
  assert.equal(badSettings.json?.skipped[0].kind, 'settings');
  assert.match(badSettings.json?.skipped[0].reason ?? '', /Telemetry must stay false/);
});

test('admin request review aliases expose all requests with status filters', async () => {
  const created = await user.post<{ id: number; title: string; status: string }>('/api/requests', {
    title: 'Import Review Slop',
    kind: 'movie',
    year: 2024,
  });
  assert.equal(created.status, 201);

  const pending = await admin.get<PagedItems<{ id: number; title: string; status: string; requester: { username: string } | null }> & { byStatus: Record<string, number> }>(
    '/api/admin/requests?status=pending',
  );
  assert.equal(pending.status, 200);
  assert.ok(pending.json!.items.some((entry) => entry.title === 'Import Review Slop' && entry.requester?.username === 'jobs_user'));
  assert.equal(pending.json?.byStatus.pending, 1);
  const searched = await admin.get<PagedItems<{ title: string }>>('/api/admin/requests?q=Import%20Review');
  assert.deepEqual(searched.json!.items.map((entry) => entry.title), ['Import Review Slop']);
  assert.equal((await admin.get('/api/admin/requests?status=closed')).status, 400);
  assert.equal((await admin.get('/api/admin/requests?kind=podcast')).status, 400);
  assert.equal((await user.get('/api/admin/requests')).status, 403);

  const reviewed = await admin.patch<{ ok: boolean; request: { status: string; reviewNote: string; reviewer: { username: string } | null } }>(
    `/api/admin/requests/${created.json!.id}`,
    { status: 'approved', reviewNote: 'Approved by admin alias.' },
  );
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json?.request.status, 'approved');
  assert.equal(reviewed.json?.request.reviewNote, 'Approved by admin alias.');
  assert.equal(reviewed.json?.request.reviewer?.username, 'admin');
  const own = await user.get<PagedItems<{ status: string }>>('/api/requests');
  assert.equal(own.json!.items[0].status, 'approved');

  assert.equal((await admin.patch(`/api/admin/requests/${created.json!.id}`, {})).status, 400);
  assert.equal((await admin.patch(`/api/admin/requests/${created.json!.id}`, { badField: true })).status, 400);
  assert.equal((await admin.patch(`/api/admin/requests/${created.json!.id}`, { status: 'closed' })).status, 400);
  assert.equal((await admin.patch('/api/admin/requests/99999', { status: 'approved' })).status, 404);
});

test('storage and privacy audits report concrete local-only facts', async () => {
  assert.equal((await user.get('/api/admin/storage')).status, 403);
  const storage = await admin.get<StorageBody>('/api/admin/storage');
  assert.equal(storage.status, 200);
  assert.ok((storage.json?.mediaItems ?? 0) >= 1);
  assert.ok((storage.json?.mediaBytes ?? 0) > 0);
  assert.ok(storage.json!.byKind.some((entry) => entry.kind === 'movie' && entry.items >= 1));
  assert.ok(storage.json!.libraries.some((library) => library.id === moviesLibrary.id && library.items >= 1 && library.exists));
  assert.equal(storage.json?.cache.root, path.join(server.dataDir, 'cache'));
  assert.ok((storage.json?.db.bytes ?? 0) > 0);
  assert.equal(storage.json?.db.path, path.join(server.dataDir, 'aislop.db'));
  assert.ok((storage.json?.art.count ?? 0) >= 1);
  assert.ok((storage.json?.disk.freeBytes ?? 0) > 0);

  const privacy = await admin.get<PrivacyBody>('/api/admin/privacy');
  assert.equal(privacy.status, 200);
  assert.equal(privacy.json?.zeroOutbound, true);
  assert.equal(privacy.json?.telemetry, false);
  assert.equal(privacy.json?.analytics, false);
  assert.equal(privacy.json?.externalFonts, 0);
  assert.equal(privacy.json?.cdnAssets, 0);
  assert.equal(privacy.json?.thirdPartyScripts, 0);
  assert.deepEqual(privacy.json?.outboundEndpoints, []);
  assert.equal(privacy.json?.tmdb.configured, false);
  assert.equal(privacy.json?.tmdb.source, 'none');
  assert.equal(privacy.json?.tmdb.autoMatch, true);
  assert.equal(privacy.json?.cookie.name, 'slop_session');
  assert.equal(privacy.json?.cookie.httpOnly, true);
  assert.equal(privacy.json?.cookie.sameSite, 'Strict');
  assert.equal(privacy.json?.cookie.secure, false);
  assert.equal(privacy.json?.cookie.sessionDays, 30);
  assert.match(privacy.json?.passwordHashing ?? '', /^scrypt \(N=16384/);
  assert.deepEqual(privacy.json?.logs, { local: true, store: 'sqlite' });
  assert.equal(privacy.json?.dataDir, server.dataDir);
  assert.deepEqual(privacy.json?.exports, { user: '/api/users/me/export', instance: '/api/admin/export' });
  assert.equal((await user.get('/api/admin/privacy')).status, 403);
});

test('activity surfaces live streams to admins only and ends cleanly', async () => {
  assert.equal((await user.get('/api/activity')).status, 403);
  assert.equal((await new Client(server.baseUrl, 'anon-activity').get('/api/activity')).status, 401);

  const heartbeat = await user.post<{ sessionId: string }>(`/api/stream/${movieId}/progress`, {
    positionSeconds: 12,
    durationSeconds: 120,
    mode: 'direct',
  });
  assert.equal(heartbeat.status, 200);
  const activity = await admin.get<ActivityBody>('/api/activity');
  assert.equal(activity.status, 200);
  assert.equal(typeof activity.json?.sseClients, 'number');
  assert.match(activity.json?.startedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  const stream = activity.json!.items.find((item) => item.id === heartbeat.json!.sessionId)!;
  assert.equal(stream.mode, 'direct');
  assert.equal(stream.position, 12);
  assert.equal(stream.username, 'jobs_user');
  assert.equal(stream.display_name, 'jobs_user display');
  assert.equal(stream.title, 'Jobs Movie');
  assert.equal(stream.kind, 'movie');
  assert.match(stream.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(stream.last_seen_at, /^\d{4}-\d{2}-\d{2}T/);

  const limited = await admin.get<ActivityBody>('/api/activity?limit=1');
  assert.equal(limited.json?.items.length, 1);
  const capped = await admin.get<ActivityBody>('/api/activity?limit=999');
  assert.ok(capped.json!.items.length <= 100);

  await user.post(`/api/stream/${movieId}/progress`, { sessionId: heartbeat.json!.sessionId, ended: true });
  const after = await admin.get<ActivityBody>('/api/activity');
  assert.ok(!after.json!.items.some((item) => item.id === heartbeat.json!.sessionId));
});

