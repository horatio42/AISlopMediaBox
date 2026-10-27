import { after, before, test } from 'node:test';
import path from 'node:path';
import {
  adminClient,
  assert,
  createLibrary,
  makeAudioTrack,
  makeImage,
  makeVideo,
  newUserClient,
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
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface Playlist {
  id: number;
  name: string;
  description: string;
  kind: string;
  isPublic: boolean;
  createdBy: string | null;
  itemCount: number;
  durationSeconds: number;
  items?: MediaItem[];
}

interface Party {
  id: string;
  name: string;
  hostId: number | null;
  host: { id: number; username: string; displayName: string } | null;
  mediaId: number;
  media: MediaItem | null;
  position: number;
  paused: boolean;
  isActive: boolean;
  memberCount: number;
  members: { userId: number; username: string; isHost: boolean; joinedAt: string }[];
  isHost: boolean;
}

let server: StartedServer;
let admin: Client;
let user: Client;
let other: Client;
let manager: Client;

let moviesLibrary: Library;
let musicLibrary: Library;
let photosLibrary: Library;
let showsLibrary: Library;
let movieA: number;
let movieB: number;
let trackId: number;
let photoId: number;
let showId: number;
let episodeId: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  user = await newUserClient(server, admin, 'playlist_user', 'user');
  other = await newUserClient(server, admin, 'playlist_other', 'user');
  manager = await newUserClient(server, admin, 'playlist_manager', 'manager');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  for (const [folder, title, year] of [
    ['Party Movie A (2010)', 'Party Movie A', 2010],
    ['Party Movie B (2011)', 'Party Movie B', 2011],
  ] as const) {
    const dir = path.join(moviesRoot, folder);
    makeVideo(path.join(dir, `${title}.mp4`));
    writeNfo(path.join(dir, 'movie.nfo'), 'movie', { title, year, plot: title, genres: ['Action'] });
  }
  const showDir = path.join(server.mediaDir, 'shows', 'Party Show (2012)');
  writeNfo(path.join(showDir, 'tvshow.nfo'), 'tvshow', { title: 'Party Show', year: 2012, plot: 'Party time.' });
  makeVideo(path.join(showDir, 'Season 01', 'Party Show - S01E01 - Party.mp4'));

  const albumDir = path.join(server.mediaDir, 'music', 'Party Artist', 'Party Album (2013)');
  makeAudioTrack(path.join(albumDir, '01 - Party Track.mp3'), { title: 'Party Track', genre: 'Party', track: 1 });
  makeImage(path.join(server.mediaDir, 'photos', 'party.jpg'), '0x998877');

  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  showsLibrary = await createLibrary(admin, { name: 'Shows', kind: 'shows', path: path.join(server.mediaDir, 'shows') });
  musicLibrary = await createLibrary(admin, { name: 'Music', kind: 'music', path: path.join(server.mediaDir, 'music') });
  photosLibrary = await createLibrary(admin, { name: 'Photos', kind: 'photos', path: path.join(server.mediaDir, 'photos') });
  await scanLibrary(admin, moviesLibrary.id);
  await scanLibrary(admin, showsLibrary.id);
  await scanLibrary(admin, musicLibrary.id);
  await scanLibrary(admin, photosLibrary.id);

  const movies = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items?sort=title`);
  movieA = movies.json!.items.find((item) => item.title === 'Party Movie A')!.id;
  movieB = movies.json!.items.find((item) => item.title === 'Party Movie B')!.id;
  const shows = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${showsLibrary.id}/items`);
  showId = shows.json!.items[0].id;
  const showDetail = await admin.get<{ episodes: MediaItem[] }>(`/api/media/${showId}`);
  episodeId = showDetail.json!.episodes[0].id;
  const music = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items?kind=album`);
  const album = await admin.get<{ tracks: MediaItem[] }>(`/api/media/${music.json!.items[0].id}`);
  trackId = album.json!.tracks[0].id;
  const photos = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${photosLibrary.id}/items`);
  photoId = photos.json!.items[0].id;
});

after(async () => {
  await server.stop();
});

test('playlists validate creation shape and default visibility', async () => {
  const mixed = await user.post<Playlist>('/api/playlists', { name: 'Mixed Bag', description: 'A bit of everything.' });
  assert.equal(mixed.status, 201);
  assert.equal(mixed.json?.kind, 'mixed');
  assert.equal(mixed.json?.isPublic, true);
  assert.equal(mixed.json?.itemCount, 0);
  assert.equal(mixed.json?.durationSeconds, 0);
  assert.equal(mixed.json?.createdBy, 'playlist_user');

  const cases: { body: Record<string, unknown>; status: number }[] = [
    { body: {}, status: 400 },
    { body: { name: '' }, status: 400 },
    { body: { name: 'x'.repeat(121) }, status: 400 },
    { body: { name: 'Kindless', kind: 'podcast' }, status: 400 },
    { body: { name: 'Privacy', isPublic: 'yes' }, status: 400 },
    { body: { name: 'Long Description', description: 'x'.repeat(2001) }, status: 400 },
    { body: { name: 'Bad Description', description: 42 }, status: 400 },
  ];
  for (const entry of cases) {
    const response = await user.post('/api/playlists', entry.body);
    assert.equal(response.status, entry.status, `${JSON.stringify(entry.body)}: ${response.text}`);
  }

  const privateList = await user.post<Playlist>('/api/playlists', { name: 'Private Mix', isPublic: false });
  assert.equal(privateList.status, 201);
  assert.equal(privateList.json?.isPublic, false);
  const privateId = privateList.json!.id;

  const otherList = await other.get<PagedItems<Playlist>>('/api/playlists');
  assert.ok(!otherList.json!.items.some((playlist) => playlist.id === privateId));
  assert.equal((await other.get(`/api/playlists/${privateId}`)).status, 403);
  assert.equal((await admin.get(`/api/playlists/${privateId}`)).status, 200);
  assert.equal((await user.get(`/api/playlists/${privateId}`)).status, 200);
  const adminList = await admin.get<PagedItems<Playlist>>('/api/playlists');
  assert.ok(adminList.json!.items.some((playlist) => playlist.id === privateId));
});

test('playlists enforce item kinds, ids, ordering, and counts', async () => {
  const mixed = await user.post<Playlist>('/api/playlists', { name: 'Kinds Mixed' });
  const mixedId = mixed.json!.id;
  const add = await user.post<{ ok: boolean; added: number; itemCount: number }>(`/api/playlists/${mixedId}/items`, {
    mediaIds: [movieA, trackId],
  });
  assert.equal(add.status, 201);
  assert.equal(add.json?.added, 2);
  assert.equal(add.json?.itemCount, 2);
  const duplicate = await user.post<{ itemCount: number }>(`/api/playlists/${mixedId}/items`, { mediaIds: [movieA] });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.json?.itemCount, 2);

  const detail = await user.get<Playlist>(`/api/playlists/${mixedId}`);
  assert.equal(detail.json?.itemCount, 2);
  assert.ok((detail.json?.durationSeconds ?? 0) > 0);
  assert.deepEqual(detail.json!.items!.map((item) => item.id), [movieA, trackId]);

  const photoAdded = await user.post(`/api/playlists/${mixedId}/items`, { mediaIds: [photoId] });
  assert.equal(photoAdded.status, 400);
  const photoDetails = (photoAdded.json as ErrorBody).error.details as { incompatible?: { id: number; kind: string }[] };
  assert.equal(photoDetails.incompatible?.[0].id, photoId);
  assert.equal(photoDetails.incompatible?.[0].kind, 'photo');
  const missing = await user.post(`/api/playlists/${mixedId}/items`, { mediaIds: [99999] });
  assert.equal(missing.status, 400);
  assert.deepEqual((missing.json as ErrorBody).error.details as { missing?: number[] }, { missing: [99999] });

  const video = await user.post<Playlist>('/api/playlists', { name: 'Video Queue', kind: 'video' });
  const videoId = video.json!.id;
  assert.equal((await user.post(`/api/playlists/${videoId}/items`, { mediaIds: [movieA, episodeId] })).status, 201);
  const showAdded = await user.post(`/api/playlists/${videoId}/items`, { mediaIds: [showId] });
  assert.equal(showAdded.status, 400);
  assert.equal(((showAdded.json as ErrorBody).error.details as { incompatible?: { kind: string }[] }).incompatible?.[0].kind, 'show');
  assert.equal((await user.post(`/api/playlists/${videoId}/items`, { mediaIds: [trackId] })).status, 400);

  const audio = await user.post<Playlist>('/api/playlists', { name: 'Audio Queue', kind: 'audio' });
  const audioId = audio.json!.id;
  assert.equal((await user.post(`/api/playlists/${audioId}/items`, { mediaIds: [trackId] })).status, 201);
  assert.equal((await user.post(`/api/playlists/${audioId}/items`, { mediaIds: [movieA] })).status, 400);

  const photo = await user.post<Playlist>('/api/playlists', { name: 'Photo Queue', kind: 'photo' });
  const photoIdList = photo.json!.id;
  assert.equal((await user.post(`/api/playlists/${photoIdList}/items`, { mediaIds: [photoId] })).status, 201);
  assert.equal((await user.post(`/api/playlists/${photoIdList}/items`, { mediaIds: [movieA] })).status, 400);

  const reorder = await user.put<{ itemCount: number }>(`/api/playlists/${mixedId}/items`, { mediaIds: [trackId] });
  assert.equal(reorder.status, 200);
  assert.equal(reorder.json?.itemCount, 2);
  const reordered = await user.get<Playlist>(`/api/playlists/${mixedId}`);
  assert.deepEqual(reordered.json!.items!.map((item) => item.id), [trackId, movieA]);
  assert.equal((await user.put(`/api/playlists/${mixedId}/items`, { mediaIds: [99999] })).status, 400);

  const removed = await user.del(`/api/playlists/${mixedId}/items/${movieA}`);
  assert.equal(removed.status, 200);
  assert.equal((removed.json as { itemCount: number }).itemCount, 1);
  assert.equal((await user.del(`/api/playlists/${mixedId}/items/${movieA}`)).status, 404);

  // A mixed list with a track cannot silently become a video list.
  const badKind = await user.patch(`/api/playlists/${mixedId}`, { kind: 'video' });
  assert.equal(badKind.status, 400);
  assert.equal(((badKind.json as ErrorBody).error.details as { incompatible?: { id: number }[] }).incompatible?.[0].id, trackId);
  assert.equal((await user.patch(`/api/playlists/${mixedId}`, { kind: 'audio' })).status, 200);
});

test('playlists gate edits to owner/admin and hide private lists', async () => {
  const playlist = await user.post<Playlist>('/api/playlists', { name: 'Guarded Mix', isPublic: false });
  const id = playlist.json!.id;
  await user.post(`/api/playlists/${id}/items`, { mediaIds: [movieA] });

  assert.equal((await other.get(`/api/playlists/${id}`)).status, 403);
  assert.equal((await other.patch(`/api/playlists/${id}`, { name: 'Hijacked' })).status, 403);
  assert.equal((await other.del(`/api/playlists/${id}`)).status, 403);
  assert.equal((await other.post(`/api/playlists/${id}/items`, { mediaIds: [movieB] })).status, 403);

  const adminPatch = await admin.patch<Playlist>(`/api/playlists/${id}`, { description: 'Moderated.', isPublic: true });
  assert.equal(adminPatch.status, 200);
  assert.equal(adminPatch.json?.isPublic, true);
  assert.equal((await other.get(`/api/playlists/${id}`)).status, 200);

  assert.equal((await user.patch(`/api/playlists/${id}`, {})).status, 400);
  assert.equal((await user.get('/api/playlists/abc')).status, 400);
  assert.equal((await user.get('/api/playlists/99999')).status, 404);
  assert.equal((await user.get('/api/playlists?kind=podcast')).status, 400);

  const mine = await user.get<PagedItems<Playlist>>('/api/playlists?mine=1');
  assert.ok(mine.json!.items.every((item) => item.createdBy === 'playlist_user'));
  const audioOnly = await user.get<PagedItems<Playlist>>('/api/playlists?kind=audio');
  assert.ok(audioOnly.json!.items.every((item) => item.kind === 'audio'));

  const deleted = await admin.del(`/api/playlists/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await admin.get(`/api/playlists/${id}`)).status, 404);
});

test('duplicating a playlist copies items and ownership', async () => {
  const source = await user.post<Playlist>('/api/playlists', { name: 'Dupe Source' });
  const sourceId = source.json!.id;
  await user.post(`/api/playlists/${sourceId}/items`, { mediaIds: [movieA, movieB] });
  await user.put(`/api/playlists/${sourceId}/items`, { mediaIds: [movieB, movieA] });

  const copy = await user.post<Playlist>(`/api/playlists/${sourceId}/duplicate`, {});
  assert.equal(copy.status, 201);
  assert.equal(copy.json?.name, 'Dupe Source (copy)');
  assert.equal(copy.json?.itemCount, 2);
  assert.equal(copy.json?.createdBy, 'playlist_user');
  const copyDetail = await user.get<Playlist>(`/api/playlists/${copy.json!.id}`);
  assert.deepEqual(copyDetail.json!.items!.map((item) => item.id), [movieB, movieA]);

  const otherCopy = await other.post<Playlist>(`/api/playlists/${sourceId}/duplicate`, {});
  assert.equal(otherCopy.status, 201);
  assert.equal(otherCopy.json?.createdBy, 'playlist_other');
  assert.equal(otherCopy.json?.itemCount, 2);

  const privateSource = await user.post<Playlist>('/api/playlists', { name: 'Private Source', isPublic: false });
  assert.equal((await other.post(`/api/playlists/${privateSource.json!.id}/duplicate`, {})).status, 403);
  assert.equal((await other.post('/api/playlists/99999/duplicate', {})).status, 404);
});

test('party creation validates settings, host, name, and playable media', async () => {
  const disabled = await admin.patch('/api/admin/settings', { allowParties: false });
  assert.equal(disabled.status, 200);
  const blocked = await user.post('/api/parties', { name: 'Nope', mediaId: movieA });
  assert.equal(blocked.status, 403);
  assert.equal((blocked.json as ErrorBody).error.code, 'parties_disabled');
  assert.equal((await admin.patch('/api/admin/settings', { allowParties: true })).status, 200);

  const cases: { body: Record<string, unknown>; status: number; code?: string }[] = [
    { body: {}, status: 400 },
    { body: { name: '', mediaId: movieA }, status: 400 },
    { body: { name: 'x'.repeat(81), mediaId: movieA }, status: 400 },
    { body: { name: 'Missing media' }, status: 400 },
    { body: { name: 'Ghost media', mediaId: 99999 }, status: 404 },
    { body: { name: 'Show party', mediaId: showId }, status: 400 },
    { body: { name: 'Photo party', mediaId: photoId }, status: 400 },
  ];
  for (const entry of cases) {
    const response = await user.post('/api/parties', entry.body);
    assert.equal(response.status, entry.status, `${JSON.stringify(entry.body)}: ${response.text}`);
  }

  const created = await user.post<Party>('/api/parties', { name: 'Slop Watch Party', mediaId: movieA });
  assert.equal(created.status, 201);
  assert.equal(created.json?.name, 'Slop Watch Party');
  assert.equal(created.json?.mediaId, movieA);
  assert.equal(created.json?.media?.id, movieA);
  assert.equal(created.json?.position, 0);
  assert.equal(created.json?.paused, true);
  assert.equal(created.json?.isActive, true);
  assert.equal(created.json?.memberCount, 1);
  assert.equal(created.json?.isHost, true);
  assert.equal(created.json?.host?.username, 'playlist_user');
  assert.equal(created.json?.members.length, 1);
  assert.equal(created.json?.members[0].isHost, true);
  assert.match(created.json?.id ?? '', /^[0-9a-f-]{36}$/);
});

test('party members join idempotently, sync state, and respect host-only control', async () => {
  const created = await user.post<Party>('/api/parties', { name: 'Sync Party', mediaId: movieB });
  const id = created.json!.id;

  const joined = await other.post<{ ok: boolean; joined: boolean; memberCount: number }>(`/api/parties/${id}/join`, {});
  assert.equal(joined.status, 200);
  assert.equal(joined.json?.joined, true);
  assert.equal(joined.json?.memberCount, 2);
  const again = await other.post<{ memberCount: number }>(`/api/parties/${id}/join`, {});
  assert.equal(again.json?.memberCount, 2);
  const third = await manager.post<{ memberCount: number }>(`/api/parties/${id}/join`, {});
  assert.equal(third.json?.memberCount, 3);
  const fourth = await admin.post<{ memberCount: number }>(`/api/parties/${id}/join`, {});
  assert.equal(fourth.json?.memberCount, 4);

  const asOther = await other.get<Party>(`/api/parties/${id}`);
  assert.equal(asOther.status, 200);
  assert.equal(asOther.json?.isHost, false);
  assert.equal(asOther.json?.memberCount, 4);
  assert.equal(asOther.json?.members.filter((member) => member.isHost).length, 1);
  assert.equal(asOther.json?.members.find((member) => member.isHost)?.username, 'playlist_user');
  assert.ok(asOther.json!.members.every((member) => typeof member.joinedAt === 'string'));

  assert.equal((await other.post(`/api/parties/${id}/state`, { position: 1 })).status, 403);
  assert.equal((await manager.post(`/api/parties/${id}/state`, { paused: false })).status, 403);

  const invalidStates: Record<string, unknown>[] = [
    {},
    { position: -1 },
    { position: 'soon' },
    { position: 60 * 60 * 24 + 1 },
    { paused: 'no' },
  ];
  for (const body of invalidStates) {
    const response = await user.post(`/api/parties/${id}/state`, body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
  }

  const synced = await user.post<Party>(`/api/parties/${id}/state`, { position: 1.5, paused: false });
  assert.equal(synced.status, 200);
  assert.equal(synced.json?.position, 1.5);
  assert.equal(synced.json?.paused, false);
  assert.equal(synced.json?.isHost, true);
  const persisted = await other.get<Party>(`/api/parties/${id}`);
  assert.equal(persisted.json?.position, 1.5);
  assert.equal(persisted.json?.paused, false);

  // Position is clamped to the media runtime.
  const clamped = await user.post<Party>(`/api/parties/${id}/state`, { position: 5000 });
  assert.ok((clamped.json?.position ?? 0) <= 2.5);
});

test('party listing filters, non-host deletes, and ending a party close joins', async () => {
  const party = await user.post<Party>('/api/parties', { name: 'Closing Party', mediaId: movieA });
  const id = party.json!.id;
  await other.post(`/api/parties/${id}/join`, {});

  const list = await other.get<PagedItems<Party>>('/api/parties');
  assert.equal(list.status, 200);
  assert.ok(list.json!.items.some((entry) => entry.id === id));
  assert.equal(list.json!.items.find((entry) => entry.id === id)?.memberCount, 2);
  const filtered = await other.get<PagedItems<Party>>(`/api/parties?mediaId=${movieA}`);
  assert.ok(filtered.json!.items.every((entry) => entry.mediaId === movieA));
  assert.ok(filtered.json!.items.some((entry) => entry.id === id));
  assert.equal((await other.get('/api/parties?mediaId=-1')).status, 400);
  assert.equal((await other.get('/api/parties/bad@id')).status, 400);
  assert.equal((await other.get('/api/parties/does-not-exist')).status, 404);

  assert.equal((await other.del(`/api/parties/${id}`)).status, 403);
  assert.equal((await user.post(`/api/parties/${id}/state`, {})).status, 400);
  const ended = await admin.del<{ ok: boolean; ended: boolean }>(`/api/parties/${id}`);
  assert.equal(ended.status, 200);
  assert.equal(ended.json?.ended, true);
  const inactive = await other.get<Party>(`/api/parties/${id}`);
  assert.equal(inactive.json?.isActive, false);
  assert.equal((await other.post(`/api/parties/${id}/join`, {})).status, 409);
  assert.equal((await user.post(`/api/parties/${id}/state`, { paused: true })).status, 409);
  const activeList = await other.get<PagedItems<Party>>('/api/parties');
  assert.ok(!activeList.json!.items.some((entry) => entry.id === id));
});

test('leaving a party updates membership and the host leaving ends it', async () => {
  const party = await user.post<Party>('/api/parties', { name: 'Leaving Party', mediaId: movieA });
  const id = party.json!.id;
  await other.post(`/api/parties/${id}/join`, {});
  await manager.post(`/api/parties/${id}/join`, {});

  const left = await other.post<{ left: boolean; ended: boolean; memberCount: number }>(`/api/parties/${id}/leave`, {});
  assert.equal(left.status, 200);
  assert.equal(left.json?.left, true);
  assert.equal(left.json?.ended, false);
  assert.equal(left.json?.memberCount, 2);
  assert.equal((await other.post(`/api/parties/${id}/leave`, {})).status, 400);

  const hostLeft = await user.post<{ ended: boolean; memberCount: number }>(`/api/parties/${id}/leave`, {});
  assert.equal(hostLeft.status, 200);
  assert.equal(hostLeft.json?.ended, true);
  assert.equal(hostLeft.json?.memberCount, 1);
  const endedParty = await manager.get<Party>(`/api/parties/${id}`);
  assert.equal(endedParty.json?.isActive, false);
  assert.equal((await manager.post(`/api/parties/${id}/join`, {})).status, 409);
});

