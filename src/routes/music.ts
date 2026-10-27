import { Router } from 'express';
import type { Request } from 'express';
import { getDb, settings } from '../db.ts';
import { artUrl, mediaRowsToDTO, playlistToDTO } from '../lib/dto.ts';
import { badRequest, notFound, pageParams, queryInt, queryString, sendPage } from '../lib/http.ts';
import type { MediaDTO, MediaRow, PlaylistDTO, PlaylistRow } from '../types.ts';

export const musicRouter = Router();

/** Respect the site's memes toggle for user-facing copy without changing API shapes. */
function copy(funny: string, dry: string): string {
  return settings.get('memes') ? funny : dry;
}

/** Extra convenience fields attached to DTOs. Playback fields are never invented: clients use /api/stream/:id/info. */
interface TrackExtra {
  albumName?: string | null;
  artistName?: string | null;
}
interface AlbumExtra {
  artistName?: string | null;
}
interface ArtistExtra {
  albumCount?: number;
  trackCount?: number;
  durationSeconds?: number | null;
}
export type TrackDTO = MediaDTO & TrackExtra;
export type AlbumDTO = MediaDTO & AlbumExtra;
export type ArtistDTO = MediaDTO & ArtistExtra;

const ARTIST_SORTS: Record<string, string> = {
  title: 'sort_title COLLATE NOCASE',
  added: 'added_at',
  year: 'COALESCE(year, 9999)',
  rating: 'COALESCE(rating, -1)',
  random: 'RANDOM()',
};

const ALBUM_SORTS: Record<string, string> = {
  title: 'sort_title COLLATE NOCASE',
  added: 'added_at',
  year: 'COALESCE(year, 9999)',
  rating: 'COALESCE(rating, -1)',
  random: 'RANDOM()',
};

const NATURAL_DESC: Record<string, true> = { added: true, year: true, rating: true };

const TRACK_SORTS: Record<string, string> = {
  title: 'sort_title COLLATE NOCASE',
  track: 'COALESCE(disc_number, 1), COALESCE(track_number, 9999)',
  added: 'added_at',
  year: 'COALESCE(year, 9999)',
  duration: 'COALESCE(runtime_seconds, 0)',
  random: 'RANDOM()',
};

function numericId(raw: string | string[] | undefined, label: string): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) throw badRequest(`That ${label} id is not even a number. Skill issue.`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`That ${label} id is out of range.`);
  return id;
}

function sortSpec(req: Request, map: Record<string, string>, fallback: string, defaultDir: 'ASC' | 'DESC') {
  const sort = queryString(req, 'sort') || fallback;
  const column = map[sort];
  if (!column) throw badRequest(`Unknown sort "${sort}". Try: ${Object.keys(map).join(', ')}.`);
  if (sort === 'random') return { sort, order: column };
  const requested = (queryString(req, 'order') || '').toLowerCase();
  if (requested && requested !== 'asc' && requested !== 'desc') throw badRequest('order must be asc or desc.');
  // "added", "year" and "rating" are naturally newest/biggest-first unless the client asks otherwise.
  const dir = requested === 'asc' ? 'ASC' : requested === 'desc' ? 'DESC' : NATURAL_DESC[sort] ? 'DESC' : defaultDir;
  return { sort, order: `${column} ${dir}` };
}

function lookupTitles(ids: number[]): Map<number, string> {
  const map = new Map<number, string>();
  if (ids.length === 0) return map;
  const db = getDb();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    const rows = db.prepare(`SELECT id, title FROM media WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { id: number; title: string }[];
    for (const row of rows) map.set(row.id, row.title);
  }
  return map;
}

function annotateTrackNames(items: MediaDTO[]): void {
  const albumIds: number[] = [];
  const artistIds: number[] = [];
  for (const item of items) {
    if (typeof item.albumId === 'number') albumIds.push(item.albumId);
    if (typeof item.artistId === 'number') artistIds.push(item.artistId);
  }
  const albums = lookupTitles(albumIds);
  const artists = lookupTitles(artistIds);
  const tracks = items as TrackDTO[];
  for (const item of tracks) {
    item.albumName = typeof item.albumId === 'number' ? albums.get(item.albumId) ?? null : null;
    item.artistName = typeof item.artistId === 'number' ? artists.get(item.artistId) ?? null : null;
  }
}

function annotateAlbumArtistNames(items: MediaDTO[]): void {
  const artistIds: number[] = [];
  for (const item of items) if (typeof item.artistId === 'number') artistIds.push(item.artistId);
  const artists = lookupTitles(artistIds);
  const albums = items as AlbumDTO[];
  for (const item of albums) {
    item.artistName = typeof item.artistId === 'number' ? artists.get(item.artistId) ?? null : null;
  }
}

/** Fill missing artist/album art from child rows (albums/tracks), cheapest-first, without touching the DB schema. */
function deriveArt(items: MediaDTO[], parentColumn: 'album_id' | 'artist_id'): void {
  const missing = items.filter((item) => !item.art.poster || !item.art.thumb).map((item) => item.id);
  if (missing.length === 0) return;
  const db = getDb();
  const placeholders = missing.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.${parentColumn} AS parent_id, m.id AS child_id, m.updated_at, a.kind, a.source
       FROM media m JOIN media_art a ON a.media_id = m.id
       WHERE m.${parentColumn} IN (${placeholders}) AND m.hidden = 0 AND a.kind IN ('poster','thumb')
       ORDER BY CASE a.kind WHEN 'poster' THEN 0 ELSE 1 END,
                CASE m.kind WHEN 'album' THEN 0 ELSE 1 END,
                COALESCE(m.disc_number, 0), COALESCE(m.track_number, 9999), m.id`,
    )
    .all(...missing) as { parent_id: number; child_id: number; updated_at: string; kind: 'poster' | 'thumb'; source: string }[];
  const byId = new Map(items.map((item) => [item.id, item]));
  const filled = new Set<string>();
  for (const row of rows) {
    const item = byId.get(row.parent_id);
    if (!item) continue;
    const key = `${row.parent_id}:${row.kind}`;
    if (item.art[row.kind] || filled.has(key)) continue;
    const url = artUrl(row.child_id, row.kind, `${row.source}-${row.updated_at}`);
    item.art[row.kind] = url;
    if (!item.art.poster) item.art.poster = url;
    filled.add(key);
  }
}

function decorateArtists(items: MediaDTO[]): ArtistDTO[] {
  if (items.length === 0) return items;
  const db = getDb();
  const ids = items.map((item) => item.id);
  const placeholders = ids.map(() => '?').join(',');
  const stats = db
    .prepare(
      `SELECT artist_id, COUNT(*) AS n, COALESCE(SUM(runtime_seconds), 0) AS duration
       FROM media WHERE kind = 'track' AND hidden = 0 AND artist_id IN (${placeholders}) GROUP BY artist_id`,
    )
    .all(...ids) as { artist_id: number; n: number; duration: number }[];
  const albumCounts = db
    .prepare(`SELECT artist_id, COUNT(*) AS n FROM media WHERE kind = 'album' AND hidden = 0 AND artist_id IN (${placeholders}) GROUP BY artist_id`)
    .all(...ids) as { artist_id: number; n: number }[];
  const tracks = new Map(stats.map((row) => [row.artist_id, row]));
  const albums = new Map(albumCounts.map((row) => [row.artist_id, row.n]));
  const artists = items as ArtistDTO[];
  for (const item of artists) {
    item.trackCount = tracks.get(item.id)?.n ?? 0;
    item.albumCount = albums.get(item.id) ?? 0;
    item.durationSeconds = tracks.get(item.id)?.duration ?? 0;
  }
  deriveArt(items, 'artist_id');
  return items as ArtistDTO[];
}

function decorateAlbums(items: MediaDTO[]): AlbumDTO[] {
  annotateAlbumArtistNames(items);
  deriveArt(items, 'album_id');
  return items as AlbumDTO[];
}

function playlistDTOs(rows: PlaylistRow[]): PlaylistDTO[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const stats = db
    .prepare(
      `SELECT pi.playlist_id, COUNT(*) AS n, COALESCE(SUM(m.runtime_seconds), 0) AS duration
       FROM playlist_items pi JOIN media m ON m.id = pi.media_id
       WHERE pi.playlist_id IN (${placeholders}) GROUP BY pi.playlist_id`,
    )
    .all(...ids) as { playlist_id: number; n: number; duration: number }[];
  const statMap = new Map(stats.map((row) => [row.playlist_id, row]));
  const artRows = db
    .prepare(
      `SELECT pi.playlist_id, m.id AS media_id, a.kind, a.path, a.source, pi.sort_order
       FROM playlist_items pi JOIN media m ON m.id = pi.media_id
       JOIN media_art a ON a.media_id = m.id AND a.kind = 'poster'
       WHERE pi.playlist_id IN (${placeholders}) ORDER BY pi.playlist_id, pi.sort_order, m.id`,
    )
    .all(...ids) as { playlist_id: number; media_id: number; kind: 'poster'; path: string; source: string; sort_order: number }[];
  const artMap = new Map<number, { media_id: number; kind: 'poster'; path: string; source: string }>();
  for (const row of artRows) if (!artMap.has(row.playlist_id)) artMap.set(row.playlist_id, row);
  return rows.map((row) => {
    const stat = statMap.get(row.id);
    const firstArt = artMap.get(row.id);
    return playlistToDTO(row, {
      itemCount: stat?.n ?? 0,
      durationSeconds: stat?.duration ?? 0,
      artRows: firstArt ? [firstArt] : [],
    });
  });
}

function genreRows(limit = 100): { genre: string; count: number }[] {
  return getDb()
    .prepare(
      `SELECT g.genre, COUNT(DISTINCT g.media_id) AS count
       FROM media_genres g JOIN media m ON m.id = g.media_id
       WHERE m.hidden = 0 AND m.kind IN ('track','album','artist')
       GROUP BY g.genre COLLATE NOCASE ORDER BY count DESC, g.genre COLLATE NOCASE LIMIT ?`,
    )
    .all(limit) as { genre: string; count: number }[];
}

function albumTrackQuery(where: string): string {
  return `SELECT * FROM media WHERE ${where} AND kind = 'track' AND hidden = 0
          ORDER BY COALESCE(disc_number, 0) ASC, COALESCE(track_number, 9999) ASC, sort_title COLLATE NOCASE ASC, id ASC`;
}

function artistTopTracks(artistId: number, userId: number, limit = 10): MediaRow[] {
  return getDb()
    .prepare(
      `SELECT m.* FROM media m
       LEFT JOIN progress p ON p.media_id = m.id AND p.user_id = ?
       WHERE m.artist_id = ? AND m.kind = 'track' AND m.hidden = 0
       ORDER BY COALESCE(p.play_count, 0) DESC, COALESCE(p.updated_at, '') DESC,
                COALESCE(m.disc_number, 0), COALESCE(m.track_number, 9999), m.sort_title COLLATE NOCASE, m.id
       LIMIT ?`,
    )
    .all(userId, artistId, limit) as MediaRow[];
}

function recentlyPlayedRows(userId: number, limit: number): MediaRow[] {
  return getDb()
    .prepare(
      `SELECT m.* FROM progress p JOIN media m ON m.id = p.media_id
       WHERE p.user_id = ? AND m.kind = 'track' AND m.hidden = 0
       ORDER BY p.updated_at DESC, m.id DESC LIMIT ?`,
    )
    .all(userId, limit) as MediaRow[];
}

function musicStats(userId: number) {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(runtime_seconds), 0) AS duration, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM media WHERE hidden = 0 AND kind IN ('track','album','artist') GROUP BY kind`,
    )
    .all() as { kind: string; n: number; duration: number; bytes: number }[];
  const byKind = new Map(counts.map((row) => [row.kind, row]));
  const playlistCountRow = db.prepare(`SELECT COUNT(*) AS n FROM playlists WHERE is_public = 1 OR created_by = ?`).get(userId) as { n: number };
  const playlistCount = playlistCountRow.n;
  return {
    tracks: byKind.get('track')?.n ?? 0,
    albums: byKind.get('album')?.n ?? 0,
    artists: byKind.get('artist')?.n ?? 0,
    playlists: playlistCount,
    totalDurationSeconds: byKind.get('track')?.duration ?? 0,
    totalBytes: byKind.get('track')?.bytes ?? 0,
    genres: genreRows(1000).length,
  };
}

musicRouter.get('/', (req, res) => {
  const userId = req.user!.id;
  const db = getDb();
  const recentTrackRows = db
    .prepare(`SELECT * FROM media WHERE kind = 'track' AND hidden = 0 ORDER BY added_at DESC, id DESC LIMIT 12`)
    .all() as MediaRow[];
  const recentAlbumRows = db
    .prepare(`SELECT * FROM media WHERE kind = 'album' AND hidden = 0 ORDER BY added_at DESC, id DESC LIMIT 8`)
    .all() as MediaRow[];
  const recentArtistRows = db
    .prepare(`SELECT * FROM media WHERE kind = 'artist' AND hidden = 0 ORDER BY added_at DESC, id DESC LIMIT 8`)
    .all() as MediaRow[];
  const artistRows = db
    .prepare(`SELECT * FROM media WHERE kind = 'artist' AND hidden = 0 ORDER BY sort_title COLLATE NOCASE ASC LIMIT 12`)
    .all() as MediaRow[];
  const albumRows = db
    .prepare(`SELECT * FROM media WHERE kind = 'album' AND hidden = 0 ORDER BY added_at DESC, id DESC LIMIT 12`)
    .all() as MediaRow[];
  const playlistRows = db
    .prepare(`SELECT * FROM playlists WHERE is_public = 1 OR created_by = ? ORDER BY updated_at DESC, id DESC LIMIT 8`)
    .all(userId) as PlaylistRow[];

  const recentTracks = mediaRowsToDTO(recentTrackRows, userId);
  annotateTrackNames(recentTracks);
  const recentlyAddedAlbums = mediaRowsToDTO(recentAlbumRows, userId);
  const recentlyAddedArtists = mediaRowsToDTO(recentArtistRows, userId);
  const artists = decorateArtists(mediaRowsToDTO(artistRows, userId));
  const albums = decorateAlbums(mediaRowsToDTO(albumRows, userId));
  const recentlyPlayed = mediaRowsToDTO(recentlyPlayedRows(userId, 10), userId);
  annotateTrackNames(recentlyPlayed);

  res.json({
    recentTracks,
    recentlyPlayed,
    recentlyAdded: {
      tracks: recentTracks,
      albums: decorateAlbums(recentlyAddedAlbums),
      artists: decorateArtists(recentlyAddedArtists),
    },
    artists,
    albums,
    playlists: playlistDTOs(playlistRows),
    genres: genreRows(24),
    stats: musicStats(userId),
  });
});

// MARKER_LISTS
function countOf(sql: string, ...params: (string | number)[]): number {
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

musicRouter.get('/artists', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 200 });
  const db = getDb();
  const where = [`kind = 'artist'`, 'hidden = 0'];
  const params: (string | number)[] = [];
  const q = queryString(req, 'q');
  if (q) {
    where.push(`title LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(q)}%`);
  }
  const clause = where.join(' AND ');
  const total = countOf(`SELECT COUNT(*) AS n FROM media WHERE ${clause}`, ...params);
  const order = sortSpec(req, ARTIST_SORTS, 'title', 'ASC');
  const rows = db.prepare(`SELECT * FROM media WHERE ${clause} ORDER BY ${order.order} LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as MediaRow[];
  sendPage(res, decorateArtists(mediaRowsToDTO(rows, req.user!.id)), total, page, pageSize);
});

musicRouter.get('/artists/:id', (req, res) => {
  const id = numericId(req.params.id, 'artist');
  const db = getDb();
  const userId = req.user!.id;
  const row = db.prepare(`SELECT * FROM media WHERE id = ? AND hidden = 0`).get(id) as MediaRow | undefined;
  if (!row || row.kind !== 'artist') throw notFound(copy('That artist is off the grid. Maybe they went indie.', 'Artist not found.'));
  const albumRows = db
    .prepare(
      `SELECT * FROM media WHERE artist_id = ? AND kind = 'album' AND hidden = 0
       ORDER BY COALESCE(year, 9999) ASC, sort_title COLLATE NOCASE ASC, id ASC`,
    )
    .all(id) as MediaRow[];
  const item = decorateArtists(mediaRowsToDTO([row], userId))[0];
  const albums = decorateAlbums(mediaRowsToDTO(albumRows, userId));
  const topTracks = mediaRowsToDTO(artistTopTracks(id, userId, 10), userId);
  annotateTrackNames(topTracks);
  res.json({ item, albums, topTracks });
});

musicRouter.get('/albums', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 200 });
  const db = getDb();
  const where = [`kind = 'album'`, 'hidden = 0'];
  const params: (string | number)[] = [];
  const artistIdRaw = queryString(req, 'artistId');
  if (artistIdRaw !== undefined) {
    const artistId = queryInt(req, 'artistId');
    if (!artistId || artistId <= 0) throw badRequest('artistId must be a positive integer.');
    where.push('artist_id = ?');
    params.push(artistId);
  }
  const q = queryString(req, 'q');
  if (q) {
    where.push(`title LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(q)}%`);
  }
  const clause = where.join(' AND ');
  const total = countOf(`SELECT COUNT(*) AS n FROM media WHERE ${clause}`, ...params);
  const order = sortSpec(req, ALBUM_SORTS, 'title', 'ASC');
  const rows = db.prepare(`SELECT * FROM media WHERE ${clause} ORDER BY ${order.order} LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as MediaRow[];
  sendPage(res, decorateAlbums(mediaRowsToDTO(rows, req.user!.id)), total, page, pageSize);
});

musicRouter.get('/albums/:id', (req, res) => {
  const id = numericId(req.params.id, 'album');
  const db = getDb();
  const userId = req.user!.id;
  const row = db.prepare(`SELECT * FROM media WHERE id = ? AND hidden = 0`).get(id) as MediaRow | undefined;
  if (!row || row.kind !== 'album') throw notFound(copy('That album is missing. Certified vault incident.', 'Album not found.'));
  const item = decorateAlbums(mediaRowsToDTO([row], userId))[0];
  const trackRows = db.prepare(albumTrackQuery('album_id = ?')).all(id) as MediaRow[];
  const tracks = mediaRowsToDTO(trackRows, userId);
  annotateTrackNames(tracks);
  const artistRow = typeof row.artist_id === 'number' ? (db.prepare(`SELECT * FROM media WHERE id = ? AND kind = 'artist'`).get(row.artist_id) as MediaRow | undefined) : undefined;
  const artist = artistRow ? decorateArtists(mediaRowsToDTO([artistRow], userId))[0] : null;
  res.json({ item, artist, tracks, trackCount: tracks.length });
});

// MARKER_TRACKS
function listingFilters(req: Request): { clause: string; params: (string | number)[] } {
  const where = [`kind = 'track'`, 'hidden = 0'];
  const params: (string | number)[] = [];
  const albumId = queryInt(req, 'albumId');
  if (queryString(req, 'albumId') !== undefined) {
    if (!albumId || albumId <= 0) throw badRequest('albumId must be a positive integer.');
    where.push('album_id = ?');
    params.push(albumId);
  }
  const artistId = queryInt(req, 'artistId');
  if (queryString(req, 'artistId') !== undefined) {
    if (!artistId || artistId <= 0) throw badRequest('artistId must be a positive integer.');
    where.push('artist_id = ?');
    params.push(artistId);
  }
  const genre = queryString(req, 'genre');
  if (genre) {
    where.push('EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = media.id AND g.genre = ? COLLATE NOCASE)');
    params.push(genre);
  }
  const q = queryString(req, 'q');
  if (q) {
    where.push(`title LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(q)}%`);
  }
  return { clause: where.join(' AND '), params };
}

musicRouter.get('/tracks', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 100, maxPageSize: 500 });
  const db = getDb();
  const { clause, params } = listingFilters(req);
  const total = countOf(`SELECT COUNT(*) AS n FROM media WHERE ${clause}`, ...params);
  const order = sortSpec(req, TRACK_SORTS, 'title', 'ASC');
  const rows = db.prepare(`SELECT * FROM media WHERE ${clause} ORDER BY ${order.order} LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as MediaRow[];
  const items = mediaRowsToDTO(rows, req.user!.id);
  annotateTrackNames(items);
  sendPage(res, items, total, page, pageSize);
});

musicRouter.get('/tracks/:id', (req, res) => {
  const id = numericId(req.params.id, 'track');
  const db = getDb();
  const userId = req.user!.id;
  const row = db.prepare(`SELECT * FROM media WHERE id = ? AND hidden = 0`).get(id) as MediaRow | undefined;
  if (!row || row.kind !== 'track') throw notFound(copy('That track does not exist. It was never even real.', 'Track not found.'));
  const item = mediaRowsToDTO([row], userId)[0];
  annotateTrackNames([item]);
  const albumRow = typeof row.album_id === 'number' ? (db.prepare(`SELECT * FROM media WHERE id = ?`).get(row.album_id) as MediaRow | undefined) : undefined;
  const artistRow = typeof row.artist_id === 'number' ? (db.prepare(`SELECT * FROM media WHERE id = ?`).get(row.artist_id) as MediaRow | undefined) : undefined;
  const album = albumRow ? decorateAlbums(mediaRowsToDTO([albumRow], userId))[0] : null;
  const artist = artistRow ? decorateArtists(mediaRowsToDTO([artistRow], userId))[0] : null;
  res.json({ item, album, artist });
});

musicRouter.get('/recently-played', (req, res) => {
  const requested = queryInt(req, 'limit');
  const limit = Math.min(Math.max(requested ?? 20, 1), 100);
  const userId = req.user!.id;
  const db = getDb();
  const items = mediaRowsToDTO(recentlyPlayedRows(userId, limit), userId);
  annotateTrackNames(items);
  const total = countOf(
    `SELECT COUNT(*) AS n FROM progress p JOIN media m ON m.id = p.media_id WHERE p.user_id = ? AND m.kind = 'track' AND m.hidden = 0`,
    userId,
  );
  res.json({ items, total, limit });
});

musicRouter.get('/genres', (_req, res) => {
  const genres = genreRows(200);
  const withTrackCounts = getDb()
    .prepare(
      `SELECT g.genre, COUNT(DISTINCT CASE WHEN m.kind = 'track' THEN m.id END) AS trackCount
       FROM media_genres g JOIN media m ON m.id = g.media_id
       WHERE m.hidden = 0 AND m.kind IN ('track','album','artist')
       GROUP BY g.genre COLLATE NOCASE`,
    )
    .all() as { genre: string; trackCount: number }[];
  const trackMap = new Map(withTrackCounts.map((row) => [row.genre.toLowerCase(), row.trackCount]));
  res.json({
    genres: genres.map((row) => ({ genre: row.genre, count: row.count, trackCount: trackMap.get(row.genre.toLowerCase()) ?? 0 })),
    total: genres.length,
  });
});
