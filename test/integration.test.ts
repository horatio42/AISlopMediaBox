import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminClient,
  assert,
  createLibrary,
  makeVideo,
  newUserClient,
  pollJob,
  scanLibrary,
  startServer,
  writeNfo,
} from './helpers.ts';
import type { Client, Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MediaItem {
  id: number;
  kind: string;
  title: string;
  year: number | null;
  rating: number | null;
  genres: string[];
  progress?: { positionSeconds: number; finished: boolean; playCount: number } | null;
  art: Record<string, string>;
}

interface PagedItems<T> {
  items: T[];
  total: number;
}

interface StreamInfo {
  directPlay: boolean;
  mode: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  duration: number;
  audioTracks: { codec: string; index: number }[];
  subtitles: unknown[];
  hlsUrl: string | null;
}

interface ContinueBody {
  items: MediaItem[];
  total: number;
}

interface CollectionBody {
  id: number;
  name: string;
  kind: string;
  itemCount: number;
  items: MediaItem[];
}

interface OverviewBody {
  counts: {
    media: number;
    mediaByKind: Record<string, number>;
    libraries: number;
    collections: number;
    playlists: number;
    requests: number;
  };
  storage: { mediaItems: number; mediaBytes: number; libraries: { id: number; items: number; bytes: number }[] };
  watch: {
    totalSeconds: number;
    totalPlays: number;
    watchers: number;
    finishedCount: number;
    recent: { mediaId: number; username: string; positionSeconds: number; finished: boolean }[];
  };
  topMedia: { largest: { item: MediaItem; bytes: number }[]; mostPlayed: { item: MediaItem; plays: number; seconds: number }[] };
  jobs: { counts: Record<string, number> };
}

interface ExportBody {
  counts: Record<string, number>;
  media: { id: number }[];
  collections: { name: string }[];
}

let server: StartedServer;
let admin: Client;
let user: Client;
let library: Library;
let firstId: number;
let secondId: number;
let firstBytes: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  user = await newUserClient(server, admin, 'integration_user', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  const firstDir = path.join(moviesRoot, 'Integration One (2019)');
  const firstPath = makeVideo(path.join(firstDir, 'Integration One (2019).mp4'));
  firstBytes = fs.statSync(firstPath).size;
  writeNfo(path.join(firstDir, 'movie.nfo'), 'movie', {
    title: 'Integration One',
    year: 2019,
    plot: 'First integration movie.',
    rating: 8.4,
    genres: ['Action', 'Drama'],
  });
  const secondDir = path.join(moviesRoot, 'Integration Two (1999)');
  makeVideo(path.join(secondDir, 'Integration Two (1999).mp4'));
  writeNfo(path.join(secondDir, 'movie.nfo'), 'movie', {
    title: 'Integration Two',
    year: 1999,
    plot: 'Second integration movie.',
    rating: 6.2,
    genres: ['Action'],
  });

  library = await createLibrary(admin, { name: 'Integration', kind: 'movies', path: moviesRoot });
});

after(async () => {
  await server.stop();
});

test('scan → browse → play → progress → continue → smart collection → admin overview', async () => {
  // 1. Scan through the real job queue.
  const trigger = await admin.post<{ jobId: string }>(`/api/libraries/${library.id}/scan`);
  assert.equal(trigger.status, 202);
  const job = await pollJob(admin, trigger.json!.jobId);
  assert.equal(job.status, 'done');
  const scanResult = (job.result as { libraries: { status: string; added: number; counts: Record<string, number>; totalBytes: number }[] }).libraries[0];
  assert.equal(scanResult.status, 'done');
  assert.equal(scanResult.added, 2);
  assert.deepEqual(scanResult.counts, { movie: 2 });
  assert.ok(scanResult.totalBytes > 0);

  const items = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${library.id}/items`);
  assert.equal(items.json?.total, 2);
  firstId = items.json!.items.find((item) => item.title === 'Integration One')!.id;
  secondId = items.json!.items.find((item) => item.title === 'Integration Two')!.id;
  assert.ok(firstId && secondId);

  // 2. Browse and search see the scan immediately.
  const browse = await user.get<PagedItems<MediaItem>>('/api/browse?kind=movie&genre=Action&sort=year');
  assert.equal(browse.json?.total, 2);
  assert.deepEqual(browse.json!.items.map((item) => item.year), [2019, 1999]);
  const search = await user.get<{ groups: { movies: MediaItem[] }; total: number }>('/api/browse/search?q=Integration');
  assert.equal(search.json?.groups.movies.length, 2);
  assert.equal(search.json?.total, 2);
  assert.ok(search.json!.groups.movies.every((item) => item.art.poster));

  // 3. Playback info says direct play for the generated H.264/AAC MP4.
  const info = await user.get<StreamInfo>(`/api/stream/${firstId}/info`);
  assert.equal(info.status, 200);
  assert.equal(info.json?.directPlay, true);
  assert.equal(info.json?.mode, 'direct');
  assert.equal(info.json?.videoCodec, 'h264');
  assert.equal(info.json?.audioCodec, 'aac');
  assert.ok((info.json?.duration ?? 0) >= 1.5);
  assert.equal(info.json?.audioTracks.length, 1);
  assert.ok(info.json?.hlsUrl);

  // 4. A playback heartbeat creates a resume point.
  const heartbeat = await user.post<{ sessionId: string; resume: { positionSeconds: number; finished: boolean } }>(
    `/api/stream/${firstId}/progress`,
    { positionSeconds: 25, durationSeconds: 100, mode: 'direct', client: 'integration-test' },
  );
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.json?.resume.positionSeconds, 25);
  assert.equal(heartbeat.json?.resume.finished, false);

  // 5. Continue rail and stats reflect the heartbeat.
  const continueRail = await user.get<ContinueBody>('/api/continue');
  assert.equal(continueRail.json?.total, 1);
  assert.equal(continueRail.json!.items[0].id, firstId);
  assert.equal(continueRail.json!.items[0].progress?.positionSeconds, 25);
  const stats = await user.get<{ totalSeconds: number; itemsStarted: number; finished: { movies: number } }>('/api/progress/stats');
  assert.equal(stats.json?.totalSeconds, 25);
  assert.equal(stats.json?.itemsStarted, 1);
  assert.equal(stats.json?.finished.movies, 0);

  // 6. Finishing removes it from continue and adds it to history/stats.
  const finish = await user.post<{ resume: { finished: boolean } }>(`/api/stream/${firstId}/progress`, {
    sessionId: heartbeat.json!.sessionId,
    positionSeconds: 95,
    durationSeconds: 100,
    ended: true,
  });
  assert.equal(finish.json?.resume.finished, true);
  assert.equal((await user.get<ContinueBody>('/api/continue')).json?.total, 0);
  const history = await user.get<PagedItems<MediaItem>>('/api/history');
  assert.deepEqual(history.json!.items.map((item) => item.id), [firstId]);
  const finishedStats = await user.get<{ totalSeconds: number; finished: { movies: number }; watched: number }>('/api/progress/stats');
  assert.equal(finishedStats.json?.totalSeconds, 100);
  assert.equal(finishedStats.json?.finished.movies, 1);
  assert.equal(finishedStats.json?.watched, 1);

  // 7. Smart collection membership is computed from the scanned metadata.
  const smart = await user.post<CollectionBody>('/api/collections', {
    name: 'Integration Action Bangers',
    kind: 'smart',
    rules: {
      match: 'all',
      rules: [
        { field: 'kind', op: 'eq', value: 'movie' },
        { field: 'genre', op: 'eq', value: 'Action' },
        { field: 'rating', op: 'gte', value: 8 },
      ],
    },
  });
  assert.equal(smart.status, 201);
  assert.equal(smart.json?.itemCount, 1);
  assert.equal(smart.json?.items, undefined);
  const smartDetail = await user.get<CollectionBody>(`/api/collections/${smart.json!.id}`);
  assert.deepEqual(smartDetail.json!.items.map((item) => item.id), [firstId]);

  // Lowering the rating removes it from the collection without touching the collection row.
  const rated = await admin.patch<{ item: MediaItem }>(`/api/media/${firstId}`, { rating: 4 });
  assert.equal(rated.status, 200);
  const afterRating = await user.get<CollectionBody>(`/api/collections/${smart.json!.id}`);
  assert.equal(afterRating.json?.itemCount, 0);
  assert.deepEqual(afterRating.json!.items, []);
  const browseRating = await user.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=rating');
  assert.deepEqual(browseRating.json!.items.map((item) => item.id), [secondId, firstId]);

  // 8. Admin overview stitches the whole flow together.
  const overview = await admin.get<OverviewBody>('/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json?.counts.libraries, 1);
  assert.equal(overview.json?.counts.media, 2);
  assert.deepEqual(overview.json?.counts.mediaByKind, { movie: 2 });
  assert.equal(overview.json?.counts.collections, 5, 'four seeded collections plus the smart one');
  assert.equal(overview.json?.counts.playlists, 0);
  assert.equal(overview.json?.counts.requests, 0);
  assert.equal(overview.json?.storage.mediaItems, 2);
  assert.ok((overview.json?.storage.mediaBytes ?? 0) >= firstBytes);
  assert.equal(overview.json?.storage.libraries[0].id, library.id);
  assert.equal(overview.json?.storage.libraries[0].items, 2);
  assert.ok(overview.json!.topMedia.largest.some((entry) => entry.item.id === firstId));
  assert.equal(overview.json?.topMedia.mostPlayed[0].item.id, firstId);
  assert.equal(overview.json?.topMedia.mostPlayed[0].plays, 1);
  assert.equal(overview.json?.topMedia.mostPlayed[0].seconds, 95);
  assert.equal(overview.json?.watch.totalSeconds, 95);
  assert.equal(overview.json?.watch.totalPlays, 1);
  assert.equal(overview.json?.watch.watchers, 1);
  assert.equal(overview.json?.watch.finishedCount, 1);
  assert.equal(overview.json?.watch.recent[0].mediaId, firstId);
  assert.equal(overview.json?.watch.recent[0].username, 'integration_user');
  assert.equal(overview.json?.watch.recent[0].positionSeconds, 95);
  assert.equal(overview.json?.watch.recent[0].finished, true);
  assert.ok((overview.json?.jobs.counts.done ?? 0) >= 1);

  // 9. Export agrees with the same corpus.
  const exported = await admin.get<ExportBody>('/api/admin/export');
  assert.equal(exported.status, 200);
  const counts = exported.json!.counts;
  assert.equal(counts.users, 2);
  assert.equal(counts.libraries, 1);
  assert.equal(counts.media, 2);
  assert.ok(counts.art >= 2);
  assert.equal(counts.collections, 5);
  assert.equal(counts.playlists, 0);
  assert.deepEqual(exported.json!.media.map((entry) => entry.id).sort((a, b) => a - b), [firstId, secondId].sort((a, b) => a - b));
  assert.ok(exported.json!.collections.some((collection) => collection.name === 'Integration Action Bangers'));
  assert.equal((await user.get('/api/admin/export')).status, 403);
});
