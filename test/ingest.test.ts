import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminClient,
  assert,
  createLibrary,
  makeAudioTrack,
  makeImage,
  makeSrt,
  makeVideo,
  newUserClient,
  pollJob,
  startServer,
  writeFile,
  writeNfo,
} from './helpers.ts';
import type { Client, Job, Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: { jobId?: string } };
}

interface SourceCounts {
  pending: number;
  review: number;
  organized: number;
  error: number;
  ignored: number;
}

interface IngestSource {
  id: number;
  name: string;
  kind: 'movies' | 'shows' | 'music' | 'photos';
  path: string;
  libraryId: number | null;
  libraryName: string | null;
  destinationPath: string;
  action: string;
  autoMatch: boolean;
  minConfidence: number;
  holdUnmatched: boolean;
  recursive: boolean;
  settleSeconds: number;
  enabled: boolean;
  counts: SourceCounts;
  lastScanAt: string | null;
}

interface IngestCandidate {
  provider: string;
  providerId: string;
  kind: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  score: number;
}

interface MediaCore {
  id: number;
  kind: string;
  title: string;
  year: number | null;
  genres: string[];
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  trackNumber?: number | null;
  sizeBytes?: number | null;
  container?: string | null;
}

interface IngestItem {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceKind: string;
  path: string;
  destPath: string | null;
  name: string;
  status: 'pending' | 'review' | 'organized' | 'error' | 'ignored';
  sizeBytes: number | null;
  parsed: { title: string | null; year: number | null; season: number | null; episode: number | null };
  title: string | null;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  provider: string | null;
  providerId: string | null;
  confidence: number | null;
  candidates: IngestCandidate[];
  mediaId: number | null;
  libraryId: number | null;
  error: string | null;
  notes: string | null;
  media?: MediaCore | null;
}

interface ItemsPage {
  items: IngestItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
}

interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  requiresKey: boolean;
  keyless: boolean;
  kinds: string[];
  hosts: string[];
  note: string;
}

interface PrivacyBody {
  zeroOutbound: boolean;
  outboundEndpoints: { host: string; providers: string[]; modes: string[] }[];
  providers: (ProviderStatus & { keySource: string; toggle: boolean })[];
}

interface RunCounts {
  sources: number;
  discovered: number;
  processed: number;
  organized: number;
  review: number;
  errors: number;
  skipped: number;
  mapped: number;
  scannedLibraries: number[];
  deferredLibraries: number[];
}

interface MediaDetail {
  item: MediaCore;
  show?: MediaCore;
  season?: MediaCore;
  album?: MediaCore;
  artist?: MediaCore;
}

interface SearchBody {
  groups: { movies?: MediaCore[]; shows?: MediaCore[]; episodes?: MediaCore[] };
  total: number;
}

interface StreamInfo {
  directPlay: boolean;
  mode: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  duration: number;
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let viewer: Client;

let discoverySourceId: number;
let discoveryItemId: number;
let discoveryDest: string;
let discoveryMediaId: number;
let providerReviewItemId: number;

function makeLibraryDir(name: string): string {
  const dir = path.join(server.mediaDir, 'libraries', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function makeLibrary(name: string, kind: 'movies' | 'shows' | 'music' | 'photos'): Promise<Library> {
  return createLibrary(admin, { name: `Ingest ${name}`, kind, path: makeLibraryDir(name), scanSchedule: 'manual' });
}

async function createSource(client: Client, input: Record<string, unknown>): Promise<IngestSource> {
  const response = await client.post<{ ok: boolean; item: IngestSource }>('/api/ingest/sources', input);
  assert.equal(response.status, 201, `source create failed: ${response.text}`);
  assert.ok(response.json?.item, 'source create returned no item');
  return response.json.item;
}

async function scanSource(sourceId: number): Promise<RunCounts> {
  const trigger = await admin.post<{ ok: boolean; jobId: string }>(`/api/ingest/sources/${sourceId}/scan`);
  assert.equal(trigger.status, 200, `source scan trigger failed: ${trigger.text}`);
  assert.ok(trigger.json?.jobId, 'source scan returned no jobId');
  const job: Job = await pollJob(admin, trigger.json.jobId);
  assert.equal(job.status, 'done', `source scan job failed: ${job.error || job.message}`);
  return job.result as RunCounts;
}

async function listItems(sourceId?: number, status?: string): Promise<ItemsPage> {
  const params = new URLSearchParams({ pageSize: '200' });
  if (sourceId !== undefined) params.set('sourceId', String(sourceId));
  if (status !== undefined) params.set('status', status);
  const response = await admin.get<ItemsPage>(`/api/ingest/items?${params.toString()}`);
  assert.equal(response.status, 200, `item listing failed: ${response.text}`);
  assert.ok(response.json, 'item listing returned no body');
  return response.json;
}

async function getItem(itemId: number): Promise<IngestItem> {
  const response = await admin.get<{ item: IngestItem }>(`/api/ingest/items/${itemId}`);
  assert.equal(response.status, 200, `item fetch failed: ${response.text}`);
  assert.ok(response.json?.item, 'item fetch returned no item');
  return response.json.item;
}

function expectError(response: { status: number; json: unknown; text: string }, status: number, code?: string): void {
  assert.equal(response.status, status, response.text);
  const body = response.json as ErrorBody | null;
  assert.ok(body?.error, `expected an error body, got ${response.text}`);
  if (code) assert.equal(body.error.code, code);
}

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'ingest_manager', 'manager');
  viewer = await newUserClient(server, admin, 'ingest_viewer', 'user');
  // The timer watcher must never compete with the explicit jobs this suite drives.
  const settings = await admin.patch('/api/admin/settings', {
    ingestWatch: false,
    autoMatch: true,
    tmdbApiKey: '',
    tvdbApiKey: '',
    omdbApiKey: '',
    tvmazeEnabled: false,
    imdbEnabled: false,
  });
  assert.equal(settings.status, 200, `could not pin ingest settings: ${settings.text}`);
});

after(async () => {
  if (server) {
    await admin.patch('/api/admin/settings', { imdbEnabled: false, tvmazeEnabled: false }).catch(() => undefined);
    await server.stop();
  }
});

test('default sources bootstrap with four kinds; source CRUD validates paths, permissions, and deletes safely', async () => {
  const sources = await admin.get<{ items: IngestSource[] }>('/api/ingest/sources');
  assert.equal(sources.status, 200);
  const defaults = sources.json!.items;
  assert.equal(defaults.length, 4, 'exactly the four bootstrap drop folders');
  const expected = [
    { kind: 'movies', name: 'Drop Movies', folder: 'movies' },
    { kind: 'shows', name: 'Drop TV', folder: 'tv' },
    { kind: 'music', name: 'Drop Music', folder: 'music' },
    { kind: 'photos', name: 'Drop Photos', folder: 'photos' },
  ] as const;
  for (const [index, definition] of expected.entries()) {
    const source = defaults[index];
    assert.equal(source.kind, definition.kind);
    assert.equal(source.name, definition.name);
    assert.equal(source.path, path.join(server.dataDir, 'ingest', definition.folder));
    assert.ok(fs.statSync(source.path).isDirectory(), `${source.path} must exist`);
    assert.equal(source.libraryId, null, 'default sources start unbound');
    assert.equal(source.destinationPath, path.join(server.mediaDir, `ingested-${definition.kind}`));
    assert.equal(source.action, 'move');
    assert.equal(source.autoMatch, true);
    assert.equal(source.minConfidence, 0.5);
    assert.equal(source.holdUnmatched, true);
    assert.equal(source.recursive, true);
    assert.equal(source.settleSeconds, 15);
    assert.equal(source.enabled, true);
    assert.deepEqual(source.counts, { pending: 0, review: 0, organized: 0, error: 0, ignored: 0 });
  }

  // Absolute existing directory, etc.
  const relative = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Relative', kind: 'movies', path: 'drops/relative', settleSeconds: 0,
  });
  expectError(relative, 400, 'bad_request');
  assert.match(relative.json!.error.message, /absolute/i);

  const missing = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Missing', kind: 'movies', path: path.join(server.dataDir, 'does-not-exist-drop'), settleSeconds: 0,
  });
  expectError(missing, 400, 'bad_request');
  assert.match(missing.json!.error.message, /does not exist/i);

  const cacheDir = path.join(server.dataDir, 'cache', 'drop-source');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Cache', kind: 'movies', path: cacheDir, settleSeconds: 0,
  });
  expectError(cache, 400, 'bad_request');
  assert.match(cache.json!.error.message, /cache directory/i);

  const dataRoot = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Data root', kind: 'music', path: server.dataDir, settleSeconds: 0,
  });
  expectError(dataRoot, 400, 'bad_request');
  assert.match(dataRoot.json!.error.message, /data root/i);

  // Destination loops: a source inside its library and a library inside its source are both rejected.
  const loopLibrary = await makeLibrary('Loop Destination', 'movies');
  const insideDestination = path.join(loopLibrary.path, 'drop-inside');
  fs.mkdirSync(insideDestination, { recursive: true });
  const sourceInsideLibrary = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Inside destination', kind: 'movies', path: insideDestination, libraryId: loopLibrary.id, settleSeconds: 0,
  });
  expectError(sourceInsideLibrary, 400, 'bad_request');
  assert.match(sourceInsideLibrary.json!.error.message, /must not contain each other/i);

  const container = path.join(server.dataDir, 'drops', 'container');
  const nestedLibraryPath = path.join(container, 'nested-library');
  fs.mkdirSync(nestedLibraryPath, { recursive: true });
  const nestedLibrary = await createLibrary(admin, {
    name: 'Ingest Nested Library', kind: 'movies', path: nestedLibraryPath, scanSchedule: 'manual',
  });
  const libraryInsideSource = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Contains destination', kind: 'movies', path: container, libraryId: nestedLibrary.id, settleSeconds: 0,
  });
  expectError(libraryInsideSource, 400, 'bad_request');
  assert.match(libraryInsideSource.json!.error.message, /must not contain each other/i);

  const duplicateDir = path.join(server.dataDir, 'drops', 'duplicate-source');
  fs.mkdirSync(duplicateDir, { recursive: true });
  const first = await createSource(admin, {
    name: 'Duplicate One', kind: 'movies', path: duplicateDir, settleSeconds: 0, autoMatch: false,
  });
  const duplicate = await admin.post<ErrorBody>('/api/ingest/sources', {
    name: 'Duplicate Two', kind: 'movies', path: duplicateDir, settleSeconds: 0,
  });
  expectError(duplicate, 409, 'conflict');

  const validationDir = path.join(server.dataDir, 'drops', 'field-validation');
  fs.mkdirSync(validationDir, { recursive: true });
  for (const body of [
    { name: 'Bad kind', kind: 'books', path: validationDir, settleSeconds: 0 },
    { name: 'Bad action', kind: 'movies', path: validationDir, action: 'teleport', settleSeconds: 0 },
    { name: 'Bad confidence', kind: 'movies', path: validationDir, minConfidence: 2, settleSeconds: 0 },
    { name: 'Bad settle', kind: 'movies', path: validationDir, settleSeconds: 4000 },
    { name: '', kind: 'movies', path: validationDir, settleSeconds: 0 },
  ]) {
    const response = await admin.post<ErrorBody>('/api/ingest/sources', body);
    expectError(response, 400, 'bad_request');
  }
  const emptyPatch = await admin.patch<ErrorBody>(`/api/ingest/sources/${first.id}`, {});
  expectError(emptyPatch, 400, 'bad_request');
  const badPatch = await admin.patch<ErrorBody>(`/api/ingest/sources/${first.id}`, { action: 'teleport' });
  expectError(badPatch, 400, 'bad_request');
  const goodPatch = await admin.patch<{ ok: boolean; item: IngestSource }>(`/api/ingest/sources/${first.id}`, {
    enabled: false, autoMatch: false, minConfidence: 0.7, settleSeconds: 0,
  });
  assert.equal(goodPatch.status, 200, goodPatch.text);
  assert.equal(goodPatch.json!.item.enabled, false);
  assert.equal(goodPatch.json!.item.minConfidence, 0.7);

  // Manager permission boundary: managers manage sources, regular users never see them.
  const deniedList = await viewer.get<ErrorBody>('/api/ingest/sources');
  expectError(deniedList, 403, 'forbidden');
  const deniedCreate = await viewer.post<ErrorBody>('/api/ingest/sources', {
    name: 'Nope', kind: 'movies', path: duplicateDir, settleSeconds: 0,
  });
  expectError(deniedCreate, 403, 'forbidden');
  assert.equal((await manager.get('/api/ingest/sources')).status, 200);
  const managerDir = path.join(server.dataDir, 'drops', 'manager-source');
  fs.mkdirSync(managerDir, { recursive: true });
  const managerSource = await createSource(manager, {
    name: 'Manager Drop', kind: 'movies', path: managerDir, settleSeconds: 0,
  });
  assert.equal((await manager.del(`/api/ingest/sources/${managerSource.id}`)).status, 200);

  // Deleting a source removes its rows but never the files on disk.
  const deleteDir = path.join(server.dataDir, 'drops', 'delete-source');
  const keepFile = writeFile(path.join(deleteDir, 'Delete Me (2020).mp4'), 'definitely not a video');
  const deleteSource = await createSource(admin, {
    name: 'Delete Drop',
    kind: 'movies',
    path: deleteDir,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.9,
    holdUnmatched: true,
    settleSeconds: 0,
  });
  const deleteRun = await scanSource(deleteSource.id);
  assert.equal(deleteRun.discovered, 1);
  assert.equal(deleteRun.review, 1, 'below-threshold item must wait in review');
  const deleteItems = await listItems(deleteSource.id);
  assert.equal(deleteItems.total, 1);
  const removed = await admin.del<{ ok: boolean; sourceId: number; removedItems: number; files: string }>(
    `/api/ingest/sources/${deleteSource.id}`,
  );
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json!.removedItems, 1);
  assert.equal(removed.json!.sourceId, deleteSource.id);
  assert.match(removed.json!.files, /untouched/i);
  assert.ok(fs.existsSync(keepFile), 'source deletion must leave the dropped file alone');
  assert.equal((await listItems(deleteSource.id)).total, 0, 'items are removed with the source');
  expectError(await admin.get<ErrorBody>(`/api/ingest/sources/${deleteSource.id}`), 404, 'not_found');
});

test('discovery with NFO, subtitles, and poster organizes canonically, indexes media, and feeds browse/stream/progress', async () => {
  const library = await makeLibrary('Discovery', 'movies');
  const drop = path.join(server.dataDir, 'drops', 'discovery');
  const sourceVideo = makeVideo(path.join(drop, 'The Slop Movie (2019).mp4'), { duration: 2 });
  writeNfo(path.join(drop, 'movie.nfo'), 'movie', {
    title: 'The Slop Movie',
    year: 2019,
    plot: 'A movie about slop, ostensibly.',
    rating: 7.5,
    runtimeMinutes: 2,
    genres: ['Comedy', 'Drama'],
  });
  makeSrt(path.join(drop, 'The Slop Movie (2019).en.srt'));
  makeImage(path.join(drop, 'poster.jpg'));

  const source = await createSource(admin, {
    name: 'Discovery Drop',
    kind: 'movies',
    path: drop,
    libraryId: library.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  discoverySourceId = source.id;

  const run = await scanSource(source.id);
  assert.equal(run.sources, 1);
  assert.equal(run.discovered, 1);
  assert.equal(run.processed, 1);
  assert.equal(run.organized, 1);
  assert.equal(run.review, 0);
  assert.equal(run.errors, 0);
  assert.deepEqual(run.scannedLibraries, [library.id]);
  assert.equal(run.mapped, 1);

  const page = await listItems(source.id);
  assert.equal(page.total, 1);
  const item = page.items[0];
  discoveryItemId = item.id;
  assert.equal(item.status, 'organized');
  assert.equal(item.sourceKind, 'movies');
  assert.equal(item.name, 'The Slop Movie (2019).mp4');

  const canonicalDir = path.join(library.path, 'The Slop Movie (2019)');
  const canonical = path.join(canonicalDir, 'The Slop Movie (2019).mp4');
  discoveryDest = canonical;
  assert.equal(item.destPath, canonical);
  assert.equal(item.libraryId, library.id);
  assert.equal(item.title, 'The Slop Movie');
  assert.equal(item.year, 2019);
  assert.equal(item.confidence, 0.95, 'a local NFO establishes 0.95 confidence');
  assert.equal(item.provider, null, 'no provider match with autoMatch off');
  assert.ok(item.mediaId, 'organized item must map to a media row');
  discoveryMediaId = item.mediaId!;
  const fullItem = await getItem(item.id);
  assert.equal(fullItem.media?.id, item.mediaId, 'item detail embeds its media row');
  assert.equal(fullItem.media?.title, 'The Slop Movie');

  assert.equal(fs.existsSync(sourceVideo), false, 'move action removes the source file');
  assert.ok(fs.existsSync(canonical), 'canonical movie file exists');
  for (const sidecar of ['The Slop Movie (2019).en.srt', 'movie.nfo', 'poster.jpg']) {
    assert.ok(fs.existsSync(path.join(canonicalDir, sidecar)), `${sidecar} must move beside the movie`);
  }
  assert.deepEqual(fs.readdirSync(drop), [], 'source drop folder is emptied by move');

  const detail = await admin.get<MediaDetail>(`/api/media/${discoveryMediaId}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json!.item.kind, 'movie');
  assert.equal(detail.json!.item.title, 'The Slop Movie');
  assert.equal(detail.json!.item.year, 2019);
  assert.ok(detail.json!.item.genres.includes('Comedy'), `NFO genres should reach media: ${JSON.stringify(detail.json!.item.genres)}`);
  assert.ok((detail.json!.item.sizeBytes ?? 0) > 0);

  // Ingested content is immediately visible to a regular viewer through browse and search.
  const search = await viewer.get<SearchBody>('/api/browse/search?q=Slop%20Movie');
  assert.equal(search.status, 200, search.text);
  assert.ok(search.json!.groups.movies?.some((entry) => entry.id === discoveryMediaId), 'search finds the ingested movie');
  const browse = await viewer.get<{ items: MediaCore[]; total: number }>('/api/browse?kind=movie');
  assert.equal(browse.status, 200);
  assert.ok(browse.json!.items.some((entry) => entry.id === discoveryMediaId), 'browse lists the ingested movie');

  // Stream info and a progress heartbeat complete the cross-feature path.
  const info = await viewer.get<StreamInfo>(`/api/stream/${discoveryMediaId}/info`);
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json!.directPlay, true);
  assert.equal(info.json!.mode, 'direct');
  assert.equal(info.json!.videoCodec, 'h264');
  assert.equal(info.json!.audioCodec, 'aac');
  assert.ok(info.json!.duration >= 1.5);

  const heartbeat = await viewer.post<{ resume: { positionSeconds: number; finished: boolean } }>(
    `/api/stream/${discoveryMediaId}/progress`,
    { positionSeconds: 15, durationSeconds: 100, mode: 'direct', client: 'ingest-test' },
  );
  assert.equal(heartbeat.status, 200, heartbeat.text);
  assert.equal(heartbeat.json!.resume.positionSeconds, 15);
  assert.equal(heartbeat.json!.resume.finished, false);
  const continueRail = await viewer.get<{ items: MediaCore[]; total: number }>('/api/continue');
  assert.equal(continueRail.status, 200);
  assert.ok(continueRail.json!.items.some((entry) => entry.id === discoveryMediaId), 'progress puts the ingested movie on Continue');
});

test('ambiguous files are held for review; manual match organizes them, ignore/retry transition, and organized items are guarded', async () => {
  const library = await makeLibrary('Review', 'movies');
  const drop = path.join(server.dataDir, 'drops', 'review');
  makeVideo(path.join(drop, 'Mystery Slop.mp4'));
  makeVideo(path.join(drop, 'Leftover Slop.mp4'));
  const source = await createSource(admin, {
    name: 'Review Drop',
    kind: 'movies',
    path: drop,
    libraryId: library.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });

  const run = await scanSource(source.id);
  assert.equal(run.discovered, 2);
  assert.equal(run.processed, 2);
  assert.equal(run.review, 2);
  assert.equal(run.organized, 0);

  const page = await listItems(source.id, 'review');
  assert.equal(page.total, 2);
  const mystery = page.items.find((item) => item.name === 'Mystery Slop.mp4')!;
  const leftover = page.items.find((item) => item.name === 'Leftover Slop.mp4')!;
  assert.ok(mystery && leftover);
  for (const item of [mystery, leftover]) {
    assert.equal(item.status, 'review');
    assert.equal(item.destPath, null, 'review items are never moved');
    assert.equal(item.confidence, 0.35, 'title-only baseline is below the threshold');
    assert.deepEqual(item.candidates, [], 'auto matching is off');
    assert.ok(fs.existsSync(item.path), 'held files stay in the drop folder');
  }

  const manual = await admin.post<{ ok: boolean; item: IngestItem; destPath: string; mediaId: number }>(
    `/api/ingest/items/${mystery.id}/match`,
    { title: 'Mystery Slop', year: 2020 },
  );
  assert.equal(manual.status, 200, manual.text);
  assert.equal(manual.json!.destPath, path.join(library.path, 'Mystery Slop (2020)', 'Mystery Slop (2020).mp4'));
  assert.ok(fs.existsSync(manual.json!.destPath));
  assert.ok(manual.json!.mediaId > 0);
  const matchedItem = await getItem(mystery.id);
  assert.equal(matchedItem.status, 'organized');
  assert.equal(matchedItem.title, 'Mystery Slop');
  assert.equal(matchedItem.year, 2020);
  assert.equal(matchedItem.confidence, 1);
  assert.equal(matchedItem.mediaId, manual.json!.mediaId);
  assert.equal(fs.existsSync(mystery.path), false, 'manual match moves the file');

  // Organized items reject further destructive actions.
  expectError(
    await admin.post<ErrorBody>(`/api/ingest/items/${mystery.id}/match`, { title: 'Another Title' }),
    409,
    'conflict',
  );
  expectError(await admin.post<ErrorBody>(`/api/ingest/items/${mystery.id}/organize`), 409, 'conflict');
  expectError(await admin.post<ErrorBody>(`/api/ingest/items/${mystery.id}/ignore`), 409, 'conflict');
  expectError(await admin.post<ErrorBody>(`/api/ingest/items/${mystery.id}/retry`), 409, 'conflict');

  // Ignore keeps the file put; retry reprocesses it back into review.
  const ignored = await admin.post<{ ok: boolean; item: IngestItem }>(`/api/ingest/items/${leftover.id}/ignore`);
  assert.equal(ignored.status, 200, ignored.text);
  assert.equal(ignored.json!.item.status, 'ignored');
  assert.ok(fs.existsSync(leftover.path));
  assert.equal((await listItems(source.id, 'ignored')).total, 1);

  const retried = await admin.post<{ ok: boolean; item: IngestItem; outcome: { status: string; confidence: number } }>(
    `/api/ingest/items/${leftover.id}/retry`,
  );
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json!.outcome.status, 'review');
  assert.equal(retried.json!.item.status, 'review');
  assert.ok(fs.existsSync(leftover.path));
  assert.equal((await listItems(source.id, 'review')).total, 1);

  const organized = await admin.post<{ ok: boolean; item: IngestItem; destPath: string; mediaId: number }>(
    `/api/ingest/items/${leftover.id}/organize`,
  );
  assert.equal(organized.status, 200, organized.text);
  assert.equal(organized.json!.item.status, 'organized');
  assert.equal(organized.json!.destPath, path.join(library.path, 'Leftover Slop', 'Leftover Slop.mp4'));
  assert.ok(fs.existsSync(organized.json!.destPath));
  assert.ok(organized.json!.mediaId > 0, 'organize action indexes the result');
  assert.equal(fs.existsSync(leftover.path), false);
  assert.equal((await listItems(source.id, 'review')).total, 0);
});

test('organize actions honor move/copy/hardlink/symlink semantics, avoid overwrites, and sanitize destination segments', async () => {
  const library = await makeLibrary('Actions', 'movies');
  const common = {
    kind: 'movies',
    libraryId: library.id,
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  } as const;

  async function organizedByName(sourceId: number, name: string): Promise<IngestItem> {
    const page = await listItems(sourceId);
    const item = page.items.find((entry) => entry.name === name);
    assert.ok(item, `${name} was not discovered`);
    assert.equal(item.status, 'organized', `${name} was not organized: ${item.error || ''}`);
    return item;
  }

  // move
  const moveDrop = path.join(server.dataDir, 'drops', 'action-move');
  const moveSourceFile = makeVideo(path.join(moveDrop, 'Move Me (2018).mp4'));
  const moveSource = await createSource(admin, { ...common, name: 'Action Move', path: moveDrop, action: 'move' });
  await scanSource(moveSource.id);
  const moved = await organizedByName(moveSource.id, 'Move Me (2018).mp4');
  const moveDest = path.join(library.path, 'Move Me (2018)', 'Move Me (2018).mp4');
  assert.equal(moved.destPath, moveDest);
  assert.equal(fs.existsSync(moveSourceFile), false, 'move removes the source');
  assert.ok(fs.existsSync(moveDest));
  assert.equal(fs.statSync(moveDest).size, moved.sizeBytes, 'destination keeps the bytes');

  // copy (also seeds the no-overwrite collision case)
  const copyDrop = path.join(server.dataDir, 'drops', 'action-copy');
  const copySourceFile = makeVideo(path.join(copyDrop, 'Copy Me (2018).mp4'));
  const rootRepeat = makeVideo(path.join(copyDrop, 'Repeat (2020).mp4'));
  const nestedRepeat = makeVideo(path.join(copyDrop, 'nested', 'Repeat (2020).mp4'));
  const copySource = await createSource(admin, { ...common, name: 'Action Copy', path: copyDrop, action: 'copy' });
  await scanSource(copySource.id);
  const copied = await organizedByName(copySource.id, 'Copy Me (2018).mp4');
  const copyDest = path.join(library.path, 'Copy Me (2018)', 'Copy Me (2018).mp4');
  assert.equal(copied.destPath, copyDest);
  assert.ok(fs.existsSync(copySourceFile), 'copy leaves the source in place');
  assert.ok(fs.existsSync(copyDest));
  assert.ok(fs.readFileSync(copySourceFile).equals(fs.readFileSync(copyDest)), 'copy preserves content');

  const copyPage = await listItems(copySource.id);
  const repeats = copyPage.items.filter((entry) => entry.name === 'Repeat (2020).mp4');
  assert.equal(repeats.length, 2);
  const repeatDir = path.join(library.path, 'Repeat (2020)');
  const repeatDests = repeats.map((entry) => entry.destPath!);
  assert.ok(repeatDests.includes(path.join(repeatDir, 'Repeat (2020).mp4')));
  assert.ok(repeatDests.includes(path.join(repeatDir, 'Repeat (2020) (2).mp4')), `collision must suffix (2): ${repeatDests.join(', ')}`);
  assert.equal(new Set(repeatDests).size, 2);
  for (const destination of repeatDests) assert.ok(fs.existsSync(destination));
  assert.ok(fs.existsSync(rootRepeat) && fs.existsSync(nestedRepeat), 'copy collision keeps both sources');

  // hardlink
  const hardDrop = path.join(server.dataDir, 'drops', 'action-hardlink');
  const hardSourceFile = makeVideo(path.join(hardDrop, 'Hard Me (2018).mp4'));
  const hardSource = await createSource(admin, { ...common, name: 'Action Hardlink', path: hardDrop, action: 'hardlink' });
  await scanSource(hardSource.id);
  const hardlinked = await organizedByName(hardSource.id, 'Hard Me (2018).mp4');
  const hardDest = path.join(library.path, 'Hard Me (2018)', 'Hard Me (2018).mp4');
  assert.equal(hardlinked.destPath, hardDest);
  assert.equal(fs.statSync(hardDest).ino, fs.statSync(hardSourceFile).ino, 'hardlink shares the inode');
  assert.ok(fs.statSync(hardDest).nlink >= 2);
  assert.ok(fs.existsSync(hardSourceFile));

  // symlink
  const symDrop = path.join(server.dataDir, 'drops', 'action-symlink');
  const symSourceFile = makeVideo(path.join(symDrop, 'Sym Me (2018).mp4'));
  const symSource = await createSource(admin, { ...common, name: 'Action Symlink', path: symDrop, action: 'symlink' });
  await scanSource(symSource.id);
  const symlinked = await organizedByName(symSource.id, 'Sym Me (2018).mp4');
  const symDest = path.join(library.path, 'Sym Me (2018)', 'Sym Me (2018).mp4');
  assert.equal(symlinked.destPath, symDest);
  assert.ok(fs.lstatSync(symDest).isSymbolicLink(), 'symlink action creates a link, not a file');
  assert.equal(fs.readlinkSync(symDest), path.resolve(symSourceFile), 'symlink target is absolute');
  assert.ok(fs.existsSync(symSourceFile), 'symlink leaves the source');
  assert.equal(fs.realpathSync(symDest), fs.realpathSync(symSourceFile));

  // Destination sanitization: separators and traversal never escape the library root.
  const escapeDrop = path.join(server.dataDir, 'drops', 'action-sanitize');
  const escapeSourceFile = makeVideo(path.join(escapeDrop, 'escape.mp4'));
  const escapeSource = await createSource(admin, { ...common, name: 'Action Sanitize', path: escapeDrop, action: 'move' });
  const escapeRun = await scanSource(escapeSource.id);
  assert.equal(escapeRun.review, 1, 'title-only file waits for a manual match');
  const escapeItem = (await listItems(escapeSource.id)).items[0];
  const matched = await admin.post<{ destPath: string; item: IngestItem }>(`/api/ingest/items/${escapeItem.id}/match`, {
    title: '../../Evil/Movie',
    year: 2021,
  });
  assert.equal(matched.status, 200, matched.text);
  const evilDest = matched.json!.destPath;
  const relative = path.relative(library.path, evilDest);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `destination escaped library: ${evilDest}`);
  assert.deepEqual(relative.split(path.sep), ['Evil Movie (2021)', 'Evil Movie (2021).mp4']);
  assert.ok(fs.existsSync(evilDest));
  assert.equal(fs.existsSync(escapeSourceFile), false);
});

test('provider status reflects toggles, stays silent while off, and the privacy audit tells the truth when IMDb is enabled', async () => {
  const library = await makeLibrary('Provider Review', 'movies');
  const drop = path.join(server.dataDir, 'drops', 'provider-review');
  makeVideo(path.join(drop, 'Oppenheimer (2023).mp4'));
  const source = await createSource(admin, {
    name: 'Provider Review Drop',
    kind: 'movies',
    path: drop,
    libraryId: library.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.9,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  const run = await scanSource(source.id);
  assert.equal(run.review, 1);
  const reviewItem = (await listItems(source.id, 'review')).items[0];
  providerReviewItemId = reviewItem.id;
  assert.equal(reviewItem.confidence, 0.55);

  const providerResponse = await admin.get<{ providers: ProviderStatus[] }>('/api/ingest/providers');
  assert.equal(providerResponse.status, 200);
  const providers = providerResponse.json!.providers;
  assert.deepEqual(providers.map((entry) => entry.id), ['tmdb', 'tvdb', 'tvmaze', 'omdb', 'imdb']);
  const tmdb = providers.find((entry) => entry.id === 'tmdb')!;
  assert.equal(tmdb.configured, false);
  assert.equal(tmdb.enabled, false);
  const tvmaze = providers.find((entry) => entry.id === 'tvmaze')!;
  assert.equal(tvmaze.keyless, true);
  assert.equal(tvmaze.enabled, false);
  const imdbOff = providers.find((entry) => entry.id === 'imdb')!;
  assert.equal(imdbOff.keyless, true);
  assert.equal(imdbOff.configured, true);
  assert.equal(imdbOff.enabled, false);
  assert.deepEqual(imdbOff.kinds, ['movie', 'show']);
  assert.deepEqual(imdbOff.hosts, ['v2.sg.media-imdb.com', 'm.media-amazon.com']);
  assert.match(imdbOff.note, /disabled/i);
  for (const provider of providers) assert.equal(provider.enabled, false, `${provider.id} must be off by default`);
  assert.equal((await viewer.get('/api/ingest/providers')).status, 403, 'only managers inspect providers');

  const privacyOff = await admin.get<PrivacyBody>('/api/admin/privacy');
  assert.equal(privacyOff.status, 200);
  assert.equal(privacyOff.json!.zeroOutbound, true, 'all providers off means zero outbound hosts');
  assert.deepEqual(privacyOff.json!.outboundEndpoints, []);

  const offSearch = await admin.post<{ candidates: IngestCandidate[]; providers: ProviderStatus[] }>(
    `/api/ingest/items/${reviewItem.id}/search`,
    { query: 'Oppenheimer' },
  );
  assert.equal(offSearch.status, 200, offSearch.text);
  assert.deepEqual(offSearch.json!.candidates, [], 'disabled providers never search');
  assert.equal(offSearch.json!.providers.length, 5);
  assert.deepEqual((await getItem(reviewItem.id)).candidates, []);

  const enabled = await admin.patch<{ ok: boolean; changed: string[]; settings: Record<string, unknown> }>(
    '/api/admin/settings',
    { imdbEnabled: true },
  );
  assert.equal(enabled.status, 200, enabled.text);
  assert.ok(enabled.json!.changed.includes('imdbEnabled'));
  assert.equal(enabled.json!.settings.imdbEnabled, true);
  const settings = await admin.get<Record<string, unknown>>('/api/admin/settings');
  assert.equal(settings.json?.imdbEnabled, true);

  const afterProviders = await admin.get<{ providers: ProviderStatus[] }>('/api/ingest/providers');
  const imdbOn = afterProviders.json!.providers.find((entry) => entry.id === 'imdb')!;
  assert.equal(imdbOn.enabled, true, 'enabled with autoMatch on');
  assert.equal(imdbOn.configured, true);
  assert.equal(imdbOn.keyless, true);
  assert.match(imdbOn.note, /automatic matching/i);

  const privacyOn = await admin.get<PrivacyBody>('/api/admin/privacy');
  assert.equal(privacyOn.status, 200);
  assert.equal(privacyOn.json!.zeroOutbound, false);
  const hosts = privacyOn.json!.outboundEndpoints.map((endpoint) => endpoint.host);
  assert.ok(hosts.includes('v2.sg.media-imdb.com'));
  assert.ok(hosts.includes('m.media-amazon.com'));
  const imdbEndpoint = privacyOn.json!.outboundEndpoints.find((endpoint) => endpoint.host === 'v2.sg.media-imdb.com')!;
  assert.deepEqual(imdbEndpoint.providers, ['imdb']);
  assert.ok(imdbEndpoint.modes.includes('manual'));
  assert.ok(imdbEndpoint.modes.includes('scan'));
  const imdbAudit = privacyOn.json!.providers.find((entry) => entry.id === 'imdb')!;
  assert.equal(imdbAudit.toggle, true);
  assert.equal(imdbAudit.enabled, true);
  assert.equal(imdbAudit.keySource, 'none');
});

test('optional manual IMDb search returns the Oppenheimer candidate when the keyless host is reachable', async (t: TestContext) => {
  const reachable = async (): Promise<boolean> => {
    try {
      const response = await fetch('https://v2.sg.media-imdb.com/suggestion/o/oppenheimer.json', {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  if (!(await reachable())) {
    t.skip('IMDb suggestions host unreachable; keyless network check skipped');
    return;
  }
  assert.ok(providerReviewItemId, 'provider review fixture must exist');
  const providers = await admin.get<{ providers: ProviderStatus[] }>('/api/ingest/providers');
  assert.equal(providers.json!.providers.find((entry) => entry.id === 'imdb')!.enabled, true);

  const search = await admin.post<{ candidates: IngestCandidate[] }>(
    `/api/ingest/items/${providerReviewItemId}/search`,
    { query: 'Oppenheimer' },
  );
  assert.equal(search.status, 200, search.text);
  const candidate = search.json!.candidates.find((entry) => entry.provider === 'imdb');
  assert.ok(candidate, `expected an IMDb candidate, got ${JSON.stringify(search.json!.candidates)}`);
  assert.match(candidate.providerId, /^tt\d+$/);
  assert.equal(candidate.title, 'Oppenheimer');
  assert.equal(candidate.year, 2023);
  assert.match(candidate.posterUrl ?? '', /^https:\/\/m\.media-amazon\.com\//);
});

test('show, music, and photo sources organize into canonical library layouts', async () => {
  // Show: folder + tvshow.nfo + episode filename.
  const showLibrary = await makeLibrary('Shows', 'shows');
  const showDrop = path.join(server.dataDir, 'drops', 'shows');
  const showFolder = path.join(showDrop, 'Breaking Slop');
  writeNfo(path.join(showFolder, 'tvshow.nfo'), 'tvshow', {
    title: 'Breaking Slop',
    year: 2008,
    plot: 'A chemistry teacher starts a media server.',
    genres: ['Drama', 'Crime'],
  });
  const episodeSource = makeVideo(path.join(showFolder, 'Breaking Slop - S02E03 - The Slopening.mp4'));
  const showSource = await createSource(admin, {
    name: 'Show Drop',
    kind: 'shows',
    path: showDrop,
    libraryId: showLibrary.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  const showRun = await scanSource(showSource.id);
  assert.equal(showRun.discovered, 1);
  assert.equal(showRun.organized, 1);
  assert.equal(showRun.errors, 0);
  const showItem = (await listItems(showSource.id)).items[0];
  const episodeDest = path.join(
    showLibrary.path,
    'Breaking Slop',
    'Season 02',
    'Breaking Slop - S02E03 - The Slopening.mp4',
  );
  assert.equal(showItem.status, 'organized');
  assert.equal(showItem.destPath, episodeDest);
  assert.equal(showItem.confidence, 0.95, 'tvshow NFO lifts confidence');
  assert.equal(showItem.seasonNumber, 2);
  assert.equal(showItem.episodeNumber, 3);
  assert.ok(showItem.mediaId, 'episode item maps to a media row');
  assert.ok(fs.existsSync(episodeDest));
  assert.equal(fs.existsSync(episodeSource), false);
  assert.ok(fs.existsSync(path.join(showLibrary.path, 'Breaking Slop', 'tvshow.nfo')), 'show NFO moves to the show root');
  assert.equal(fs.existsSync(path.join(showFolder, 'tvshow.nfo')), false);

  const episodeDetail = await admin.get<MediaDetail>(`/api/media/${showItem.mediaId}`);
  assert.equal(episodeDetail.status, 200, episodeDetail.text);
  assert.equal(episodeDetail.json!.item.kind, 'episode');
  assert.equal(episodeDetail.json!.item.title, 'The Slopening');
  assert.equal(episodeDetail.json!.item.seasonNumber, 2);
  assert.equal(episodeDetail.json!.item.episodeNumber, 3);
  assert.equal(episodeDetail.json!.show?.title, 'Breaking Slop');
  assert.equal(episodeDetail.json!.show?.year, 2008);
  assert.equal(episodeDetail.json!.season?.title, 'Season 02');

  // Music: artist/album folders from the drop layout and a numbered track filename.
  const musicLibrary = await makeLibrary('Music', 'music');
  const musicDrop = path.join(server.dataDir, 'drops', 'music');
  const musicSource = makeAudioTrack(path.join(musicDrop, 'Artist', 'Album', '01 - Song.mp3'), {
    title: 'Song',
    genre: 'Slop',
    track: 1,
  });
  const musicIngest = await createSource(admin, {
    name: 'Music Drop',
    kind: 'music',
    path: musicDrop,
    libraryId: musicLibrary.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  const musicRun = await scanSource(musicIngest.id);
  assert.equal(musicRun.organized, 1);
  assert.equal(musicRun.review, 0);
  const musicItem = (await listItems(musicIngest.id)).items[0];
  const trackDest = path.join(musicLibrary.path, 'Artist', 'Album', '01 - Song.mp3');
  assert.equal(musicItem.status, 'organized');
  assert.equal(musicItem.destPath, trackDest);
  assert.equal(musicItem.confidence, 0.6, 'local music baseline');
  assert.equal(musicItem.title, 'Song');
  assert.ok(fs.existsSync(trackDest));
  assert.equal(fs.existsSync(musicSource), false);
  assert.ok(musicItem.mediaId, 'track item maps to a media row');
  const trackDetail = await admin.get<MediaDetail>(`/api/media/${musicItem.mediaId}`);
  assert.equal(trackDetail.status, 200, trackDetail.text);
  assert.equal(trackDetail.json!.item.kind, 'track');
  assert.equal(trackDetail.json!.item.title, 'Song');
  assert.equal(trackDetail.json!.item.trackNumber, 1);
  assert.equal(trackDetail.json!.album?.title, 'Album');
  assert.equal(trackDetail.json!.artist?.title, 'Artist');

  // Photos: year folder from the filename date, original filename preserved.
  const photoLibrary = await makeLibrary('Photos', 'photos');
  const photoDrop = path.join(server.dataDir, 'drops', 'photos');
  const photoSource = makeImage(path.join(photoDrop, 'Vacation 2021.jpg'));
  const photoIngest = await createSource(admin, {
    name: 'Photo Drop',
    kind: 'photos',
    path: photoDrop,
    libraryId: photoLibrary.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  const photoRun = await scanSource(photoIngest.id);
  assert.equal(photoRun.organized, 1);
  assert.equal(photoRun.review, 0);
  const photoItem = (await listItems(photoIngest.id)).items[0];
  const photoDest = path.join(photoLibrary.path, '2021', 'Vacation 2021.jpg');
  assert.equal(photoItem.status, 'organized');
  assert.equal(photoItem.destPath, photoDest);
  assert.equal(photoItem.confidence, 0.6);
  assert.ok(fs.existsSync(photoDest));
  assert.equal(fs.existsSync(photoSource), false);
  assert.ok(photoItem.mediaId, 'photo item maps to a media row');
  const photoDetail = await admin.get<MediaDetail>(`/api/media/${photoItem.mediaId}`);
  assert.equal(photoDetail.status, 200, photoDetail.text);
  assert.equal(photoDetail.json!.item.kind, 'photo');
});

test('re-running ingest is idempotent, empty drops stay quiet, and duplicate enqueues are refused', async () => {
  // A second pass over an already organized source neither re-indexes nor duplicates files.
  assert.ok(discoverySourceId && discoveryDest);
  const rerun = await scanSource(discoverySourceId);
  assert.equal(rerun.discovered, 0);
  assert.equal(rerun.processed, 0);
  assert.equal(rerun.organized, 0);
  assert.equal(rerun.review, 0);
  assert.equal(rerun.errors, 0);
  assert.equal(rerun.mapped, 0);
  const items = await listItems(discoverySourceId);
  assert.equal(items.total, 1, 'no duplicate ingest rows');
  assert.equal(items.items[0].destPath, discoveryDest);
  const movieFiles = fs.readdirSync(path.dirname(discoveryDest)).filter((name) => name.endsWith('.mp4'));
  assert.deepEqual(movieFiles, [path.basename(discoveryDest)], 'no duplicate destination files');
  assert.ok(fs.existsSync(discoveryDest));

  // Empty drop folders produce no pending backlog across repeated passes.
  const emptyDrop = path.join(server.dataDir, 'drops', 'empty');
  fs.mkdirSync(emptyDrop, { recursive: true });
  const emptySource = await createSource(admin, {
    name: 'Empty Drop',
    kind: 'movies',
    path: emptyDrop,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  for (let pass = 0; pass < 2; pass += 1) {
    const emptyRun = await scanSource(emptySource.id);
    assert.equal(emptyRun.discovered, 0);
    assert.equal(emptyRun.processed, 0);
    assert.equal(emptyRun.errors, 0);
  }
  const emptyItems = await listItems(emptySource.id);
  assert.equal(emptyItems.total, 0);
  assert.deepEqual(emptyItems.counts, { pending: 0, review: 0, organized: 0, error: 0, ignored: 0, total: 0 });
  const emptySourceDTO = await admin.get<{ item: IngestSource }>(`/api/ingest/sources/${emptySource.id}`);
  assert.equal(emptySourceDTO.json!.item.counts.pending, 0);
  const stats = await admin.get<{ counts: Record<string, number>; watcher: { enabled: boolean } }>('/api/ingest/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json!.counts.pending, 0, 'no endless pending backlog');
  assert.equal(stats.json!.watcher.enabled, false, 'watcher is disabled for the suite');

  // Two simultaneous scan requests: one job wins, the other gets a coded conflict.
  const queueLibrary = await makeLibrary('Queue', 'movies');
  const queueDrop = path.join(server.dataDir, 'drops', 'queue');
  makeVideo(path.join(queueDrop, 'Queue Guard (2021).mp4'));
  const queueSource = await createSource(admin, {
    name: 'Queue Drop',
    kind: 'movies',
    path: queueDrop,
    libraryId: queueLibrary.id,
    action: 'move',
    autoMatch: false,
    minConfidence: 0.5,
    holdUnmatched: true,
    recursive: true,
    settleSeconds: 0,
  });
  const [first, second] = await Promise.all([
    admin.post<{ ok: boolean; jobId: string }>(`/api/ingest/sources/${queueSource.id}/scan`),
    admin.post<{ ok: boolean; jobId: string }>(`/api/ingest/sources/${queueSource.id}/scan`),
  ]);
  const accepted = [first, second].filter((response) => response.status === 200);
  const refused = [first, second].filter((response) => response.status === 409);
  assert.equal(accepted.length, 1, `exactly one scan enqueue should win: ${first.status}/${second.status}`);
  assert.equal(refused.length, 1);
  const conflict = refused[0].json as unknown as ErrorBody;
  assert.equal(conflict.error.code, 'ingest_in_progress');
  assert.equal(conflict.error.details?.jobId, accepted[0].json!.jobId);
  const queueJob = await pollJob(admin, accepted[0].json!.jobId);
  assert.equal(queueJob.status, 'done', queueJob.error || queueJob.message);
  const queueItems = await listItems(queueSource.id);
  assert.equal(queueItems.total, 1);
  assert.equal(queueItems.items[0].status, 'organized');
});
