import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminClient,
  assert,
  Client,
  createLibrary,
  makeAudioTrack,
  makeImage,
  makeVideo,
  newUserClient,
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
  sortTitle: string;
  year: number | null;
  rating: number | null;
  contentRating: string | null;
  description: string;
  genres: string[];
  people?: { name: string; role: string; character: string | null }[];
  libraryId: number;
  libraryName?: string;
  favorite?: boolean;
  watched?: boolean;
  userRating?: number | null;
  progress?: { positionSeconds: number; finished: boolean; playCount: number } | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  trackNumber?: number | null;
  albumId?: number | null;
  artistId?: number | null;
  parentId?: number | null;
  metadataLocked?: boolean;
  playable: boolean;
  art: Record<string, string>;
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface MediaDetail {
  item: MediaItem;
  show?: MediaItem | null;
  season?: MediaItem | null;
  seasons: MediaItem[];
  episodes: MediaItem[];
  tracks: MediaItem[];
  related: MediaItem[];
  nextEpisode?: MediaItem | null;
  artist?: MediaItem | null;
  album?: MediaItem | null;
  subtitles: unknown[];
}

interface SearchBody {
  query: string;
  total: number;
  items: MediaItem[];
  groups: {
    movies: MediaItem[];
    shows: MediaItem[];
    episodes: MediaItem[];
    albums: MediaItem[];
    tracks: MediaItem[];
    artists: MediaItem[];
    people: { name: string; role: string; count: number; mediaId: number; mediaTitle: string }[];
    genres: { name: string; count: number }[];
  };
}

interface FiltersBody {
  genres: string[];
  years: number[];
  libraries: { id: number; name: string; kind: string }[];
  tags: string[];
  contentRatings: string[];
}

interface HomeBody {
  hero: MediaItem[];
  rows: { id: string; title: string; kind: string; items: MediaItem[] }[];
  continueWatching: MediaItem[];
  recentlyAdded: MediaItem[];
  genres: string[];
  stats: { totalItems: number; movies: number; shows: number; episodes: number; albums: number; tracks: number; photos: number; watchSeconds: number; libraries: number };
}

interface LibraryStats {
  counts: Record<string, number>;
  totalItems: number;
  hiddenItems: number;
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let regular: Client;

let moviesLibrary: Library;
let showsLibrary: Library;
let musicLibrary: Library;
let photosLibrary: Library;

const movieIds: Record<string, number> = {};
let deltaSource: string;
let showId: number;
let albumId: number;
let artistId: number;
let photoId: number;

function movieFixture(root: string, folder: string, file: string, nfo: Parameters<typeof writeNfo>[2]): string {
  const dir = path.join(root, folder);
  const video = makeVideo(path.join(dir, file));
  writeNfo(path.join(dir, 'movie.nfo'), 'movie', nfo);
  return video;
}

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'browse_manager', 'manager');
  regular = await newUserClient(server, admin, 'browse_user', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  movieFixture(moviesRoot, 'Alpha Slop (2019)', 'Alpha Slop (2019).mp4', {
    title: 'Alpha Slop',
    year: 2019,
    plot: 'The first slop.',
    rating: 8.5,
    mpaa: 'PG-13',
    genres: ['Action', 'Drama'],
    tags: ['must-watch'],
    people: [{ name: 'Jane Doe', role: 'actor', character: 'Hero' }],
  });
  movieFixture(moviesRoot, 'Beta Slop (2001)', 'Beta Slop (2001).mp4', {
    title: 'Beta Slop',
    year: 2001,
    plot: 'A comedy of errors.',
    rating: 6,
    genres: ['Comedy'],
    people: [{ name: 'John Roe', role: 'actor', character: 'Barista' }],
  });
  movieFixture(moviesRoot, 'Gamma Slop (1995)', 'Gamma Slop (1995).mp4', {
    title: 'Gamma Slop',
    year: 1995,
    plot: 'Old slop, no rating.',
    genres: ['Action'],
  });
  deltaSource = movieFixture(moviesRoot, 'Delta Slop (2010)', 'Delta Slop (2010).mp4', {
    title: 'Delta Slop',
    year: 2010,
    plot: 'Hidden eventually.',
    rating: 7,
    genres: ['Action', 'Comedy'],
    tags: ['throwaway'],
  });

  const showDir = path.join(server.mediaDir, 'shows', 'Slop Saga (2021)');
  writeNfo(path.join(showDir, 'tvshow.nfo'), 'tvshow', {
    title: 'Slop Saga',
    year: 2021,
    plot: 'A saga.',
    rating: 7.9,
    genres: ['Drama'],
    people: [{ name: 'Cast Member', role: 'actor', character: 'Saga Lead' }],
  });
  makeVideo(path.join(showDir, 'Season 01', 'Slop Saga - S01E01 - Origins.mp4'));
  makeVideo(path.join(showDir, 'Season 01', 'Slop Saga - S01E02 - Rising.mp4'));
  makeVideo(path.join(showDir, 'Season 02', 'Slop Saga - S02E01 - Fall.mp4'));
  makeVideo(path.join(showDir, 'Season 02', 'Slop Saga - S02E02 - End.mp4'));

  const albumDir = path.join(server.mediaDir, 'music', 'Songbird', 'Test Album (2005)');
  makeAudioTrack(path.join(albumDir, '01 - First Song.mp3'), { title: 'First Song', genre: 'Folk', track: 1 });
  makeAudioTrack(path.join(albumDir, '02 - Second Song.mp3'), { title: 'Second Song', genre: 'Folk', track: 2 });
  makeImage(path.join(server.mediaDir, 'photos', 'one.jpg'), '0x445566');

  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  showsLibrary = await createLibrary(admin, { name: 'Shows', kind: 'shows', path: path.join(server.mediaDir, 'shows') });
  musicLibrary = await createLibrary(admin, { name: 'Music', kind: 'music', path: path.join(server.mediaDir, 'music') });
  photosLibrary = await createLibrary(admin, { name: 'Photos', kind: 'photos', path: path.join(server.mediaDir, 'photos') });

  await scanLibrary(admin, moviesLibrary.id);
  await scanLibrary(admin, showsLibrary.id);
  await scanLibrary(admin, musicLibrary.id);
  await scanLibrary(admin, photosLibrary.id);

  const movies = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  for (const item of movies.json!.items) movieIds[item.title] = item.id;
  assert.ok(movieIds['Alpha Slop']);
  const shows = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${showsLibrary.id}/items`);
  showId = shows.json!.items[0].id;
  const music = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items`);
  albumId = music.json!.items.find((item) => item.kind === 'album')!.id;
  artistId = music.json!.items.find((item) => item.kind === 'artist')!.id;
  const photos = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${photosLibrary.id}/items`);
  photoId = photos.json!.items[0].id;
});

after(async () => {
  await server.stop();
});

test('browse defaults to top-level kinds with count-aware pagination', async () => {
  const all = await regular.get<PagedItems<MediaItem>>('/api/browse');
  assert.equal(all.status, 200);
  assert.equal(all.json?.total, 8);
  assert.equal(all.json?.page, 1);
  assert.equal(all.json?.pageSize, 48);
  assert.equal(all.json?.items.length, 8);
  assert.deepEqual([...new Set(all.json!.items.map((item) => item.kind))].sort(), ['album', 'artist', 'movie', 'photo', 'show']);
  for (const item of all.json!.items) assert.equal(item.playable, ['movie', 'video'].includes(item.kind));

  // Shows expose aggregate child counts in browse responses.
  const show = all.json!.items.find((item) => item.kind === 'show')!;
  const countedShow = show as MediaItem & { seasonCount?: number; episodeCount?: number };
  assert.equal(countedShow.seasonCount, 2);
  assert.equal(countedShow.episodeCount, 4);
  const album = all.json!.items.find((item) => item.kind === 'album')!;
  const countedAlbum = album as MediaItem & { trackCount?: number };
  assert.equal(countedAlbum.trackCount, 2);

  const page2 = await regular.get<PagedItems<MediaItem>>('/api/browse?page=2&pageSize=3');
  assert.equal(page2.json?.total, 8);
  assert.equal(page2.json?.items.length, 3);
  assert.equal(page2.json?.page, 2);
  const page3 = await regular.get<PagedItems<MediaItem>>('/api/browse?page=3&pageSize=3');
  assert.equal(page3.json?.items.length, 2);
  assert.equal(page3.json?.items.filter((item) => page2.json!.items.some((other) => other.id === item.id)).length, 0);

  const clamped = await regular.get<PagedItems<MediaItem>>('/api/browse?pageSize=9999');
  assert.equal(clamped.json?.pageSize, 200);

  const children = await regular.get<PagedItems<MediaItem>>('/api/browse?includeChildren=1');
  assert.equal(children.json?.total, 16);
  assert.ok(children.json!.items.some((item) => item.kind === 'episode'));
  assert.ok(children.json!.items.some((item) => item.kind === 'track'));
  assert.ok(children.json!.items.some((item) => item.kind === 'season'));
});

test('browse filters cover kind, library, genre, tag, year, rating, person, and text', async () => {
  const movies = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movies');
  assert.equal(movies.json?.total, 4);
  assert.ok(movies.json!.items.every((item) => item.kind === 'movie'));

  const episodes = await regular.get<PagedItems<MediaItem>>(`/api/browse?kind=episode&includeChildren=1`);
  assert.equal(episodes.json?.total, 4);
  const tracks = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=tracks&includeChildren=1');
  assert.equal(tracks.json?.total, 2);
  const childWithoutFlag = await regular.get('/api/browse?kind=season');
  assert.equal(childWithoutFlag.status, 400);
  assert.match((childWithoutFlag.json as ErrorBody).error.message, /child kind/);

  const byLibrary = await regular.get<PagedItems<MediaItem>>(`/api/browse?libraryId=${moviesLibrary.id}`);
  assert.equal(byLibrary.json?.total, 4);
  assert.ok(byLibrary.json!.items.every((item) => item.libraryId === moviesLibrary.id));

  const action = await regular.get<PagedItems<MediaItem>>('/api/browse?genre=Action');
  assert.equal(action.json?.total, 3);
  assert.deepEqual(action.json!.items.map((item) => item.title).sort(), ['Alpha Slop', 'Delta Slop', 'Gamma Slop']);
  const caseGenre = await regular.get<PagedItems<MediaItem>>('/api/browse?genre=action');
  assert.equal(caseGenre.json?.total, 3);

  const tag = await regular.get<PagedItems<MediaItem>>('/api/browse?tag=must-watch');
  assert.deepEqual(tag.json!.items.map((item) => item.title), ['Alpha Slop']);
  assert.equal((await regular.get<PagedItems<MediaItem>>('/api/browse?tag=missing-tag')).json?.total, 0);

  const years = await regular.get<PagedItems<MediaItem>>('/api/browse?yearFrom=2000&yearTo=2020');
  assert.deepEqual(years.json!.items.map((item) => item.year).sort((a, b) => (a ?? 0) - (b ?? 0)), [2001, 2005, 2010, 2019]);
  const content = await regular.get<PagedItems<MediaItem>>('/api/browse?contentRating=pg-13');
  assert.deepEqual(content.json!.items.map((item) => item.title), ['Alpha Slop']);

  const person = await regular.get<PagedItems<MediaItem>>('/api/browse?person=Jane%20Doe');
  assert.deepEqual(person.json!.items.map((item) => item.title), ['Alpha Slop']);
  const actorSearch = await regular.get<PagedItems<MediaItem>>('/api/browse?q=John');
  assert.deepEqual(actorSearch.json!.items.map((item) => item.title), ['Beta Slop']);
  const genreSearch = await regular.get<PagedItems<MediaItem>>('/api/browse?q=Comedy');
  assert.deepEqual(genreSearch.json!.items.map((item) => item.title).sort(), ['Beta Slop', 'Delta Slop']);
  const text = await regular.get<PagedItems<MediaItem>>('/api/browse?q=alpha');
  assert.deepEqual(text.json!.items.map((item) => item.title), ['Alpha Slop']);
});

test('browse rejects invalid filter combinations instead of guessing', async () => {
  const cases = [
    '/api/browse?sort=nonsense',
    '/api/browse?order=sideways',
    '/api/browse?yearFrom=1700',
    '/api/browse?yearTo=2300',
    '/api/browse?yearFrom=2010&yearTo=2000',
    '/api/browse?watched=1&unwatched=1',
    '/api/browse?libraryId=99999',
    '/api/browse?libraryId=-1',
    '/api/browse?kind=podcasts',
    '/api/browse?q=' + 'a'.repeat(121),
  ];
  for (const pathname of cases) {
    const response = await regular.get(pathname);
    assert.equal(response.status, 400, `${pathname}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request', pathname);
  }
  const negativePageSize = await regular.get<PagedItems<MediaItem>>('/api/browse?pageSize=-4');
  assert.equal(negativePageSize.status, 200);
  assert.equal(negativePageSize.json?.pageSize, 48);
  const noUser = await new Client(server.baseUrl, 'anon-browse').get('/api/browse?kind=movies');
  assert.equal(noUser.status, 401);
});

test('browse sorts are deterministic and typed', async () => {
  const title = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=title');
  assert.deepEqual(title.json!.items.map((item) => item.title), ['Alpha Slop', 'Beta Slop', 'Delta Slop', 'Gamma Slop']);
  const titleDesc = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=title&order=desc');
  assert.deepEqual(titleDesc.json!.items.map((item) => item.title), ['Gamma Slop', 'Delta Slop', 'Beta Slop', 'Alpha Slop']);

  const year = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=year');
  assert.deepEqual(year.json!.items.map((item) => item.year), [2019, 2010, 2001, 1995]);
  const yearAsc = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=year&order=asc');
  assert.deepEqual(yearAsc.json!.items.map((item) => item.year), [1995, 2001, 2010, 2019]);

  const rating = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=rating');
  assert.deepEqual(rating.json!.items.map((item) => item.rating), [8.5, 7, 6, null]);

  const added = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=added');
  assert.deepEqual(added.json!.items.map((item) => item.id).sort((a, b) => a - b), Object.values(movieIds).sort((a, b) => a - b));

  const randomA = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie&sort=random');
  assert.equal(randomA.json?.total, 4);
  assert.equal(randomA.json?.items.length, 4);
});

test('per-user favorite, watched, unwatched, and in-progress filters use real state', async () => {
  const alpha = movieIds['Alpha Slop'];
  const beta = movieIds['Beta Slop'];
  const gamma = movieIds['Gamma Slop'];

  assert.equal((await regular.put(`/api/progress/${alpha}/state`, { favorite: true })).status, 200);
  assert.equal((await regular.put(`/api/progress/${beta}/state`, { watched: true })).status, 200);
  const heartbeat = await regular.put(`/api/progress/${gamma}`, { positionSeconds: 30, durationSeconds: 120 });
  assert.equal(heartbeat.status, 200);

  const favorites = await regular.get<PagedItems<MediaItem>>('/api/browse?favorites=1&kind=movie');
  assert.equal(favorites.json?.total, 1);
  assert.equal(favorites.json!.items[0].id, alpha);
  assert.equal(favorites.json!.items[0].favorite, true);

  const watched = await regular.get<PagedItems<MediaItem>>('/api/browse?watched=1&kind=movie');
  assert.deepEqual(watched.json!.items.map((item) => item.id), [beta]);
  assert.equal(watched.json!.items[0].watched, true);

  const unwatched = await regular.get<PagedItems<MediaItem>>('/api/browse?unwatched=1&kind=movie');
  assert.deepEqual(unwatched.json!.items.map((item) => item.id).sort((a, b) => a - b), [alpha, gamma, movieIds['Delta Slop']].sort((a, b) => a - b));

  const inProgress = await regular.get<PagedItems<MediaItem>>('/api/browse?inProgress=1&kind=movie');
  assert.deepEqual(inProgress.json!.items.map((item) => item.id), [gamma]);
  assert.equal(inProgress.json!.items[0].progress?.positionSeconds, 30);

  // A different user sees none of that state.
  const managerFavorites = await manager.get<PagedItems<MediaItem>>('/api/browse?favorites=1');
  assert.equal(managerFavorites.json?.total, 0);
  const managerWatched = await manager.get<PagedItems<MediaItem>>('/api/browse?watched=1');
  assert.equal(managerWatched.json?.total, 0);
});

test('detail endpoints expose seasons, episodes, next-up, tracks, and related items', async () => {
  const show = await regular.get<MediaDetail>(`/api/media/${showId}`);
  assert.equal(show.status, 200);
  assert.equal(show.json?.item.title, 'Slop Saga');
  assert.equal(show.json?.seasons.length, 2);
  assert.deepEqual(show.json?.seasons.map((season) => season.seasonNumber), [1, 2]);
  assert.equal(show.json?.episodes.length, 4);
  assert.deepEqual(
    show.json?.episodes.map((episode) => `${episode.seasonNumber}x${episode.episodeNumber}`),
    ['1x1', '1x2', '2x1', '2x2'],
  );
  assert.equal(show.json?.nextEpisode, undefined);
  assert.equal(show.json?.show, undefined);
  assert.equal(show.json?.item.playable, false);

  const season = show.json!.seasons[0];
  const seasonDetail = await regular.get<MediaDetail>(`/api/media/${season.id}`);
  assert.equal(seasonDetail.json?.show?.id, showId);
  assert.equal(seasonDetail.json?.item.id, season.id, 'season detail carries itself in item, not season');
  assert.equal(seasonDetail.json?.episodes.length, 2);
  assert.equal(seasonDetail.json?.item.seasonNumber, 1);

  const children = await regular.get<PagedItems<MediaItem>>(`/api/media/${showId}/children`);
  assert.equal(children.json?.total, 2);
  assert.ok(children.json!.items.every((item) => item.kind === 'season'));
  const seasonChildren = await regular.get<PagedItems<MediaItem>>(`/api/media/${showId}/children?season=1`);
  assert.equal(seasonChildren.json?.total, 2);
  assert.ok(seasonChildren.json!.items.every((item) => item.kind === 'episode' && item.seasonNumber === 1));
  const firstChildPage = await regular.get<PagedItems<MediaItem>>(`/api/media/${showId}/children?pageSize=1&page=1`);
  const pagedChildren = await regular.get<PagedItems<MediaItem>>(`/api/media/${showId}/children?pageSize=1&page=2`);
  assert.equal(firstChildPage.json?.items.length, 1);
  assert.equal(pagedChildren.json?.items.length, 1);
  assert.notEqual(pagedChildren.json!.items[0].id, firstChildPage.json!.items[0].id);
  assert.ok(show.json!.seasons.some((item) => item.id === pagedChildren.json!.items[0].id));
  assert.equal((await regular.get(`/api/media/${showId}/children?season=99`)).status, 404);

  const episode = show.json!.episodes[0];
  const firstEpisode = await regular.get<MediaDetail>(`/api/media/${episode.id}`);
  assert.equal(firstEpisode.json?.show?.id, showId);
  assert.equal(firstEpisode.json?.season?.seasonNumber, 1);
  assert.equal(firstEpisode.json?.nextEpisode?.id, show.json!.episodes[1].id);
  assert.equal(firstEpisode.json?.episodes.length, 2);
  const secondEpisode = await regular.get<MediaDetail>(`/api/media/${show.json!.episodes[1].id}`);
  assert.equal(secondEpisode.json?.nextEpisode?.id, show.json!.episodes[2].id);
  const finale = await regular.get<MediaDetail>(`/api/media/${show.json!.episodes[3].id}`);
  assert.equal(finale.json?.nextEpisode, undefined);
  assert.equal(finale.json?.episodes.length, 2);

  const album = await regular.get<MediaDetail>(`/api/media/${albumId}`);
  assert.equal(album.json?.item.kind, 'album');
  assert.equal(album.json?.tracks.length, 2);
  assert.deepEqual(album.json?.tracks.map((track) => track.trackNumber), [1, 2]);
  assert.equal(album.json?.artist?.id, artistId);
  assert.equal(album.json?.album?.id, albumId);

  const artist = await regular.get<MediaDetail>(`/api/media/${artistId}`);
  assert.equal(artist.json?.item.kind, 'artist');
  assert.ok(artist.json!.tracks.length >= 2);
  const albumChildren = await regular.get<PagedItems<MediaItem>>(`/api/media/${albumId}/children`);
  assert.equal(albumChildren.json?.total, 2);
  assert.equal(albumChildren.json?.items[0].trackNumber, 1);
  const artistChildren = await regular.get<PagedItems<MediaItem>>(`/api/media/${artistId}/children`);
  assert.equal(artistChildren.json?.total, 1);
  assert.equal(artistChildren.json?.items[0].kind, 'album');

  const trackId = album.json!.tracks[0].id;
  const track = await regular.get<MediaDetail>(`/api/media/${trackId}`);
  assert.equal(track.json?.item.albumId, albumId);
  assert.equal(track.json?.album?.id, albumId);
  assert.equal(track.json?.artist?.id, artistId);

  const photo = await regular.get<MediaDetail>(`/api/media/${photoId}`);
  assert.equal(photo.json?.item.kind, 'photo');
  assert.equal(photo.json?.item.playable, false);

  assert.equal((await regular.get('/api/media/abc')).status, 400);
  assert.equal((await regular.get('/api/media/99999')).status, 404);
  assert.equal((await regular.get('/api/media/0')).status, 400);
});

test('search matches titles, cast, genres, and episodes with grouped results', async () => {
  const alpha = await regular.get<SearchBody>('/api/browse/search?q=alpha');
  assert.equal(alpha.status, 200);
  assert.equal(alpha.json?.query, 'alpha');
  assert.deepEqual(alpha.json?.groups.movies.map((item) => item.title), ['Alpha Slop']);
  assert.equal(alpha.json?.total, 1);

  const upper = await regular.get<SearchBody>('/api/browse/search?q=ALPHA');
  assert.equal(upper.json?.groups.movies.length, 1);
  assert.equal(upper.json?.groups.movies[0].title, 'Alpha Slop');

  const cast = await regular.get<SearchBody>('/api/browse/search?q=Jane');
  assert.deepEqual(cast.json?.groups.movies.map((item) => item.title), ['Alpha Slop']);
  assert.equal(cast.json?.groups.people.length, 1);
  assert.equal(cast.json?.groups.people[0].name, 'Jane Doe');
  assert.equal(cast.json?.groups.people[0].role, 'cast');
  assert.equal(cast.json?.groups.people[0].count, 1);
  assert.equal(cast.json?.groups.people[0].mediaId, movieIds['Alpha Slop']);
  assert.equal(cast.json?.groups.people[0].mediaTitle, 'Alpha Slop');
  assert.equal(cast.json?.total, 2);

  const genre = await regular.get<SearchBody>('/api/browse/search?q=Comedy');
  assert.deepEqual(genre.json?.groups.movies.map((item) => item.title).sort(), ['Beta Slop', 'Delta Slop']);
  assert.deepEqual(genre.json?.groups.genres, [{ name: 'Comedy', count: 2 }]);
  assert.equal(genre.json?.total, 3);

  const episode = await regular.get<SearchBody>('/api/browse/search?q=Origins');
  assert.equal(episode.json?.groups.episodes.length, 1);
  assert.equal(episode.json?.groups.episodes[0].kind, 'episode');

  const song = await regular.get<SearchBody>('/api/browse/search?q=Song');
  assert.equal((song.json?.groups.tracks.length ?? 0), 2);
  assert.equal((song.json?.groups.albums.length ?? 0), 0);
  assert.equal((song.json?.groups.artists.length ?? 0), 1);
  assert.equal(song.json!.groups.artists[0].title, 'Songbird');
  const albumSearch = await regular.get<SearchBody>('/api/browse/search?q=Test%20Album');
  assert.deepEqual(albumSearch.json!.groups.albums.map((album) => album.title), ['Test Album']);

  const empty = await regular.get<SearchBody>('/api/browse/search?q=');
  assert.equal(empty.json?.query, '');
  assert.equal(empty.json?.total, 0);
  assert.deepEqual(empty.json?.groups.movies, []);
  assert.deepEqual(empty.json?.items, []);

  const nothing = await regular.get<SearchBody>('/api/browse/search?q=nothing-here');
  assert.equal(nothing.json?.total, 0);
  assert.equal(nothing.json?.items.length, 0);

  const percent = await regular.get<SearchBody>('/api/browse/search?q=%25');
  assert.equal(percent.json?.total, 0, 'LIKE wildcards must be escaped in search');

  assert.equal((await regular.get('/api/browse/search?q=' + 'z'.repeat(121))).status, 400);
});

test('metadata PATCH is manager-only, validated, and effectful', async () => {
  const alpha = movieIds['Alpha Slop'];
  assert.equal((await regular.patch(`/api/media/${alpha}`, { title: 'Nope' })).status, 403);

  const patched = await manager.patch<{ ok: boolean; item: MediaItem }>(`/api/media/${alpha}`, {
    title: 'Alpha Slop Redux',
    year: 2020,
    rating: 9.1,
    description: 'Rewritten slop.',
    tagline: 'New tagline.',
    contentRating: 'NC-17',
    genres: ['Documentary'],
    tags: ['edited'],
    people: [{ name: 'New Actor', role: 'cast', character: 'New Character' }],
    metadataLocked: true,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json?.ok, true);
  assert.equal(patched.json?.item.title, 'Alpha Slop Redux');
  assert.equal(patched.json?.item.year, 2020);
  assert.equal(patched.json?.item.rating, 9.1);
  assert.equal(patched.json?.item.description, 'Rewritten slop.');
  assert.equal(patched.json?.item.contentRating, 'NC-17');
  assert.deepEqual(patched.json?.item.genres, ['Documentary']);
  assert.deepEqual(patched.json?.item.people?.map((person) => person.name), ['New Actor']);
  assert.equal(patched.json?.item.sortTitle, 'alpha slop redux');

  const detail = await regular.get<MediaDetail>(`/api/media/${alpha}`);
  assert.equal(detail.json?.item.title, 'Alpha Slop Redux');
  const edited = await regular.get<PagedItems<MediaItem>>('/api/browse?tag=edited');
  assert.deepEqual(edited.json!.items.map((item) => item.id), [alpha]);
  const doc = await regular.get<PagedItems<MediaItem>>('/api/browse?genre=Documentary');
  assert.deepEqual(doc.json!.items.map((item) => item.id), [alpha]);

  const cases: Record<string, unknown>[] = [
    { year: 1700 },
    { year: 2300 },
    { rating: 11 },
    { rating: -1 },
    { title: '' },
    { title: 'x'.repeat(301) },
    { description: 'x'.repeat(5001) },
    { tagline: 'x'.repeat(301) },
    { contentRating: 'x'.repeat(21) },
    { genres: 'Action' },
    { genres: Array.from({ length: 21 }, (_, index) => `G${index}`) },
    { tags: [1, 2] },
    { people: [{ name: '' }] },
    { people: [{ name: 'Fine', role: 'x'.repeat(41) }] },
    { metadataLocked: 'yes' },
    { year: 'not-a-year' },
  ];
  for (const body of cases) {
    const response = await manager.patch(`/api/media/${alpha}`, body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request');
  }

  assert.equal((await manager.patch('/api/media/99999', { title: 'Ghost' })).status, 404);
  assert.equal((await regular.patch('/api/media/99999', { title: 'Ghost' })).status, 403);

  const refreshed = await manager.post<{ ok: boolean; item: MediaItem; warnings: string[] }>(`/api/media/${alpha}/refresh`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json?.item.title, 'Alpha Slop Redux', 'metadata_locked must survive refresh');
  assert.ok(Array.isArray(refreshed.json?.warnings));

  const match = await manager.post<{ ok: boolean; reason: string }>(`/api/media/${alpha}/match`, {});
  assert.equal(match.status, 200);
  assert.equal(match.json?.ok, false);
  assert.equal(match.json?.reason, 'tmdb_not_configured');
  assert.equal((await regular.post(`/api/media/${alpha}/match`, {})).status, 403);
});

test('hidden media disappears from browse/search but admin can still inspect it', async () => {
  const delta = movieIds['Delta Slop'];
  assert.equal((await regular.del(`/api/media/${delta}`)).status, 403);
  assert.equal((await manager.del(`/api/media/${delta}`)).status, 403);

  const hidden = await admin.del<{ ok: boolean; hidden: boolean; sourceFiles: string }>(`/api/media/${delta}`);
  assert.equal(hidden.status, 200);
  assert.equal(hidden.json?.ok, true);
  assert.equal(hidden.json?.hidden, true);
  assert.match(hidden.json?.sourceFiles ?? '', /disk/);

  assert.equal((await regular.get(`/api/media/${delta}`)).status, 404);
  assert.equal((await admin.get(`/api/media/${delta}`)).status, 200);
  const browse = await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie');
  assert.equal(browse.json?.total, 3);
  assert.ok(!browse.json!.items.some((item) => item.id === delta));
  const search = await regular.get<SearchBody>('/api/browse/search?q=Delta');
  assert.equal(search.json?.total, 0);
  const hiddenArt = await regular.get(`/api/art/${delta}/poster`);
  assert.equal(hiddenArt.status, 404);

  const hard = await admin.del<{ ok: boolean; hard: boolean; removed: number; sourceFiles: string }>(`/api/media/${delta}?hard=1`);
  assert.equal(hard.status, 200);
  assert.equal(hard.json?.hard, true);
  assert.equal(hard.json?.removed, 1);
  assert.equal((await admin.get(`/api/media/${delta}`)).status, 404);
  assert.equal(fs.statSync(deltaSource).size > 0, true, 'source files are never deleted by the API');
  assert.equal((await regular.get<PagedItems<MediaItem>>('/api/browse?kind=movie')).json?.total, 3);
});

test('random respects filters, refuses non-playable kinds, and 404s on empty filters', async () => {
  const doc = await regular.get<{ item: MediaItem }>('/api/browse/random?kind=movie&genre=Documentary');
  assert.equal(doc.status, 200);
  assert.equal(doc.json?.item.id, movieIds['Alpha Slop']);
  assert.equal(doc.json?.item.kind, 'movie');

  const defaultRandom = await regular.get<{ item: MediaItem }>('/api/browse/random');
  assert.equal(defaultRandom.status, 200);
  assert.ok(['movie', 'show', 'video'].includes(defaultRandom.json!.item.kind));

  const empty = await regular.get('/api/browse/random?genre=Impossible');
  assert.equal(empty.status, 404);
  assert.equal((empty.json as ErrorBody).error.code, 'not_found');

  const album = await regular.get('/api/browse/random?kind=album');
  assert.equal(album.status, 400);
  assert.match((album.json as ErrorBody).error.message, /random only deals/);
});

test('filters endpoint reflects the visible corpus after edits', async () => {
  const filters = await regular.get<FiltersBody>('/api/browse/filters');
  assert.equal(filters.status, 200);
  assert.ok(filters.json!.genres.includes('Action'));
  assert.ok(filters.json!.genres.includes('Comedy'));
  assert.ok(filters.json!.genres.includes('Documentary'));
  assert.ok(filters.json!.genres.includes('Drama'));
  assert.ok(filters.json!.genres.includes('Folk'));
  assert.deepEqual(filters.json!.genres, ['Folk', 'Action', 'Comedy', 'Documentary', 'Drama']);
  assert.deepEqual(filters.json!.tags, ['edited']);
  assert.deepEqual(filters.json!.years, [1995, 2021]);
  assert.deepEqual(filters.json!.contentRatings, ['NC-17']);
  assert.equal(filters.json!.libraries.length, 4);
  assert.deepEqual(
    filters.json!.libraries.map((library) => library.kind).sort(),
    ['movies', 'music', 'photos', 'shows'],
  );
});

test('genre pages and home rails use real rows and user progress', async () => {
  const drama = await regular.get<PagedItems<MediaItem> & { genre: string }>('/api/browse/genres/Drama');
  assert.equal(drama.status, 200);
  assert.equal(drama.json?.genre, 'Drama');
  assert.deepEqual(drama.json!.items.map((item) => item.kind), ['show']);
  assert.equal(drama.json?.total, 1);
  const action = await regular.get<PagedItems<MediaItem> & { genre: string }>('/api/browse/genres/Action');
  assert.deepEqual(action.json!.items.map((item) => item.title), ['Gamma Slop']);
  const actionWithChildren = await regular.get<PagedItems<MediaItem>>('/api/browse/genres/Action?includeChildren=1');
  assert.equal(actionWithChildren.json?.total, 1);
  const missing = await regular.get<PagedItems<MediaItem>>('/api/browse/genres/Impossible');
  assert.equal(missing.json?.total, 0);

  const home = await regular.get<HomeBody>('/api/browse/home');
  assert.equal(home.status, 200);
  const rowIds = home.json!.rows.map((row) => row.id);
  assert.ok(rowIds.includes('continue'));
  assert.ok(rowIds.includes('movies'));
  assert.ok(rowIds.includes('shows'));
  assert.ok(rowIds.includes('music'));
  assert.ok(rowIds.includes('gems'));
  assert.ok(rowIds.includes('genre:Action'));
  assert.equal(home.json?.continueWatching.length, 1);
  assert.equal(home.json?.continueWatching[0].id, movieIds['Gamma Slop']);
  assert.equal(home.json?.continueWatching[0].progress?.positionSeconds, 30);
  assert.ok(home.json!.hero.every((item) => item.title !== 'Delta Slop'));
  assert.ok(home.json!.recentlyAdded.every((item) => item.title !== 'Delta Slop'));
  assert.equal(home.json?.stats.movies, 3);
  assert.equal(home.json?.stats.shows, 1);
  assert.equal(home.json?.stats.episodes, 4);
  assert.equal(home.json?.stats.albums, 1);
  assert.equal(home.json?.stats.tracks, 2);
  assert.equal(home.json?.stats.photos, 1);
  assert.equal(home.json?.stats.libraries, 4);
  assert.equal(home.json?.stats.watchSeconds, 32);
  assert.ok(home.json!.genres.includes('Action'));
  const gems = home.json!.rows.find((row) => row.id === 'gems')!;
  assert.deepEqual(gems.items.map((item) => item.id).sort((a, b) => a - b), [showId, movieIds['Alpha Slop']].sort((a, b) => a - b));
  const continueRow = home.json!.rows.find((row) => row.id === 'continue')!;
  assert.equal(continueRow.kind, 'progress');
  assert.equal(continueRow.items[0].id, movieIds['Gamma Slop']);
});

