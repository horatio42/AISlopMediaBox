import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminClient,
  assert,
  createLibrary,
  makeAudioTrack,
  makeImage,
  newUserClient,
  scanLibrary,
  startServer,
} from './helpers.ts';
import type { Client, Job, Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MediaItem {
  id: number;
  libraryId: number;
  kind: string;
  title: string;
  year: number | null;
  albumId?: number | null;
  artistId?: number | null;
  trackNumber?: number | null;
  runtimeSeconds?: number | null;
  art: Record<string, string>;
  albumName?: string | null;
  artistName?: string | null;
  trackCount?: number;
  albumCount?: number;
  durationSeconds?: number;
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface MusicOverview {
  recentTracks: MediaItem[];
  recentlyPlayed: MediaItem[];
  recentlyAdded: { tracks: MediaItem[]; albums: MediaItem[]; artists: MediaItem[] };
  artists: MediaItem[];
  albums: MediaItem[];
  playlists: unknown[];
  genres: { genre: string; count: number }[];
  stats: { tracks: number; albums: number; artists: number; playlists: number; totalDurationSeconds: number; totalBytes: number; genres: number };
}

interface TrackDetail {
  item: MediaItem;
  album: MediaItem | null;
  artist: MediaItem | null;
}

interface AlbumDetail {
  item: MediaItem;
  artist: MediaItem | null;
  tracks: MediaItem[];
  trackCount: number;
}

interface ArtistDetail {
  item: MediaItem;
  albums: MediaItem[];
  topTracks: MediaItem[];
}

interface PhotoItem extends MediaItem {
  captureDate: string;
  folder: string;
  encodedFolderPath: string;
  filename: string;
  libraryName: string;
}

interface TimelineBody {
  groups: { key: string; month: number; year: number; label: string; count: number; cover: PhotoItem }[];
  total: number;
}

interface FoldersBody {
  folders: { path: string; name: string; encodedPath: string; libraryId: number; count: number; cover: PhotoItem }[];
  total: number;
}

interface PhotoDetail {
  item: PhotoItem;
  prevId: number | null;
  nextId: number | null;
  captureDate: string;
  folder: string;
  filename: string;
}

let server: StartedServer;
let admin: Client;
let user: Client;
let musicLibrary: Library;
let photosLibrary: Library;
let photosRoot: string;

let artistA: number;
let artistB: number;
let albumPeak: number;
let albumLater: number;
let albumOther: number;
let tracks: MediaItem[] = [];
let photos: PhotoItem[] = [];
const diskFileByPhotoId = new Map<number, string>();

const photoFixtures: { rel: string; color: string }[] = [
  { rel: 'root-photo.jpg', color: '0x101010' },
  { rel: 'Trip/beach.jpg', color: '0x112233' },
  { rel: 'Trip/sunset.jpg', color: '0x332211' },
  { rel: 'Trip/Day2/mountain.jpg', color: '0x445566' },
];

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  user = await newUserClient(server, admin, 'music_user', 'user');

  const musicRoot = path.join(server.mediaDir, 'music');
  const peakDir = path.join(musicRoot, 'Slop Artist', 'Peak Album (1999)');
  makeImage(path.join(musicRoot, 'Slop Artist', 'folder.jpg'), '0x123456');
  makeImage(path.join(peakDir, 'cover.jpg'), '0x654321');
  makeAudioTrack(path.join(peakDir, '01 - Opening Slop.mp3'), { title: 'Opening Slop', genre: 'Slopcore', track: 1 });
  makeAudioTrack(path.join(peakDir, '02 - Closing Slop.mp3'), { title: 'Closing Slop', genre: 'Slopcore', track: 2 });
  const laterDir = path.join(musicRoot, 'Slop Artist', 'Later Slop (2010)');
  makeImage(path.join(laterDir, 'cover.jpg'), '0x222222');
  makeAudioTrack(path.join(laterDir, '01 - Late Slop.mp3'), { title: 'Late Slop', genre: 'Chill', track: 1 });
  const otherDir = path.join(musicRoot, 'Second Artist', 'Other Album (2005)');
  makeImage(path.join(otherDir, 'cover.jpg'), '0x333333');
  makeAudioTrack(path.join(otherDir, '01 - Other Track.mp3'), { title: 'Other Track', genre: 'Slopcore', track: 1 });

  photosRoot = path.join(server.mediaDir, 'photos');
  for (const fixture of photoFixtures) makeImage(path.join(photosRoot, fixture.rel), fixture.color, '40x30');

  musicLibrary = await createLibrary(admin, { name: 'Music', kind: 'music', path: musicRoot });
  photosLibrary = await createLibrary(admin, { name: 'Photos', kind: 'photos', path: photosRoot });

  const musicJob = await scanLibrary(admin, musicLibrary.id);
  assert.deepEqual(musicJob.scan.counts, { artist: 2, album: 3, track: 4 });
  const photoJob = await scanLibrary(admin, photosLibrary.id);
  assert.deepEqual(photoJob.scan.counts, { photo: 4 });

  const musicItems = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items`);
  const byTitle = new Map(musicItems.json!.items.map((item) => [item.title, item]));
  artistA = byTitle.get('Slop Artist')!.id;
  artistB = byTitle.get('Second Artist')!.id;
  albumPeak = byTitle.get('Peak Album')!.id;
  albumLater = byTitle.get('Later Slop')!.id;
  albumOther = byTitle.get('Other Album')!.id;
  assert.ok(artistA && artistB && albumPeak && albumLater && albumOther);

  tracks = (await admin.get<PagedItems<MediaItem>>('/api/music/tracks?sort=title&pageSize=100')).json!.items;
  assert.equal(tracks.length, 4);
  assert.deepEqual(tracks.map((track) => track.title), ['Closing Slop', 'Late Slop', 'Opening Slop', 'Other Track']);

  photos = (await admin.get<PagedItems<PhotoItem>>('/api/photos?pageSize=100')).json!.items;
  assert.equal(photos.length, 4);
  for (const photo of photos) {
    const fixture = photoFixtures.find((entry) => path.basename(entry.rel) === photo.filename);
    assert.ok(fixture, `no fixture for ${photo.filename}`);
    diskFileByPhotoId.set(photo.id, path.join(photosRoot, fixture.rel));
  }
});

after(async () => {
  await server.stop();
});

test('music and photos return honest empty states before any scan', async () => {
  // A separate pristine instance proves empty responses are real, not just pre-scan luck.
  const emptyServer = await startServer();
  try {
    const emptyAdmin = await adminClient(emptyServer);
    const music = await emptyAdmin.get<MusicOverview>('/api/music');
    assert.equal(music.status, 200);
    assert.deepEqual(music.json?.recentTracks, []);
    assert.deepEqual(music.json?.recentlyPlayed, []);
    assert.deepEqual(music.json?.artists, []);
    assert.deepEqual(music.json?.albums, []);
    assert.deepEqual(music.json?.genres, []);
    assert.deepEqual(music.json?.recentlyAdded, { tracks: [], albums: [], artists: [] });
    assert.deepEqual(music.json?.stats, {
      tracks: 0,
      albums: 0,
      artists: 0,
      playlists: 0,
      totalDurationSeconds: 0,
      totalBytes: 0,
      genres: 0,
    });

    for (const pathname of ['/api/music/artists', '/api/music/albums', '/api/music/tracks']) {
      const response = await emptyAdmin.get<PagedItems<MediaItem>>(pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.json?.total, 0, pathname);
      assert.deepEqual(response.json?.items, [], pathname);
    }
    const recent = await emptyAdmin.get<{ items: MediaItem[]; total: number }>('/api/music/recently-played');
    assert.deepEqual(recent.json?.items, []);
    assert.equal(recent.json?.total, 0);
    const genres = await emptyAdmin.get<{ genres: { genre: string; count: number; trackCount: number }[]; total: number }>('/api/music/genres');
    assert.deepEqual(genres.json?.genres, []);
    assert.equal(genres.json?.total, 0);

    const photos = await emptyAdmin.get<PagedItems<PhotoItem>>('/api/photos');
    assert.equal(photos.status, 200);
    assert.equal(photos.json?.total, 0);
    assert.deepEqual(photos.json?.items, []);
    const timeline = await emptyAdmin.get<TimelineBody>('/api/photos/timeline');
    assert.deepEqual(timeline.json?.groups, []);
    assert.equal(timeline.json?.total, 0);
    const folders = await emptyAdmin.get<FoldersBody>('/api/photos/folders');
    assert.deepEqual(folders.json?.folders, []);
    assert.equal(folders.json?.total, 0);
    assert.equal((await emptyAdmin.get('/api/photos/1')).status, 404);
  } finally {
    await emptyServer.stop();
  }
});

test('music overview decorates artists, albums, tracks, genres, and stats', async () => {
  const overview = await user.get<MusicOverview>('/api/music');
  assert.equal(overview.status, 200);
  assert.equal(overview.json?.stats.tracks, 4);
  assert.equal(overview.json?.stats.albums, 3);
  assert.equal(overview.json?.stats.artists, 2);
  assert.equal(overview.json?.stats.playlists, 0);
  assert.ok((overview.json?.stats.totalDurationSeconds ?? 0) > 0);
  assert.ok((overview.json?.stats.totalBytes ?? 0) > 0);
  assert.equal(overview.json?.stats.genres, 2);
  assert.equal(overview.json?.recentTracks.length, 4);
  assert.equal(overview.json?.recentlyAdded.tracks.length, 4);
  assert.equal(overview.json?.recentlyAdded.albums.length, 3);
  assert.equal(overview.json?.recentlyAdded.artists.length, 2);
  assert.deepEqual(overview.json!.genres.map((entry) => entry.genre).sort(), ['Chill', 'Slopcore']);
  assert.deepEqual(overview.json!.playlists, []);

  const artistAOverview = overview.json!.artists.find((artist) => artist.id === artistA)!;
  assert.equal(artistAOverview.title, 'Slop Artist');
  assert.equal(artistAOverview.albumCount, 2);
  assert.equal(artistAOverview.trackCount, 3);
  assert.ok((artistAOverview.durationSeconds ?? 0) > 0);
  const artistBOverview = overview.json!.artists.find((artist) => artist.id === artistB)!;
  assert.equal(artistBOverview.albumCount, 1);
  assert.equal(artistBOverview.trackCount, 1);

  const peak = overview.json!.albums.find((album) => album.id === albumPeak)!;
  assert.equal(peak.artistName, 'Slop Artist');
  assert.ok(peak.art.poster);
  const track = overview.json!.recentTracks.find((entry) => entry.title === 'Opening Slop')!;
  assert.equal(track.albumName, 'Peak Album');
  assert.equal(track.artistName, 'Slop Artist');
});

test('artist listing, search, pagination, and detail are consistent', async () => {
  const artists = await user.get<PagedItems<MediaItem>>('/api/music/artists');
  assert.equal(artists.status, 200);
  assert.equal(artists.json?.total, 2);
  assert.deepEqual(artists.json!.items.map((artist) => artist.title), ['Second Artist', 'Slop Artist']);
  const filtered = await user.get<PagedItems<MediaItem>>('/api/music/artists?q=second');
  assert.deepEqual(filtered.json!.items.map((artist) => artist.title), ['Second Artist']);
  const paged = await user.get<PagedItems<MediaItem>>('/api/music/artists?pageSize=1&page=2');
  assert.equal(paged.json?.items.length, 1);
  assert.equal((await user.get('/api/music/artists?sort=nope')).status, 400);

  const detail = await user.get<ArtistDetail>(`/api/music/artists/${artistA}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json?.item.title, 'Slop Artist');
  assert.deepEqual(detail.json!.albums.map((album) => album.title), ['Peak Album', 'Later Slop']);
  assert.deepEqual(detail.json!.topTracks.map((track) => track.title).sort(), ['Closing Slop', 'Late Slop', 'Opening Slop']);
  assert.equal(detail.json?.item.albumCount, 2);
  assert.equal(detail.json?.item.trackCount, 3);

  const second = await user.get<ArtistDetail>(`/api/music/artists/${artistB}`);
  assert.equal(second.json?.albums.length, 1);
  assert.equal(second.json?.topTracks.length, 1);

  assert.equal((await user.get('/api/music/artists/abc')).status, 400);
  assert.equal((await user.get('/api/music/artists/99999')).status, 404);
  assert.equal((await user.get(`/api/music/artists/${photos[0].id}`)).status, 404);
});

test('album listing filters/sorts and album detail exposes ordered tracks and art', async () => {
  const albums = await user.get<PagedItems<MediaItem>>('/api/music/albums');
  assert.equal(albums.json?.total, 3);
  assert.deepEqual(albums.json!.items.map((album) => album.title), ['Later Slop', 'Other Album', 'Peak Album']);
  const byArtist = await user.get<PagedItems<MediaItem>>(`/api/music/albums?artistId=${artistA}`);
  assert.deepEqual(byArtist.json!.items.map((album) => album.title).sort(), ['Later Slop', 'Peak Album']);
  const search = await user.get<PagedItems<MediaItem>>('/api/music/albums?q=Other');
  assert.deepEqual(search.json!.items.map((album) => album.title), ['Other Album']);
  assert.equal((await user.get('/api/music/albums?artistId=0')).status, 400);
  assert.equal((await user.get('/api/music/albums?sort=bad')).status, 400);

  const detail = await user.get<AlbumDetail>(`/api/music/albums/${albumPeak}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json?.trackCount, 2);
  assert.deepEqual(detail.json!.tracks.map((track) => track.title), ['Opening Slop', 'Closing Slop']);
  assert.deepEqual(detail.json!.tracks.map((track) => track.trackNumber), [1, 2]);
  assert.equal(detail.json?.artist?.id, artistA);
  assert.equal(detail.json?.item.artistName, 'Slop Artist');
  assert.match(detail.json?.item.art.poster ?? '', new RegExp(`^/api/art/${albumPeak}/poster`));

  const manifest = await user.get<{ items: { kind: string; source: string }[] }>(`/api/art/${albumPeak}`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json!.items.find((entry) => entry.kind === 'poster')?.source, 'sidecar');

  assert.equal((await user.get(`/api/music/albums/${tracks[0].id}`)).status, 404);
  assert.equal((await user.get('/api/music/albums/99999')).status, 404);
});

test('track listing supports filters, sorts, pagination, and detail context', async () => {
  const all = await user.get<PagedItems<MediaItem>>('/api/music/tracks');
  assert.equal(all.json?.total, 4);
  const slop = await user.get<PagedItems<MediaItem>>('/api/music/tracks?q=Slop');
  assert.equal(slop.json?.total, 3);
  const chill = await user.get<PagedItems<MediaItem>>('/api/music/tracks?genre=Chill');
  assert.deepEqual(chill.json!.items.map((track) => track.title), ['Late Slop']);
  const peakTracks = await user.get<PagedItems<MediaItem>>(`/api/music/tracks?albumId=${albumPeak}&sort=track`);
  assert.deepEqual(peakTracks.json!.items.map((track) => track.title), ['Opening Slop', 'Closing Slop']);
  const secondTracks = await user.get<PagedItems<MediaItem>>(`/api/music/tracks?artistId=${artistB}`);
  assert.deepEqual(secondTracks.json!.items.map((track) => track.title), ['Other Track']);
  assert.equal((await user.get('/api/music/tracks?albumId=0')).status, 400);
  assert.equal((await user.get('/api/music/tracks?artistId=abc')).status, 400);
  assert.equal((await user.get('/api/music/tracks?sort=bad')).status, 400);
  const paged = await user.get<PagedItems<MediaItem>>('/api/music/tracks?pageSize=2&page=2');
  assert.equal(paged.json?.items.length, 2);
  assert.equal(paged.json?.pageSize, 2);

  const track = await user.get<TrackDetail>(`/api/music/tracks/${tracks[0].id}`);
  assert.equal(track.status, 200);
  assert.equal(track.json?.item.title, 'Closing Slop');
  assert.equal(track.json?.item.albumName, 'Peak Album');
  assert.equal(track.json?.item.artistName, 'Slop Artist');
  assert.equal(track.json?.album?.id, albumPeak);
  assert.equal(track.json?.artist?.id, artistA);
  assert.equal((await user.get(`/api/music/tracks/${photos[0].id}`)).status, 404);
  assert.equal((await user.get('/api/music/tracks/abc')).status, 400);
});

test('recently-played is driven by real user progress and clamps limits', async () => {
  const initial = await user.get<{ items: MediaItem[]; total: number }>('/api/music/recently-played');
  assert.deepEqual(initial.json?.items, []);
  assert.equal(initial.json?.total, 0);

  const opening = tracks.find((track) => track.title === 'Opening Slop')!;
  const closing = tracks.find((track) => track.title === 'Closing Slop')!;
  assert.equal((await user.put(`/api/progress/${opening.id}`, { positionSeconds: 30, durationSeconds: 60 })).status, 200);
  const one = await user.get<{ items: MediaItem[]; total: number; limit: number }>('/api/music/recently-played');
  assert.equal(one.json?.total, 1);
  assert.equal(one.json?.items[0].id, opening.id);
  assert.equal(one.json?.items[0].albumName, 'Peak Album');

  assert.equal((await user.put(`/api/progress/${closing.id}`, { positionSeconds: 10, durationSeconds: 60 })).status, 200);
  const two = await user.get<{ items: MediaItem[]; total: number }>('/api/music/recently-played');
  assert.equal(two.json?.total, 2);
  assert.equal(two.json?.items[0].id, closing.id);
  assert.equal(two.json?.items[1].id, opening.id);

  const tiny = await user.get<{ items: MediaItem[]; limit: number }>('/api/music/recently-played?limit=0');
  assert.equal(tiny.json?.limit, 1);
  assert.equal(tiny.json?.items.length, 1);
  const huge = await user.get<{ limit: number }>('/api/music/recently-played?limit=1000');
  assert.equal(huge.json?.limit, 100);
  assert.equal((await user.get<{ items: MediaItem[]; limit: number }>('/api/music/recently-played?limit=abc')).json?.limit, 20);

  const overview = await user.get<MusicOverview>('/api/music');
  assert.equal(overview.json?.recentlyPlayed.length, 2);
  assert.equal(overview.json?.recentlyPlayed[0].id, closing.id);
  const other = await newUserClient(server, admin, 'music_other', 'user');
  assert.equal((await other.get<{ items: MediaItem[] }>('/api/music/recently-played')).json?.items.length, 0);
});

test('music genres count tracks and respect casing', async () => {
  const response = await user.get<{ genres: { genre: string; count: number; trackCount: number }[]; total: number }>('/api/music/genres');
  assert.equal(response.status, 200);
  assert.equal(response.json?.total, 2);
  assert.deepEqual(response.json!.genres, [
    { genre: 'Slopcore', count: 3, trackCount: 3 },
    { genre: 'Chill', count: 1, trackCount: 1 },
  ]);
  const caseFilter = await user.get<PagedItems<MediaItem>>('/api/music/tracks?genre=slopCORE');
  assert.equal(caseFilter.json?.total, 3);
});

  test('photos list filters by folder, library, text, and dates', async () => {
    const all = await user.get<PagedItems<PhotoItem>>('/api/photos');
    assert.equal(all.status, 200);
    assert.equal(all.json?.total, 4);
    assert.equal(all.json?.items.length, 4);
    for (const photo of all.json!.items) {
      assert.match(photo.captureDate, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(photo.filename.length > 0);
      assert.equal(photo.libraryName, 'Photos');
      assert.match(photo.art.thumb ?? '', new RegExp(`^/api/art/${photo.id}/thumb`));
      assert.equal(photo.libraryId !== undefined, true);
    }

    const byTitle = await user.get<PagedItems<PhotoItem>>('/api/photos?sort=title&order=asc');
    assert.deepEqual(byTitle.json!.items.map((photo) => photo.title), ['Beach', 'Mountain', 'Root-Photo', 'Sunset']);
    const descTitle = await user.get<PagedItems<PhotoItem>>('/api/photos?sort=title');
    assert.deepEqual(descTitle.json!.items.map((photo) => photo.title), ['Sunset', 'Root-Photo', 'Mountain', 'Beach']);
    const paged = await user.get<PagedItems<PhotoItem>>('/api/photos?sort=title&order=asc&pageSize=2&page=2');
    assert.equal(paged.json?.items.length, 2);
    assert.equal(paged.json?.total, 4);
    const clamped = await user.get<PagedItems<PhotoItem>>('/api/photos?pageSize=9999');
    assert.equal(clamped.json?.pageSize, 300);

    const byLibrary = await user.get<PagedItems<PhotoItem>>(`/api/photos?libraryId=${photosLibrary.id}`);
    assert.equal(byLibrary.json?.total, 4);
    assert.equal((await user.get<PagedItems<PhotoItem>>('/api/photos?libraryId=9999')).json?.total, 0);
    assert.equal((await user.get('/api/photos?libraryId=0')).status, 400);
    const search = await user.get<PagedItems<PhotoItem>>('/api/photos?q=Sunset');
    assert.deepEqual(search.json!.items.map((photo) => photo.title), ['Sunset']);

    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await user.get<PagedItems<PhotoItem>>(`/api/photos?from=${today}&to=${today}`)).json?.total, 4);
    assert.equal((await user.get<PagedItems<PhotoItem>>('/api/photos?from=not-a-date')).status, 400);
    assert.equal((await user.get<PagedItems<PhotoItem>>('/api/photos?from=2026-10-30&to=2026-10-01')).status, 400);
    assert.equal((await user.get('/api/photos?sort=bad')).status, 400);
    assert.equal((await user.get('/api/photos?order=sideways')).status, 400);

    const trip = await user.get<PagedItems<PhotoItem>>('/api/photos?folder=Trip');
    assert.equal(trip.json?.total, 2);
    assert.deepEqual(trip.json!.items.map((photo) => photo.folder), ['Trip', 'Trip']);
    const rootFolder = await user.get<PagedItems<PhotoItem>>('/api/photos?folder=');
    assert.equal(rootFolder.json?.total, 1);
    assert.equal(rootFolder.json!.items[0].filename, 'root-photo.jpg');
    assert.equal((await user.get<PagedItems<PhotoItem>>('/api/photos?folder=Trip%2FDay2')).json?.total, 1);
    assert.equal((await user.get('/api/photos?folder=..%2Fescape')).status, 400);
    assert.equal((await user.get('/api/photos?folder=%2Fetc')).status, 400);
  });

  test('photo timeline groups real months with counts and covers', async () => {
    const timeline = await user.get<TimelineBody>('/api/photos/timeline');
    assert.equal(timeline.status, 200);
    assert.equal(timeline.json?.total, 4);
    assert.equal(timeline.json?.groups.length, 1);
    const group = timeline.json!.groups[0];
    const key = new Date().toISOString().slice(0, 7);
    assert.equal(group.key, key);
    assert.equal(group.count, 4);
    assert.ok(group.month >= 1 && group.month <= 12);
    assert.ok(group.year >= 2026);
    assert.match(group.label, new RegExp(String(group.year)));
    assert.ok(photos.some((photo) => photo.id === group.cover.id));
    assert.equal(group.cover.folder, photos.find((photo) => photo.id === group.cover.id)?.folder);
  });

  test('photo folders group by relative path and reject traversal', async () => {
    const folders = await user.get<FoldersBody>('/api/photos/folders');
    assert.equal(folders.status, 200);
    assert.equal(folders.json?.total, 3);
    const byPath = new Map(folders.json!.folders.map((folder) => [folder.path, folder]));
    assert.equal(byPath.get('')?.count, 1);
    assert.equal(byPath.get('')?.name, 'Photos');
    assert.equal(byPath.get('')?.encodedPath, '');
    assert.equal(byPath.get('Trip')?.count, 2);
    assert.equal(byPath.get('Trip')?.name, 'Trip');
    assert.equal(byPath.get('Trip/Day2')?.count, 1);
    assert.equal(byPath.get('Trip/Day2')?.encodedPath, 'Trip%2FDay2');
    for (const folder of folders.json!.folders) {
      assert.equal(folder.libraryId, photosLibrary.id);
      assert.ok(photos.some((photo) => photo.id === folder.cover.id));
    }

    const trip = await user.get<PagedItems<PhotoItem> & { folder: { path: string; name: string; count: number } }>(
      '/api/photos/folders/Trip/items',
    );
    assert.equal(trip.status, 200);
    assert.equal(trip.json?.total, 2);
    assert.equal(trip.json?.folder.path, 'Trip');
    assert.equal(trip.json?.folder.name, 'Trip');
    assert.equal(trip.json?.folder.count, 2);
    assert.ok(trip.json!.items.every((photo) => photo.folder === 'Trip'));
    const secondPage = await user.get<PagedItems<PhotoItem>>('/api/photos/folders/Trip/items?pageSize=1&page=2');
    assert.equal(secondPage.json?.items.length, 1);

    const root = await user.get<PagedItems<PhotoItem>>('/api/photos/folders/root/items');
    assert.equal(root.json?.total, 1);
    assert.equal(root.json!.items[0].folder, '');
    const dayTwo = await user.get<PagedItems<PhotoItem>>('/api/photos/folders/items?path=Trip%2FDay2');
    assert.equal(dayTwo.json?.total, 1);
    assert.equal((await user.get('/api/photos/folders/items')).status, 400);
    assert.equal((await user.get('/api/photos/folders/items?path=../escape')).status, 400);
    assert.equal((await user.get('/api/photos/folders/Nope/items')).status, 404);
  });

  test('photo detail exposes metadata and a complete neighbour chain', async () => {
    const details: PhotoDetail[] = [];
    for (const photo of photos) details.push((await user.get<PhotoDetail>(`/api/photos/${photo.id}`)).json!);
    assert.equal(details.length, 4);
    for (const detail of details) {
      assert.equal(detail.item.kind, 'photo');
      assert.equal(detail.filename, detail.item.filename);
      assert.match(detail.captureDate, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(detail.item.folder === '' || !detail.item.folder.startsWith('/'));
    }
    const heads = details.filter((detail) => detail.prevId === null);
    assert.equal(heads.length, 1);
    const visited = new Set<number>();
    let cursor: PhotoDetail | undefined = heads[0];
    while (cursor) {
      assert.ok(!visited.has(cursor.item.id), 'neighbour chain must not loop');
      visited.add(cursor.item.id);
      cursor = cursor.nextId === null ? undefined : details.find((detail) => detail.item.id === cursor!.nextId);
    }
    assert.equal(visited.size, 4);
    const tails = details.filter((detail) => detail.nextId === null);
    assert.equal(tails.length, 1);

    assert.equal((await user.get(`/api/photos/${tracks[0].id}`)).status, 404);
    assert.equal((await user.get('/api/photos/abc')).status, 400);
    assert.equal((await user.get('/api/photos/99999')).status, 404);
  });

  test('photo file serving supports MIME, Range, HEAD, ETag, download, and missing files', async () => {
    const beach = photos.find((photo) => photo.filename === 'beach.jpg')!;
    const diskPath = diskFileByPhotoId.get(beach.id)!;
    const disk = fs.readFileSync(diskPath);

    const file = await user.get(`/api/photos/${beach.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.contentType, 'image/jpeg');
    assert.equal(file.headers.get('accept-ranges'), 'bytes');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('cache-control') ?? '', /private, max-age=604800/);
    assert.match(file.headers.get('etag') ?? '', /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.match(file.headers.get('content-disposition') ?? '', /^inline; filename="beach\.jpg"/);
    assert.deepEqual(file.body, disk);
    assert.equal(file.headers.get('content-length'), String(disk.length));

    const ranged = await user.get(`/api/photos/${beach.id}/file`, { headers: { Range: 'bytes=0-7' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${disk.length}`);
    assert.deepEqual(ranged.body, disk.subarray(0, 8));
    const suffix = await user.get(`/api/photos/${beach.id}/file`, { headers: { Range: 'bytes=-8' } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), `bytes ${disk.length - 8}-${disk.length - 1}/${disk.length}`);
    assert.deepEqual(suffix.body, disk.subarray(disk.length - 8));
    const invalid = await user.get(`/api/photos/${beach.id}/file`, { headers: { Range: 'bytes=999999999-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${disk.length}`);

    const head = await user.head(`/api/photos/${beach.id}/file`);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(disk.length));
    assert.equal(head.body.length, 0);
    const cached = await user.get(`/api/photos/${beach.id}/file`, { headers: { 'If-None-Match': file.headers.get('etag') ?? '' } });
    assert.equal(cached.status, 304);
    const download = await user.get(`/api/photos/${beach.id}/file?download=1`);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="beach\.jpg"; filename\*=UTF-8''beach\.jpg/);

    const mountain = photos.find((photo) => photo.filename === 'mountain.jpg')!;
    fs.unlinkSync(diskFileByPhotoId.get(mountain.id)!);
    const missing = await user.get(`/api/photos/${mountain.id}/file`);
    assert.equal(missing.status, 404);
    assert.equal((missing.json as ErrorBody).error.code, 'not_found');
    assert.equal((await user.get(`/api/photos/${mountain.id}`)).status, 200);
    assert.equal((await user.get<PagedItems<PhotoItem>>('/api/photos')).json?.total, 4);

    assert.equal((await user.get(`/api/photos/${tracks[0].id}/file`)).status, 404);
    assert.equal((await user.get('/api/photos/abc/file')).status, 400);
    assert.equal((await user.get('/api/photos/99999/file')).status, 404);
  });
