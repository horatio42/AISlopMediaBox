import { after, before, test } from 'node:test';
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
  scanLibrary,
  startServer,
  writeNfo,
} from './helpers.ts';
import type { Client, Job, Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MediaItem {
  id: number;
  libraryId: number;
  libraryName?: string;
  kind: string;
  title: string;
  year: number | null;
  description: string;
  tagline: string | null;
  rating: number | null;
  contentRating: string | null;
  runtimeSeconds: number | null;
  container: string | null;
  sizeBytes: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  genres: string[];
  tags?: string[];
  people?: { name: string; role: string; character: string | null }[];
  audioTracks: { index: number; codec: string; channels: number | null; language: string; default: boolean }[];
  art: Record<string, string>;
  playable: boolean;
  path?: string;
  metadataProvider: string | null;
  matchScore: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

interface MediaDetail {
  item: MediaItem;
  show?: MediaItem | null;
  season?: MediaItem | null;
  seasons: MediaItem[];
  episodes: MediaItem[];
  tracks: MediaItem[];
  subtitles: { id: number; media_id: number; language: string; label: string; format: string; is_external: 0 | 1; path: string | null; stream_index: number | null; forced: 0 | 1 }[];
  related: MediaItem[];
  nextEpisode?: MediaItem | null;
  artist?: MediaItem | null;
  album?: MediaItem | null;
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface ScanResult {
  added: number;
  updated: number;
  skipped: number;
  hidden: number;
  removed: number;
  errors: string[];
  counts: Record<string, number>;
  totalBytes: number;
  durationMs: number;
  status: string;
}

interface LibraryStats {
  library: Library;
  counts: Record<string, number>;
  totalBytes: number;
  totalItems: number;
  hiddenItems: number;
  recent: MediaItem[];
  lastScanAt: string | null;
}

interface ArtManifest {
  mediaId: number;
  title: string;
  kind: string;
  art: Record<string, string>;
  items: { kind: string; width: number | null; height: number | null; source: string; url: string }[];
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let regular: Client;

let moviesRoot: string;
let movieDir: string;
let moviePath: string;
let movieFileSize: number;
let secondMoviePath = '';
let moviesLibrary: Library;
let showsLibrary: Library;
let musicLibrary: Library;
let photosLibrary: Library;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'library_manager', 'manager');
  regular = await newUserClient(server, admin, 'library_user', 'user');

  moviesRoot = path.join(server.mediaDir, 'movies');
  movieDir = path.join(moviesRoot, 'The Slop Movie (2019)');
  moviePath = makeVideo(path.join(movieDir, 'The Slop Movie (2019).mp4'));
  movieFileSize = fs.statSync(moviePath).size;
  writeNfo(path.join(movieDir, 'movie.nfo'), 'movie', {
    title: 'The Slop Movie',
    year: 2019,
    plot: 'A movie about slop, obviously.',
    tagline: 'Certified.',
    rating: 8.2,
    mpaa: 'R',
    runtimeMinutes: 100,
    genres: ['Action', 'Sci-Fi'],
    tags: ['cult-classic'],
    people: [
      { name: 'Jane Doe', role: 'actor', character: 'Dr. Slop' },
      { name: 'John Roe', role: 'actor', character: 'Barista' },
      { name: 'Wes Slop', role: 'director' },
    ],
  });
  makeImage(path.join(movieDir, 'poster.jpg'), '0x228833');
  makeSrt(path.join(movieDir, 'The Slop Movie (2019).en.srt'));
  makeSrt(path.join(movieDir, 'The Slop Movie (2019).en.forced.srt'));

  const showDir = path.join(server.mediaDir, 'shows', 'Slop Show (2020)');
  writeNfo(path.join(showDir, 'tvshow.nfo'), 'tvshow', {
    title: 'Slop Show',
    year: 2020,
    plot: 'Episodes of pure slop.',
    genres: ['Comedy'],
    people: [{ name: 'Show Host', role: 'actor', character: 'Host' }],
  });
  makeImage(path.join(showDir, 'poster.jpg'), '0x884422');
  const seasonDir = path.join(showDir, 'Season 01');
  makeVideo(path.join(seasonDir, 'Slop Show - S01E01 - Pilot.mp4'));
  makeVideo(path.join(seasonDir, 'Slop Show - S01E02 - Second Helping.mp4'));
  makeSrt(path.join(seasonDir, 'Slop Show - S01E02 - Second Helping.en.srt'));

  const artistDir = path.join(server.mediaDir, 'music', 'Slop Artist');
  const albumDir = path.join(artistDir, 'Peak Album (1999)');
  makeImage(path.join(artistDir, 'folder.jpg'), '0x663399');
  makeImage(path.join(albumDir, 'cover.jpg'), '0x993366');
  makeAudioTrack(path.join(albumDir, '01 - Opening Slop.mp3'), { title: 'Opening Slop', genre: 'Slopcore', track: 1 });
  makeAudioTrack(path.join(albumDir, '02 - Closing Slop.mp3'), { title: 'Closing Slop', genre: 'Slopcore', track: 2 });

  const photosRoot = path.join(server.mediaDir, 'photos');
  makeImage(path.join(photosRoot, 'root-photo.jpg'), '0x1166cc');
  makeImage(path.join(photosRoot, 'Trip', 'beach.jpg'), '0x11cc66');
  makeImage(path.join(photosRoot, 'Trip', 'sunset.jpg'), '0xcc6611');

  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  showsLibrary = await createLibrary(admin, { name: 'Shows', kind: 'shows', path: path.join(server.mediaDir, 'shows') });
  musicLibrary = await createLibrary(admin, { name: 'Music', kind: 'music', path: path.join(server.mediaDir, 'music') });
  photosLibrary = await createLibrary(admin, { name: 'Photos', kind: 'photos', path: photosRoot });
});

after(async () => {
  await server.stop();
});

test('library creation validates paths, kinds, schedules, duplicates, and settings', async () => {
  const uniqueDir = (suffix: string): string => {
    const dir = path.join(server.mediaDir, `validation-${suffix}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const cases: { label: string; body: Record<string, unknown>; status: number; code: string }[] = [
    { label: 'relative path', body: { name: 'Rel', kind: 'movies', path: 'movies' }, status: 400, code: 'bad_request' },
    { label: 'missing path', body: { name: 'Missing', kind: 'movies', path: path.join(server.mediaDir, 'nope') }, status: 400, code: 'bad_request' },
    { label: 'file path', body: { name: 'File', kind: 'movies', path: moviePath }, status: 400, code: 'bad_request' },
    { label: 'data dir', body: { name: 'Data', kind: 'movies', path: server.dataDir }, status: 400, code: 'bad_request' },
    { label: 'cache dir', body: { name: 'Cache', kind: 'movies', path: path.join(server.dataDir, 'cache') }, status: 400, code: 'bad_request' },
    { label: 'null byte', body: { name: 'Null', kind: 'movies', path: `${moviesRoot}\u0000evil` }, status: 400, code: 'bad_request' },
    { label: 'bad kind', body: { name: 'Kind', kind: 'podcasts', path: uniqueDir('kind') }, status: 400, code: 'bad_request' },
    {
      label: 'bad schedule',
      body: { name: 'Schedule', kind: 'movies', path: uniqueDir('schedule'), scanSchedule: 'fortnightly' },
      status: 400,
      code: 'bad_request',
    },
    { label: 'empty name', body: { name: '   ', kind: 'movies', path: uniqueDir('name') }, status: 400, code: 'bad_request' },
    {
      label: 'bad settings key',
      body: { name: 'Settings', kind: 'movies', path: uniqueDir('settings-key'), settings: { 'bad key': 1 } },
      status: 400,
      code: 'bad_request',
    },
    {
      label: 'settings not object',
      body: { name: 'Settings2', kind: 'movies', path: uniqueDir('settings-value'), settings: ['nope'] },
      status: 400,
      code: 'bad_request',
    },
    { label: 'duplicate path', body: { name: 'Dup', kind: 'movies', path: moviesRoot }, status: 409, code: 'conflict' },
  ];
  for (const entry of cases) {
    const response = await admin.post('/api/libraries', entry.body);
    assert.equal(response.status, entry.status, `${entry.label}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, entry.code, entry.label);
  }

  const denial = await regular.post('/api/libraries', { name: 'Mine', kind: 'movies', path: path.join(server.mediaDir, 'other') });
  assert.equal(denial.status, 403);
  assert.equal((denial.json as ErrorBody).error.code, 'forbidden');
});

test('library listing reports counts, bytes, existence, and parses settings', async () => {
  const response = await regular.get<PagedItems<Library>>('/api/libraries');
  assert.equal(response.status, 200);
  const libraries = (response.json as unknown as { items: Library[] }).items;
  assert.equal(libraries.length, 4);
  assert.deepEqual(libraries.map((library) => library.name).sort(), ['Movies', 'Music', 'Photos', 'Shows']);
  for (const library of libraries) {
    assert.ok(path.isAbsolute(library.path));
    assert.equal(library.exists, true);
    assert.equal(library.itemCount, 0);
    assert.equal(library.totalBytes, 0);
    assert.equal(library.scan_schedule, 'manual');
    assert.deepEqual(library.settings, {});
    assert.equal(library.lastScanAt, null);
  }
  const one = await admin.get<{ item: Library }>(`/api/libraries/${moviesLibrary.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json?.item.path, moviesRoot);
  assert.equal((await admin.get('/api/libraries/99999')).status, 404);
  assert.equal((await admin.get('/api/libraries/abc')).status, 400);
});

test('scanning a movie library fills DB fields, art, and subtitles', async () => {
  const { job, scan: result } = await scanLibrary(admin, moviesLibrary.id);
  assert.equal(result.status, 'done');
  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.counts, { movie: 1 });
  assert.equal(result.totalBytes, movieFileSize);
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(result.errors, []);
  assert.equal(job.progress, 1);
  assert.equal(job.message, 'Done. Slop secured.');
  assert.equal(job.payload.libraryId, moviesLibrary.id);
  assert.equal(job.payload.source, 'manual');

  const items = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  assert.equal(items.status, 200);
  assert.equal(items.json?.total, 1);
  const movie = items.json!.items[0];
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.title, 'The Slop Movie');
  assert.equal(movie.year, 2019);
  assert.equal(movie.description, 'A movie about slop, obviously.');
  assert.equal(movie.tagline, 'Certified.');
  assert.equal(movie.rating, 8.2);
  assert.equal(movie.contentRating, 'R');
  assert.equal(movie.libraryName, 'Movies');
  assert.ok(movie.runtimeSeconds !== null && movie.runtimeSeconds >= 1.5 && movie.runtimeSeconds <= 2.5);
  assert.equal(movie.width, 160);
  assert.equal(movie.height, 120);
  assert.equal(movie.videoCodec, 'h264');
  assert.equal(movie.audioCodec, 'aac');
  assert.equal(movie.sizeBytes, movieFileSize);
  assert.ok(['mov', 'mp4'].includes(movie.container ?? ''));
  assert.equal(movie.audioTracks.length, 1);
  assert.equal(movie.audioTracks[0].codec, 'aac');
  assert.equal(movie.audioTracks[0].default, true);
  assert.deepEqual(movie.genres.sort(), ['Action', 'Sci-Fi']);
  assert.equal(movie.metadataProvider, null);
  assert.equal(movie.matchScore, 0.95);
  assert.equal(movie.playable, true);
  assert.equal(movie.path, undefined, 'file paths must not leak through the DTO');
  assert.match(movie.art.poster ?? '', new RegExp(`^/api/art/${movie.id}/poster`));
  assert.match(movie.art.backdrop ?? '', new RegExp(`^/api/art/${movie.id}/backdrop`));

  const detail = await admin.get<MediaDetail>(`/api/media/${movie.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(
    detail.json!.item.people?.map((person) => `${person.role}:${person.name}`),
    ['cast:Jane Doe', 'cast:John Roe', 'director:Wes Slop'],
  );
  const cast = detail.json!.item.people?.find((person) => person.name === 'Jane Doe');
  assert.equal(cast?.character, 'Dr. Slop');
  assert.equal(detail.json!.nextEpisode, undefined);

  assert.equal(detail.json!.subtitles.length, 2);
  for (const subtitle of detail.json!.subtitles) {
    assert.equal(subtitle.format, 'srt');
    assert.equal(subtitle.is_external, 1);
    assert.equal(subtitle.language, 'en');
    assert.equal(subtitle.stream_index, null);
  }
  assert.deepEqual(detail.json!.subtitles.map((subtitle) => subtitle.label).sort(), ['English', 'English (forced)']);
  assert.equal(detail.json!.subtitles.filter((subtitle) => subtitle.forced === 1).length, 1);

  const subtitleList = await admin.get<{ items: unknown[]; total: number }>(`/api/media/${movie.id}/subtitles`);
  assert.equal(subtitleList.json?.total, 2);
});

test('art endpoint serves sidecar MIME, caches by ETag, and falls back to SVG', async () => {
  const items = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  const movie = items.json!.items[0];

  const manifest = await admin.get<ArtManifest>(`/api/art/${movie.id}`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json?.mediaId, movie.id);
  assert.equal(manifest.json?.title, 'The Slop Movie');
  const posterEntry = manifest.json?.items.find((entry) => entry.kind === 'poster');
  assert.equal(posterEntry?.source, 'sidecar');
  assert.equal(posterEntry?.url, `/api/art/${movie.id}/poster`);
  assert.ok(manifest.json?.items.some((entry) => entry.kind === 'backdrop'));
  assert.ok(manifest.json?.items.some((entry) => entry.kind === 'thumb'));

  const poster = await admin.get(`/api/art/${movie.id}/poster`);
  assert.equal(poster.status, 200);
  assert.equal(poster.contentType, 'image/jpeg');
  assert.match(poster.headers.get('cache-control') ?? '', /private, max-age=86400, immutable/);
  assert.match(poster.headers.get('etag') ?? '', /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(poster.body.length > 100);
  assert.equal(Number(poster.headers.get('content-length')), poster.body.length);
  assert.ok(poster.headers.get('last-modified'));

  const cached = await admin.get(`/api/art/${movie.id}/poster`, { headers: { 'If-None-Match': poster.headers.get('etag') ?? '' } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);

  const placeholder = await admin.get(`/api/art/${movie.id}/logo`);
  assert.equal(placeholder.status, 200);
  assert.match(placeholder.contentType, /image\/svg\+xml/);
  assert.match(placeholder.text, /<svg/);
  assert.match(placeholder.headers.get('cache-control') ?? '', /private, max-age=3600/);
  const placeholder304 = await admin.get(`/api/art/${movie.id}/logo`, {
    headers: { 'If-None-Match': placeholder.headers.get('etag') ?? '' },
  });
  assert.equal(placeholder304.status, 304);

  assert.equal((await admin.get(`/api/art/${movie.id}/nope`)).status, 400);
  assert.equal((await admin.get('/api/art/abc/poster')).status, 400);
  assert.equal((await admin.get('/api/art/99999/poster')).status, 404);

  const png = fs.readFileSync(makeImage(path.join(server.mediaDir, 'fixtures', 'banner.png'), '0xcc3366', '80x40'));
  const upload = await manager.request('POST', `/api/art/${movie.id}/banner`, {
    body: png,
    headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(upload.status, 201);
  assert.equal((upload.json as { ok: boolean; kind: string; bytes: number }).bytes, png.length);
  const banner = await manager.get(`/api/art/${movie.id}/banner`);
  assert.equal(banner.status, 200);
  assert.equal(banner.contentType, 'image/png');
  assert.deepEqual(banner.body, png);

  const svgUpload = await manager.request('POST', `/api/art/${movie.id}/banner`, {
    body: '<svg></svg>',
    headers: { 'Content-Type': 'image/svg+xml' },
  });
  assert.equal(svgUpload.status, 400);
  assert.match((svgUpload.json as ErrorBody).error.message, /Unsupported image type/);

  const emptyUpload = await manager.request('POST', `/api/art/${movie.id}/banner`, {
    body: Buffer.alloc(0),
    headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(emptyUpload.status, 400);

  const forbidden = await regular.request('POST', `/api/art/${movie.id}/banner`, {
    body: png,
    headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(forbidden.status, 403);

  const deleted = await manager.del(`/api/art/${movie.id}/banner`);
  assert.equal(deleted.status, 200);
  assert.equal((deleted.json as { removed: boolean }).removed, true);
  const gone = await manager.get(`/api/art/${movie.id}/banner`);
  assert.match(gone.contentType, /image\/svg\+xml/);
});

test('incremental rescan skips unchanged files and hides removed ones', async () => {
  const again = await scanLibrary(admin, moviesLibrary.id);
  const result = again.scan;
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.hidden, 0);
  assert.deepEqual(result.counts, { movie: 1 });

  secondMoviePath = path.join(moviesRoot, 'Another Slop (2001)', 'Another Slop (2001).mp4');
  makeVideo(secondMoviePath);
  const added = (await scanLibrary(admin, moviesLibrary.id)).scan;
  assert.equal(added.added, 1);
  assert.equal(added.skipped, 1);
  assert.deepEqual(added.counts, { movie: 2 });

  const list = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items?sort=title&pageSize=1&page=2`);
  assert.equal(list.json?.total, 2);
  assert.equal(list.json?.items.length, 1);
  assert.equal(list.json?.items[0].title, 'The Slop Movie');
  assert.equal(list.json?.page, 2);

  const secondItems = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items?sort=title`);
  const second = secondItems.json!.items.find((item) => item.title === 'Another Slop');
  assert.ok(second);
  assert.equal(second.year, 2001);

  fs.renameSync(secondMoviePath, `${secondMoviePath}.bak`);
  const hiddenJob = await scanLibrary(admin, moviesLibrary.id);
  const hidden = hiddenJob.scan;
  assert.equal(hidden.added, 0);
  assert.equal(hidden.updated, 0);
  assert.equal(hidden.skipped, 1);
  assert.equal(hidden.hidden, 1);
  assert.deepEqual(hidden.counts, { movie: 1 });

  const stats = await admin.get<LibraryStats>(`/api/libraries/${moviesLibrary.id}/stats`);
  assert.equal(stats.json?.counts.movie, 1);
  assert.equal(stats.json?.totalItems, 1);
  assert.equal(stats.json?.hiddenItems, 1);
  assert.equal(stats.json?.totalBytes, movieFileSize);
  assert.equal(stats.json?.library.itemCount, 1);
  assert.ok(stats.json?.lastScanAt);
  assert.equal(stats.json?.recent.length, 1);

  assert.equal((await regular.get(`/api/media/${second.id}`)).status, 404);
  const adminView = await admin.get(`/api/media/${second.id}`);
  assert.equal(adminView.status, 200);
  const browse = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie');
  assert.equal(browse.json?.total, 1);
  assert.equal(browse.json?.items[0].title, 'The Slop Movie');
});

test('shows, music, and photos scan into their hierarchies', async () => {
  const showsJob = await scanLibrary(admin, showsLibrary.id);
  const showsResult = showsJob.scan;
  assert.deepEqual(showsResult.counts, { show: 1, season: 1, episode: 2 });
  assert.equal(showsResult.added, 2, 'only episode rows count as added files');
  assert.equal(showsResult.errors.length, 0);

  const showItems = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${showsLibrary.id}/items`);
  assert.equal(showItems.json?.total, 1);
  assert.equal(showItems.json?.items[0].kind, 'show');
  assert.equal(showItems.json?.items[0].title, 'Slop Show');
  assert.equal(showItems.json?.items[0].libraryName, 'Shows');

  const show = showItems.json!.items[0];
  const detail = await admin.get<MediaDetail>(`/api/media/${show.id}`);
  assert.equal(detail.json?.seasons.length, 1);
  assert.equal(detail.json?.seasons[0].seasonNumber, 1);
  assert.equal(detail.json?.episodes.length, 2);
  assert.deepEqual(
    detail.json?.episodes.map((episode) => `${episode.seasonNumber}x${episode.episodeNumber} ${episode.title}`),
    ['1x1 Pilot', '1x2 Second Helping'],
  );
  const firstEpisode = detail.json!.episodes[0];
  const episodeDetail = await admin.get<MediaDetail>(`/api/media/${firstEpisode.id}`);
  assert.equal(episodeDetail.json?.nextEpisode?.id, detail.json!.episodes[1].id);
  assert.equal(episodeDetail.json?.show?.id, show.id);
  assert.equal(episodeDetail.json?.season?.id, detail.json!.seasons[0].id);
  assert.equal(episodeDetail.json?.subtitles.length, 0);

  const secondEpisodeDetail = await admin.get<MediaDetail>(`/api/media/${detail.json!.episodes[1].id}`);
  assert.equal(secondEpisodeDetail.json?.nextEpisode, undefined);
  assert.equal(secondEpisodeDetail.json?.subtitles.length, 1);
  assert.equal(secondEpisodeDetail.json?.subtitles[0].language, 'en');

  const musicJob = await scanLibrary(admin, musicLibrary.id);
  assert.deepEqual(musicJob.scan.counts, { artist: 1, album: 1, track: 2 });
  const musicItems = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items`);
  assert.equal(musicItems.json?.total, 2);
  assert.deepEqual(musicItems.json?.items.map((item) => item.kind).sort(), ['album', 'artist']);

  const photosJob = await scanLibrary(admin, photosLibrary.id);
  assert.deepEqual(photosJob.scan.counts, { photo: 3 });
  assert.equal((await admin.get<PagedItems<MediaItem>>(`/api/libraries/${photosLibrary.id}/items`)).json?.total, 3);

  const stats = await regular.get<{ counts: Record<string, number>; libraries: number; items: number }>('/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json?.libraries, 4);
  assert.equal(stats.json?.counts.movie, 1);
  assert.equal(stats.json?.counts.show, 1);
  assert.equal(stats.json?.counts.episode, 2);
  assert.equal(stats.json?.counts.artist, 1);
  assert.equal(stats.json?.counts.album, 1);
  assert.equal(stats.json?.counts.track, 2);
  assert.equal(stats.json?.counts.photo, 3);
  assert.ok((stats.json?.items ?? 0) >= 10);
});

test('scan-all enqueues one job per usable library and completes each', async () => {
  const response = await admin.post<{ jobIds: string[]; skipped: { libraryId: number; reason: string }[] }>('/api/libraries/scan-all');
  assert.equal(response.status, 202);
  assert.equal(response.json?.jobIds.length, 4);
  assert.deepEqual(response.json?.skipped, []);
  const jobs = await Promise.all(response.json!.jobIds.map((id) => pollJob(admin, id)));
  for (const job of jobs) {
    assert.equal(job.status, 'done');
    const payload = job.result as { libraries: ScanResult[] };
    assert.equal(payload.libraries.length, 1);
    assert.equal(payload.libraries[0].status, 'done');
  }
});

test('a scan in progress rejects a second trigger with the active job id', async () => {
  const raceRoot = path.join(server.mediaDir, 'race');
  makeVideo(path.join(raceRoot, 'Race One (2022).mp4'));
  makeVideo(path.join(raceRoot, 'Race Two (2023).mp4'));
  makeVideo(path.join(raceRoot, 'Race Three (2024).mp4'));
  const library = await createLibrary(admin, { name: 'Race', kind: 'movies', path: raceRoot });

  const first = await admin.post<{ jobId: string }>(`/api/libraries/${library.id}/scan`);
  assert.equal(first.status, 202);
  const second = await admin.post(`/api/libraries/${library.id}/scan`);
  assert.equal(second.status, 409);
  const error = second.json as ErrorBody;
  assert.equal(error.error.code, 'scan_in_progress');
  assert.equal((error.error.details as { jobId?: string }).jobId === first.json?.jobId || (error.error.details as { jobId?: string }).jobId === 'in-memory', true);

  const done = await pollJob(admin, first.json!.jobId);
  assert.equal(done.status, 'done');
  assert.equal((done.result as { libraries: ScanResult[] }).libraries[0].added, 3);
});

test('scan refuses a missing library path, but the library can still be removed', async () => {
  const missingRoot = path.join(server.mediaDir, 'vanishing');
  makeVideo(path.join(missingRoot, 'Vanishing Slop (2018).mp4'));
  const library = await createLibrary(admin, { name: 'Vanishing', kind: 'movies', path: missingRoot });
  fs.renameSync(missingRoot, `${missingRoot}-moved`);

  const scan = await admin.post(`/api/libraries/${library.id}/scan`);
  assert.equal(scan.status, 400);
  assert.match((scan.json as ErrorBody).error.message, /missing/i);
  const listed = await admin.get<{ item: Library }>(`/api/libraries/${library.id}`);
  assert.equal(listed.json?.item.exists, false);

  const deleted = await admin.del(`/api/libraries/${library.id}`);
  assert.equal(deleted.status, 200);
  assert.ok(fs.existsSync(path.join(`${missingRoot}-moved`, 'Vanishing Slop (2018).mp4')));
  assert.equal((await admin.get(`/api/libraries/${library.id}`)).status, 404);
});

test('deleting a library removes DB rows and cached art but never source files', async () => {
  const disposableRoot = path.join(server.mediaDir, 'disposable');
  const disposableVideo = makeVideo(path.join(disposableRoot, 'Disposable Slop (2017).mp4'));
  const library = await createLibrary(admin, { name: 'Disposable', kind: 'movies', path: disposableRoot });
  await scanLibrary(admin, library.id);
  const before = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${library.id}/items`);
  const mediaId = before.json!.items[0].id;
  const sourceSize = fs.statSync(disposableVideo).size;

  const deleted = await admin.del(`/api/libraries/${library.id}`);
  assert.equal(deleted.status, 200);
  const body = deleted.json as { ok: boolean; libraryId: number; removedMedia: number; sourceFiles: string };
  assert.equal(body.ok, true);
  assert.equal(body.libraryId, library.id);
  assert.ok(body.removedMedia >= 1);
  assert.match(body.sourceFiles, /untouched/);
  assert.equal((await admin.get(`/api/media/${mediaId}`)).status, 404);
  assert.equal((await admin.get(`/api/libraries/${library.id}`)).status, 404);
  assert.equal(fs.statSync(disposableVideo).size, sourceSize);
});

test('folder browser lists absolute child directories and counts media files', async () => {
  const root = await manager.get<{ path: string; parent: string | null; items: { name: string; path: string; mediaFiles: number; subdirs: number }[] }>(
    `/api/libraries/folders?path=${encodeURIComponent(server.mediaDir)}`,
  );
  assert.equal(root.status, 200);
  assert.equal(root.json?.path, server.mediaDir);
  assert.equal(root.json?.parent, server.dataDir);
  const byName = new Map(root.json!.items.map((item) => [item.name, item]));
  assert.ok(byName.has('movies'));
  assert.ok(byName.has('shows'));
  assert.ok(byName.has('music'));
  assert.ok(byName.has('photos'));
  const moviesEntry = byName.get('movies')!;
  assert.equal(moviesEntry.path, moviesRoot);
  assert.ok(Number.isInteger(moviesEntry.subdirs));
  assert.ok(moviesEntry.mediaFiles >= 1, `expected video count, got ${moviesEntry.mediaFiles}`);
  assert.ok(byName.get('photos')!.mediaFiles >= 3);

  const filesystemRoot = await admin.get<{ path: string; parent: string | null }>('/api/libraries/folders?path=%2F');
  assert.equal(filesystemRoot.status, 200);
  assert.equal(filesystemRoot.json?.path, '/');
  assert.equal(filesystemRoot.json?.parent, null);

  assert.equal((await admin.get('/api/libraries/folders?path=relative/dir')).status, 400);
  assert.equal((await admin.get(`/api/libraries/folders?path=${encodeURIComponent(path.join(server.mediaDir, 'missing-dir'))}`)).status, 404);
  assert.equal((await admin.get(`/api/libraries/folders?path=${encodeURIComponent(moviePath)}`)).status, 400);
  assert.equal((await regular.get(`/api/libraries/folders?path=${encodeURIComponent(server.mediaDir)}`)).status, 403);
});

test('library items support kind filters, pagination, sorts, and metadata updates', async () => {
  const movieOnly = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items?kind=movie&sort=added`);
  assert.equal(movieOnly.json?.total, 1);
  const invalidKind = await admin.get(`/api/libraries/${moviesLibrary.id}/items?kind=track`);
  assert.equal(invalidKind.status, 400);
  assert.equal((invalidKind.json as ErrorBody).error.code, 'bad_request');

  const paged = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items?pageSize=1&page=1`);
  assert.equal(paged.json?.total, 2);
  assert.equal(paged.json?.items.length, 1);
  const paged2 = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items?pageSize=1&page=2`);
  assert.equal(paged2.json?.items.length, 1);
  assert.notEqual(paged.json?.items[0].id, paged2.json?.items[0].id);

  const patched = await manager.patch<Library>(`/api/libraries/${photosLibrary.id}`, {
    name: 'Photo Dump',
    scanSchedule: 'weekly',
    settings: { removeMissing: true, overlap: 12, labels: ['a', 'b'] },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json?.name, 'Photo Dump');
  assert.equal(patched.json?.scan_schedule, 'weekly');
  assert.deepEqual(patched.json?.settings, { removeMissing: true, overlap: 12, labels: ['a', 'b'] });
  const persisted = await admin.get<{ item: Library }>(`/api/libraries/${photosLibrary.id}`);
  assert.equal(persisted.json?.item.name, 'Photo Dump');

  assert.equal((await manager.patch(`/api/libraries/${photosLibrary.id}`, {})).status, 400);
  assert.equal((await manager.patch(`/api/libraries/${photosLibrary.id}`, { kind: 'podcasts' })).status, 400);
  assert.equal((await manager.patch(`/api/libraries/${photosLibrary.id}`, { scanSchedule: 'never' })).status, 400);
  assert.equal((await manager.patch(`/api/libraries/${photosLibrary.id}`, { path: moviesRoot })).status, 409);
  assert.equal((await manager.patch('/api/libraries/99999', { name: 'Ghost' })).status, 404);
  assert.equal((await regular.patch(`/api/libraries/${photosLibrary.id}`, { name: 'Nope' })).status, 403);
});

