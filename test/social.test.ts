import { after, before, test } from 'node:test';
import path from 'node:path';
import {
  adminClient,
  assert,
  createLibrary,
  makeVideo,
  newUserClient,
  scanLibrary,
  startServer,
  writeNfo,
} from './helpers.ts';
import type { Client, Library, NfoOptions, StartedServer } from './helpers.ts';

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
  favorite?: boolean;
  watched?: boolean;
  userRating?: number | null;
  progress?: { positionSeconds: number; finished: boolean } | null;
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface ProgressBody {
  ok?: boolean;
  progress: { positionSeconds: number; durationSeconds: number; finished: boolean; playCount: number } | null;
  state: { favorite: boolean; watched: boolean; rating: number | null };
  durationSeconds?: number;
}

interface ContinueBody {
  items: (MediaItem & { showId: number | null; show: MediaItem | null })[];
  total: number;
  limit?: number;
}

interface StatsBody {
  totalSeconds: number;
  totalMinutes: number;
  itemsStarted: number;
  playCount: number;
  favorites: number;
  watched: number;
  rated: number;
  finished: { movies: number; episodes: number; total: number };
  topGenres: { genre: string; items: number; seconds: number }[];
  streakDays: number;
  longestStreakDays: number;
}

interface Collection {
  id: number;
  name: string;
  description: string;
  kind: string;
  rules: { match?: string; rules?: { field: string; op: string; value: unknown }[] };
  pinned: boolean;
  sortOrder: number;
  itemCount: number;
  createdBy: string | null;
  items?: MediaItem[];
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let user: Client;
let other: Client;
let moviesLibrary: Library;

const ids: Record<string, number> = {};
let showId: number;
let episodeOne: number;
let episodeTwo: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'social_manager', 'manager');
  user = await newUserClient(server, admin, 'social_user', 'user');
  other = await newUserClient(server, admin, 'social_other', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  const makeMovie = (folder: string, file: string, nfo: NfoOptions) => {
    const dir = path.join(moviesRoot, folder);
    makeVideo(path.join(dir, file));
    writeNfo(path.join(dir, 'movie.nfo'), 'movie', nfo);
  };
  makeMovie('Sloppy One (2018)', 'Sloppy One (2018).mp4', {
    title: 'Sloppy One',
    year: 2018,
    plot: 'First.',
    rating: 7,
    genres: ['Action'],
    people: [{ name: 'Jane Doe', role: 'actor', character: 'Lead' }],
  });
  makeMovie('Sloppy Two (2005)', 'Sloppy Two (2005).mp4', {
    title: 'Sloppy Two',
    year: 2005,
    plot: 'Second.',
    rating: 9.2,
    genres: ['Comedy'],
  });
  makeMovie('Sloppy Three (1999)', 'Sloppy Three (1999).mp4', {
    title: 'Sloppy Three',
    year: 1999,
    plot: 'Third.',
    rating: 5,
    genres: ['Action'],
  });

  const showDir = path.join(server.mediaDir, 'shows', 'Slop Chronicles (2020)');
  writeNfo(path.join(showDir, 'tvshow.nfo'), 'tvshow', { title: 'Slop Chronicles', year: 2020, plot: 'Chronicled slop.', genres: ['Drama'] });
  makeVideo(path.join(showDir, 'Season 01', 'Slop Chronicles - S01E01 - Begin.mp4'));
  makeVideo(path.join(showDir, 'Season 01', 'Slop Chronicles - S01E02 - Continue.mp4'));

  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  const showsLibrary = await createLibrary(admin, { name: 'Shows', kind: 'shows', path: path.join(server.mediaDir, 'shows') });
  await scanLibrary(admin, moviesLibrary.id);
  await scanLibrary(admin, showsLibrary.id);

  const movies = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  for (const item of movies.json!.items) ids[item.title] = item.id;
  const shows = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${showsLibrary.id}/items`);
  showId = shows.json!.items[0].id;
  const show = await admin.get<{ episodes: MediaItem[] }>(`/api/media/${showId}`);
  episodeOne = show.json!.episodes[0].id;
  episodeTwo = show.json!.episodes[1].id;
});

after(async () => {
  await server.stop();
});

test('progress writes validate input, upsert, auto-finish, and clear resumes', async () => {
  const one = ids['Sloppy One'];
  const two = ids['Sloppy Two'];

  const cases: { body: Record<string, unknown>; media?: number }[] = [
    { body: {} },
    { body: { positionSeconds: -1 } },
    { body: { positionSeconds: 'soon' } },
    { body: { positionSeconds: 1, durationSeconds: -1 } },
    { body: { positionSeconds: 60 * 60 * 24 * 8 } },
    { body: { positionSeconds: 1, episodeId: 'x' } },
    { body: {}, media: 99999 },
  ];
  for (const entry of cases) {
    const response = await user.put(`/api/progress/${entry.media ?? one}`, entry.body);
    assert.equal(response.status, entry.media ? 404 : 400, `${JSON.stringify(entry)}: ${response.text}`);
  }

  const first = await user.put<ProgressBody>(`/api/progress/${one}`, { positionSeconds: 30, durationSeconds: 120 });
  assert.equal(first.status, 200);
  assert.equal(first.json?.ok, true);
  assert.equal(first.json?.progress?.positionSeconds, 30);
  assert.equal(first.json?.progress?.durationSeconds, 120);
  assert.equal(first.json?.progress?.finished, false);
  assert.equal(first.json?.progress?.playCount, 1);
  assert.equal(first.json?.state.favorite, false);
  assert.equal(first.json?.state.watched, false);

  const updated = await user.put<ProgressBody>(`/api/progress/${one}`, { positionSeconds: 50, durationSeconds: 120 });
  assert.equal(updated.json?.progress?.positionSeconds, 50);
  assert.equal(updated.json?.progress?.playCount, 1);

  const read = await user.get<ProgressBody>(`/api/progress/${one}`);
  assert.equal(read.status, 200);
  assert.equal(read.json?.progress?.positionSeconds, 50);
  assert.equal(read.json?.durationSeconds, 120);
  assert.equal(read.json?.state.watched, false);

  const finished = await user.put<ProgressBody>(`/api/progress/${two}`, { positionSeconds: 110, durationSeconds: 120 });
  assert.equal(finished.status, 200);
  assert.equal(finished.json?.progress?.finished, true);
  assert.equal(finished.json?.progress?.playCount, 1);
  assert.equal(finished.json?.state.watched, true);

  const clamped = await user.put<ProgressBody>(`/api/progress/${two}`, { positionSeconds: 500, durationSeconds: 120 });
  assert.equal(clamped.json?.progress?.positionSeconds, 120);
  assert.equal(clamped.json?.progress?.finished, true);

  const explicit = await user.put<ProgressBody>(`/api/progress/${one}`, { positionSeconds: 1, finished: true });
  assert.equal(explicit.json?.progress?.finished, true);

  // Clearing a resume point zeroes the position without erasing history.
  const cleared = await user.del(`/api/progress/${two}`);
  assert.equal(cleared.status, 200);
  const afterClear = await user.get<ProgressBody>(`/api/progress/${two}`);
  assert.equal(afterClear.json?.progress?.positionSeconds, 0);
  assert.equal(afterClear.json?.progress?.finished, true);
  assert.equal((await user.del(`/api/progress/${two}`)).status, 200);
  const noProgress = await user.del(`/api/progress/${ids['Sloppy Three']}`);
  assert.equal(noProgress.status, 404);
});

test('continue groups episodes by show and excludes finished or barely-started items', async () => {
  const one = ids['Sloppy One'];
  await user.put(`/api/progress/${one}`, { positionSeconds: 30, durationSeconds: 120 });
  await user.put(`/api/progress/${episodeOne}`, { positionSeconds: 20, durationSeconds: 100 });
  await user.put(`/api/progress/${episodeTwo}`, { positionSeconds: 8, durationSeconds: 100 });
  await user.put(`/api/progress/${ids['Sloppy Three']}`, { positionSeconds: 4, durationSeconds: 100 });

  const list = await user.get<ContinueBody>('/api/continue');
  assert.equal(list.status, 200);
  assert.equal(list.json?.total, 2);
  assert.deepEqual(list.json!.items.map((item) => item.id), [episodeTwo, one]);
  const movieEntry = list.json!.items.find((item) => item.id === one)!;
  assert.equal(movieEntry.showId, null);
  assert.equal(movieEntry.show, null);
  assert.equal(movieEntry.progress?.positionSeconds, 30);
  const episodeEntry = list.json!.items.find((item) => item.id === episodeTwo)!;
  assert.equal(episodeEntry.showId, showId);
  assert.equal(episodeEntry.show?.title, 'Slop Chronicles');
  assert.ok(!list.json!.items.some((item) => item.id === episodeOne), 'one entry per show is enough');

  const limited = await user.get<ContinueBody>('/api/continue?limit=1');
  assert.equal(limited.json?.items.length, 1);
  assert.equal(limited.json?.limit, 1);
  assert.equal(limited.json?.total, 2);
  const viaProgress = await user.get<ContinueBody>('/api/progress/continue');
  assert.deepEqual(viaProgress.json?.items.map((item) => item.id), list.json!.items.map((item) => item.id));

  const otherUser = await other.get<ContinueBody>('/api/continue');
  assert.equal(otherUser.json?.total, 0);
  assert.deepEqual(otherUser.json?.items, []);
});

test('history filters by kind, paginates, and includes finished items', async () => {
  const all = await user.get<PagedItems<MediaItem>>('/api/history');
  assert.equal(all.status, 200);
  assert.ok((all.json?.total ?? 0) >= 3);
  const movies = await user.get<PagedItems<MediaItem>>('/api/history?kind=movie');
  assert.equal(movies.json?.total, 3);
  const episodes = await user.get<PagedItems<MediaItem>>('/api/history?kind=episode');
  assert.equal(episodes.json?.total, 2);
  const paged = await user.get<PagedItems<MediaItem>>('/api/history?pageSize=1&page=2');
  assert.equal(paged.json?.items.length, 1);
  assert.equal(paged.json?.pageSize, 1);
  const invalid = await user.get('/api/history?kind=podcast');
  assert.equal(invalid.status, 400);
});

test('item state favorites, ratings, and watched flags persist and stay per-user', async () => {
  const one = ids['Sloppy One'];
  const state = await user.put<{ ok: boolean; favorite: boolean; watched: boolean; rating: number | null }>(`/api/progress/${one}/state`, {
    favorite: true,
    rating: 8.5,
  });
  assert.equal(state.status, 200);
  assert.equal(state.json?.favorite, true);
  assert.equal(state.json?.rating, 8.5);
  assert.equal(state.json?.watched, true, 'an earlier explicit finish marked it watched');

  const read = await user.get<ProgressBody>(`/api/progress/${one}`);
  assert.equal(read.json?.state.favorite, true);
  assert.equal(read.json?.state.rating, 8.5);
  assert.equal(read.json?.state.watched, true);

  const favorites = await user.get<PagedItems<MediaItem>>('/api/browse?favorites=1');
  assert.deepEqual(favorites.json!.items.map((item) => item.id), [one]);
  assert.equal(favorites.json!.items[0].userRating, 8.5);
  assert.equal((await other.get<PagedItems<MediaItem>>('/api/browse?favorites=1')).json?.total, 0);

  const toggled = await user.post<{ favorite: boolean }>(`/api/progress/${one}/favorite`, {});
  assert.equal(toggled.status, 200);
  assert.equal(toggled.json?.favorite, false);
  const toggledBack = await user.post<{ favorite: boolean }>(`/api/progress/${one}/favorite`, {});
  assert.equal(toggledBack.json?.favorite, true);

  const watched = await user.put<{ watched: boolean }>(`/api/progress/${one}/state`, { watched: true });
  assert.equal(watched.json?.watched, true);
  const progress = await user.get<ProgressBody>(`/api/progress/${one}`);
  assert.equal(progress.json?.progress?.finished, true);
  assert.equal(progress.json?.progress?.positionSeconds, 120);

  const unwatched = await user.put<{ watched: boolean }>(`/api/progress/${one}/state`, { watched: false });
  assert.equal(unwatched.json?.watched, false);
  const after = await user.get<ProgressBody>(`/api/progress/${one}`);
  assert.equal(after.json?.progress?.finished, false);
  assert.equal(after.json?.progress?.positionSeconds, 0);

  const clearedRating = await user.put<{ rating: number | null }>(`/api/progress/${one}/state`, { rating: null });
  assert.equal(clearedRating.json?.rating, null);

  const invalid: Record<string, unknown>[] = [
    {},
    { favorite: 'yes' },
    { watched: 1 },
    { rating: 11 },
    { rating: -2 },
    { rating: 'great' },
  ];
  for (const body of invalid) {
    const response = await user.put(`/api/progress/${one}/state`, body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
  }
  assert.equal((await user.put('/api/progress/99999/state', { favorite: true })).status, 404);
});

test('collections seed four pinned starters with live smart counts', async () => {
  const response = await user.get<PagedItems<Collection>>('/api/collections');
  assert.equal(response.status, 200);
  assert.equal(response.json?.total, 4);
  const byName = new Map(response.json!.items.map((collection) => [collection.name, collection]));
  assert.deepEqual([...byName.keys()], ['Certified Bangers', 'Recently Added', 'Absolute Cinema', 'The Vault']);
  for (const collection of byName.values()) {
    assert.equal(collection.pinned, true);
    assert.equal(collection.createdBy, null);
  }
  const bangers = byName.get('Certified Bangers')!;
  assert.equal(bangers.kind, 'manual');
  assert.equal(bangers.itemCount, 0);
  const recent = byName.get('Recently Added')!;
  assert.equal(recent.kind, 'smart');
  assert.equal(recent.rules.match, 'all');
  assert.deepEqual(recent.rules.rules, [{ field: 'addedWithinDays', op: 'lte', value: 30 }]);
  assert.equal(recent.itemCount, 4);
  const cinema = byName.get('Absolute Cinema')!;
  assert.deepEqual(cinema.rules.rules, [{ field: 'rating', op: 'gte', value: 8 }]);
  assert.equal(cinema.itemCount, 1);
  const vault = byName.get('The Vault')!;
  assert.deepEqual(vault.rules.rules, [{ field: 'year', op: 'lt', value: 2000 }]);
  assert.equal(vault.itemCount, 1);

  const recentDetail = await user.get<Collection>(`/api/collections/${recent.id}`);
  assert.equal(recentDetail.status, 200);
  assert.equal(recentDetail.json?.items?.length, 4);
  assert.ok(recentDetail.json!.items!.every((item) => item.kind === 'movie' || item.kind === 'show'));
  const vaultDetail = await user.get<Collection>(`/api/collections/${vault.id}`);
  assert.deepEqual(vaultDetail.json!.items!.map((item) => item.title), ['Sloppy Three']);

  // Seeds happen exactly once, even across repeated reads.
  const again = await user.get<PagedItems<Collection>>('/api/collections');
  assert.equal(again.json?.total, 4);
});

test('manual collections validate creation, items, ordering, and ownership', async () => {
  const manual = await user.post<Collection>('/api/collections', { name: 'My Picks', description: 'Hand picked.' });
  assert.equal(manual.status, 201);
  assert.equal(manual.json?.kind, 'manual');
  assert.equal(manual.json?.itemCount, 0);
  assert.equal(manual.json?.createdBy, 'social_user');
  const manualId = manual.json!.id;

  const duplicate = await other.post('/api/collections', { name: 'my picks' });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.json as ErrorBody).error.code, 'conflict');
  assert.equal((await user.post('/api/collections', { name: 'Bad', kind: 'vibes' })).status, 400);
  assert.equal((await user.post('/api/collections', { name: 'Smartless', kind: 'smart' })).status, 400);
  assert.equal((await user.post('/api/collections', { name: 'Ruley', kind: 'manual', rules: { match: 'all', rules: [] } })).status, 400);
  const pinned = await user.post('/api/collections', { name: 'Pinned By User', pinned: true });
  assert.equal(pinned.status, 403);
  assert.equal((pinned.json as ErrorBody).error.code, 'forbidden');

  const one = ids['Sloppy One'];
  const two = ids['Sloppy Two'];
  const add = await user.post<{ ok: boolean; added: number; itemCount: number }>(`/api/collections/${manualId}/items`, { mediaIds: [one, two] });
  assert.equal(add.status, 201);
  assert.equal(add.json?.added, 2);
  assert.equal(add.json?.itemCount, 2);
  const duplicateAdd = await user.post<{ itemCount: number }>(`/api/collections/${manualId}/items`, { mediaIds: [one] });
  assert.equal(duplicateAdd.status, 201);
  assert.equal(duplicateAdd.json?.itemCount, 2);
  const missing = await user.post(`/api/collections/${manualId}/items`, { mediaIds: [one, 99999] });
  assert.equal(missing.status, 400);
  assert.deepEqual((missing.json as ErrorBody).error.details as { missing?: number[] }, { missing: [99999] });

  const detail = await user.get<Collection>(`/api/collections/${manualId}`);
  assert.deepEqual(detail.json!.items!.map((item) => item.id), [one, two]);
  assert.equal(detail.json?.itemCount, 2);

  const reorder = await user.put<{ itemCount: number }>(`/api/collections/${manualId}/items`, { mediaIds: [two] });
  assert.equal(reorder.status, 200);
  assert.equal(reorder.json?.itemCount, 2);
  const reordered = await user.get<Collection>(`/api/collections/${manualId}`);
  assert.deepEqual(reordered.json!.items!.map((item) => item.id), [two, one]);
  const badReorder = await user.put(`/api/collections/${manualId}/items`, { mediaIds: [ids['Sloppy Three']] });
  assert.equal(badReorder.status, 400);

  const removed = await user.del(`/api/collections/${manualId}/items/${one}`);
  assert.equal(removed.status, 200);
  assert.equal((removed.json as { itemCount: number }).itemCount, 1);
  assert.equal((await user.del(`/api/collections/${manualId}/items/${one}`)).status, 404);

  assert.equal((await other.patch(`/api/collections/${manualId}`, { description: 'hijack' })).status, 403);
  assert.equal((await other.del(`/api/collections/${manualId}`)).status, 403);
  assert.equal((await other.post(`/api/collections/${manualId}/items`, { mediaIds: [one] })).status, 403);
  const patched = await admin.patch<Collection>(`/api/collections/${manualId}`, { description: 'Moderated picks.' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json?.description, 'Moderated picks.');
  const ownerPatch = await user.patch<Collection>(`/api/collections/${manualId}`, { name: 'My Picks Renamed' });
  assert.equal(ownerPatch.json?.name, 'My Picks Renamed');
  assert.equal((await user.patch(`/api/collections/${manualId}`, { name: 'Absolute Cinema' })).status, 409);
  assert.equal((await user.patch(`/api/collections/${manualId}`, {})).status, 400);
  assert.equal((await user.patch(`/api/collections/${manualId}`, { pinned: true })).status, 403);

  const managerPinned = await manager.post<Collection>('/api/collections', { name: 'Manager Pinned', pinned: true, sortOrder: -5 });
  assert.equal(managerPinned.status, 201);
  assert.equal(managerPinned.json?.pinned, true);
  assert.equal(managerPinned.json?.sortOrder, -5);
  const listed = await user.get<PagedItems<Collection>>('/api/collections');
  assert.equal(listed.json!.items[0].name, 'Manager Pinned');

  assert.equal((await user.get('/api/collections/99999')).status, 404);
  assert.equal((await user.get('/api/collections/abc')).status, 400);
  assert.equal((await user.del(`/api/collections/${manualId}`)).status, 200);
  assert.equal((await user.get(`/api/collections/${manualId}`)).status, 404);
});

test('watch stats total time, finished kinds, favorites, and genres', async () => {
  const stats = await user.get<StatsBody>('/api/progress/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json?.totalSeconds, 152);
  assert.equal(stats.json?.totalMinutes, 3);
  assert.equal(stats.json?.itemsStarted, 5);
  assert.equal(stats.json?.playCount, 6);
  assert.equal(stats.json?.favorites, 1);
  assert.equal(stats.json?.watched, 1);
  assert.equal(stats.json?.rated, 0);
  assert.equal(stats.json?.finished.movies, 1);
  assert.equal(stats.json?.finished.episodes, 0);
  assert.equal(stats.json?.finished.total, 1);
  assert.deepEqual(stats.json?.topGenres[0], { genre: 'Comedy', items: 1, seconds: 120 });
  assert.equal(stats.json?.streakDays, 1);
  assert.equal(stats.json?.longestStreakDays, 1);
  const viaProgress = await user.get<StatsBody>('/api/progress/stats');
  assert.equal(viaProgress.json?.totalSeconds, 152);
  assert.equal((await other.get<StatsBody>('/api/progress/stats')).json?.totalSeconds, 0);
});

test('smart collections evaluate rules live and validate every rule', async () => {
  const one = ids['Sloppy One'];
  const two = ids['Sloppy Two'];
  const three = ids['Sloppy Three'];

  const nine = await user.post<Collection>('/api/collections', {
    name: 'Nine Plus',
    kind: 'smart',
    rules: { match: 'all', rules: [{ field: 'rating', op: 'gte', value: 9 }] },
  });
  assert.equal(nine.status, 201);
  assert.equal(nine.json?.itemCount, 1);
  const nineId = nine.json!.id;
  const nineDetail = await user.get<Collection>(`/api/collections/${nineId}`);
  assert.deepEqual(nineDetail.json!.items!.map((item) => item.id), [two]);

  // Editing media metadata changes smart membership without touching the collection.
  const rated = await manager.patch<{ ok: boolean; item: MediaItem }>(`/api/media/${three}`, { rating: 9.9 });
  assert.equal(rated.status, 200);
  const nineAfter = await user.get<Collection>(`/api/collections/${nineId}`);
  assert.equal(nineAfter.json?.itemCount, 2);
  assert.deepEqual(nineAfter.json!.items!.map((item) => item.id), [three, two]);

  const actionModern = await user.post<Collection>('/api/collections', {
    name: 'Action Modern',
    kind: 'smart',
    rules: {
      match: 'all',
      rules: [
        { field: 'kind', op: 'eq', value: 'movie' },
        { field: 'genre', op: 'eq', value: 'Action' },
        { field: 'year', op: 'gte', value: 2000 },
      ],
    },
  });
  assert.equal(actionModern.status, 201);
  assert.equal(actionModern.json?.itemCount, 1);
  assert.deepEqual((await user.get<Collection>(`/api/collections/${actionModern.json!.id}`)).json!.items!.map((item) => item.id), [one]);

  const anyRules = await user.post<Collection>('/api/collections', {
    name: 'Best Or Old',
    kind: 'smart',
    rules: {
      match: 'any',
      rules: [
        { field: 'rating', op: 'gte', value: 9 },
        { field: 'year', op: 'lt', value: 2000 },
      ],
    },
  });
  assert.equal(anyRules.status, 201);
  assert.equal(anyRules.json?.rules.match, 'any');
  const anyDetail = await user.get<Collection>(`/api/collections/${anyRules.json!.id}`);
  assert.deepEqual(anyDetail.json!.items!.map((item) => item.id).sort((a, b) => a - b), [two, three].sort((a, b) => a - b));

  const updatedRules = await user.patch<Collection>(`/api/collections/${nineId}`, {
    rules: { match: 'all', rules: [{ field: 'rating', op: 'gte', value: 9.5 }] },
  });
  assert.equal(updatedRules.status, 200);
  assert.equal(updatedRules.json?.itemCount, 1);
  assert.deepEqual((await user.get<Collection>(`/api/collections/${nineId}`)).json!.items!.map((item) => item.id), [three]);

  const invalidRules: Record<string, unknown>[] = [
    {},
    { match: 'some', rules: [{ field: 'rating', op: 'gte', value: 9 }] },
    { match: 'all', rules: [] },
    { match: 'all', rules: [{ field: 'watched', op: 'eq', value: true }] },
    { match: 'all', rules: [{ field: 'year', op: 'contains', value: 2000 }] },
    { match: 'all', rules: [{ field: 'kind', op: 'eq', value: 'podcast' }] },
    { match: 'all', rules: [{ field: 'year', op: 'gte', value: '2000' }] },
    { match: 'all', rules: [{ field: 'rating', op: 'gt', value: 11 }] },
    { match: 'all', rules: [{ field: 'addedWithinDays', op: 'lte', value: -1 }] },
    { match: 'all', rules: [{ field: 'genre', op: 'in', value: 'Action' }] },
    { match: 'all', rules: ['nope'] },
    { match: 'all', rules: [{ field: 'genre', op: 'eq' }] },
    { match: 'all', rules: Array.from({ length: 21 }, () => ({ field: 'genre', op: 'eq', value: 'Action' })) },
  ];
  for (const rules of invalidRules) {
    const response = await user.post('/api/collections', { name: `Invalid ${Math.random()}`, kind: 'smart', rules });
    assert.equal(response.status, 400, `${JSON.stringify(rules)}: ${response.text}`);
    const error = response.json as ErrorBody;
    assert.equal(error.error.code, 'invalid_rules');
  }

  assert.equal((await user.post(`/api/collections/${nineId}/items`, { mediaIds: [one] })).status, 400);
  assert.equal((await other.patch(`/api/collections/${nineId}`, { description: 'stolen' })).status, 403);
});

