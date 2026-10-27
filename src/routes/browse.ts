import { Router } from 'express';
import type { Request } from 'express';
import { getDb } from '../db.ts';
import { badRequest, pageParams, queryBool, queryString, sendPage } from '../lib/http.ts';
import { collectionToDTO, mediaRowsToDTO } from '../lib/dto.ts';
import type { ArtKind, CollectionDTO, CollectionRow, MediaDTO, MediaKind, MediaRow } from '../types.ts';

export const browseRouter = Router();

const TOP_LEVEL_KINDS: MediaKind[] = ['movie', 'show', 'artist', 'album', 'photo', 'video'];
const CHILD_KINDS: MediaKind[] = ['season', 'episode', 'track'];
const ALL_KINDS: MediaKind[] = [...TOP_LEVEL_KINDS, ...CHILD_KINDS];

/** URL slugs may be plural (`/api/browse?kind=movies`); normalize them consistently. */
const KIND_ALIASES: Record<string, MediaKind> = {
  movie: 'movie',
  movies: 'movie',
  show: 'show',
  shows: 'show',
  season: 'season',
  seasons: 'season',
  episode: 'episode',
  episodes: 'episode',
  artist: 'artist',
  artists: 'artist',
  album: 'album',
  albums: 'album',
  track: 'track',
  tracks: 'track',
  photo: 'photo',
  photos: 'photo',
  video: 'video',
  videos: 'video',
};

const SORTS: Record<string, { column: string; direction: 'asc' | 'desc' }> = {
  title: { column: `COALESCE(NULLIF(m.sort_title, ''), m.title) COLLATE NOCASE`, direction: 'asc' },
  added: { column: 'm.added_at', direction: 'desc' },
  year: { column: 'm.year', direction: 'desc' },
  rating: { column: 'm.rating', direction: 'desc' },
  runtime: { column: 'm.runtime_seconds', direction: 'desc' },
};

/** SQLite LIKE treats `%`, `_` and `\` specially; escape user input so search is literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function requireUserId(req: Request): number {
  const id = req.user?.id;
  if (!id) throw badRequest('No session user. Log in again, chief.');
  return id;
}

function parseKinds(req: Request, includeChildren: boolean): MediaKind[] {
  const raw = queryString(req, 'kind');
  if (!raw) return includeChildren ? ALL_KINDS : TOP_LEVEL_KINDS;
  const requested = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) throw badRequest('kind filter was empty. Skill issue.');
  const allowed = includeChildren ? ALL_KINDS : TOP_LEVEL_KINDS;
  const kinds: MediaKind[] = [];
  for (const part of requested) {
    const kind = KIND_ALIASES[part];
    if (!kind) {
      throw badRequest(`Unknown media kind "${part}". Try one of: ${ALL_KINDS.join(', ')}.`);
    }
    if (!allowed.includes(kind)) {
      throw badRequest(`"${part}" is a child kind. Pass includeChildren=1 if you really need that.`);
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

interface BrowseFilters {
  kinds: MediaKind[];
  libraryId?: number;
  genre?: string;
  tag?: string;
  yearFrom?: number;
  yearTo?: number;
  contentRating?: string;
  favorite?: boolean;
  watched?: boolean;
  unwatched?: boolean;
  inProgress?: boolean;
  q?: string;
  person?: string;
}

function parseInteger(req: Request, key: string): number | undefined {
  const raw = queryString(req, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw badRequest(`${key} must be an integer. "${raw}" is not math.`);
  return value;
}

function parseBrowseFilters(req: Request, includeChildren: boolean): BrowseFilters {
  const libraryId = parseInteger(req, 'libraryId');
  if (libraryId !== undefined) {
    if (libraryId <= 0) throw badRequest('libraryId must be a positive integer.');
    const exists = getDb().prepare('SELECT 1 AS ok FROM libraries WHERE id = ?').get(libraryId);
    if (!exists) throw badRequest(`Library ${libraryId} does not exist. Invented libraries are a different app.`);
  }
  const yearFrom = parseInteger(req, 'yearFrom');
  const yearTo = parseInteger(req, 'yearTo');
  if (yearFrom !== undefined && (yearFrom < 1800 || yearFrom > 2200)) throw badRequest('yearFrom is outside the rumored timeline.');
  if (yearTo !== undefined && (yearTo < 1800 || yearTo > 2200)) throw badRequest('yearTo is outside the rumored timeline.');
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) throw badRequest('yearFrom is after yearTo. Time is linear, mostly.');

  const q = queryString(req, 'q');
  const person = queryString(req, 'person');
  const contentRating = queryString(req, 'contentRating');
  const genre = queryString(req, 'genre');
  const tag = queryString(req, 'tag');
  if (q && q.length > 120) throw badRequest('Search query is too long. Even the slop has limits (120 chars).');
  if (person && person.length > 120) throw badRequest('Person filter is too long (120 chars max).');
  if (contentRating && contentRating.length > 30) throw badRequest('contentRating is too long for a rating.');
  if (genre && genre.length > 100) throw badRequest('genre filter is too long (100 chars max).');
  if (tag && tag.length > 100) throw badRequest('tag filter is too long (100 chars max).');

  const favorite = queryBool(req, 'favorite') ?? queryBool(req, 'favorites');
  const watched = queryBool(req, 'watched');
  const unwatched = queryBool(req, 'unwatched');
  if (watched && unwatched) throw badRequest('watched=1 and unwatched=1 cancel out. Pick a side.');

  return {
    kinds: parseKinds(req, includeChildren),
    libraryId,
    genre,
    tag,
    yearFrom,
    yearTo,
    contentRating,
    favorite,
    watched,
    unwatched,
    inProgress: queryBool(req, 'inProgress'),
    q,
    person,
  };
}

interface WhereParts {
  sql: string[];
  params: unknown[];
}

function buildWhere(filters: BrowseFilters, userId: number): WhereParts {
  const sql: string[] = ['m.hidden = 0'];
  const params: unknown[] = [];

  sql.push(`m.kind IN (${filters.kinds.map(() => '?').join(',')})`);
  params.push(...filters.kinds);

  if (filters.libraryId !== undefined) {
    sql.push('m.library_id = ?');
    params.push(filters.libraryId);
  }
  if (filters.genre) {
    sql.push('EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = m.id AND g.genre = ? COLLATE NOCASE)');
    params.push(filters.genre);
  }
  if (filters.tag) {
    sql.push('EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id = m.id AND t.tag = ? COLLATE NOCASE)');
    params.push(filters.tag);
  }
  if (filters.yearFrom !== undefined) {
    sql.push('m.year IS NOT NULL AND m.year >= ?');
    params.push(filters.yearFrom);
  }
  if (filters.yearTo !== undefined) {
    sql.push('m.year IS NOT NULL AND m.year <= ?');
    params.push(filters.yearTo);
  }
  if (filters.contentRating) {
    sql.push('m.content_rating = ? COLLATE NOCASE');
    params.push(filters.contentRating);
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    sql.push(`(
      m.title LIKE ? ESCAPE '\\' OR m.sort_title LIKE ? ESCAPE '\\' OR m.original_title LIKE ? ESCAPE '\\'
      OR m.description LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = m.id AND g.genre LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM media_people p WHERE p.media_id = m.id AND p.name LIKE ? ESCAPE '\\')
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.person) {
    sql.push('EXISTS (SELECT 1 FROM media_people p WHERE p.media_id = m.id AND p.name LIKE ? ESCAPE \'\\\')');
    params.push(`%${escapeLike(filters.person)}%`);
  }
  if (filters.favorite) {
    sql.push('EXISTS (SELECT 1 FROM item_state s WHERE s.user_id = ? AND s.media_id = m.id AND s.favorite = 1)');
    params.push(userId);
  }
  if (filters.watched) {
    sql.push('EXISTS (SELECT 1 FROM item_state s WHERE s.user_id = ? AND s.media_id = m.id AND s.watched = 1)');
    params.push(userId);
  }
  if (filters.unwatched) {
    sql.push(`NOT EXISTS (
      SELECT 1 FROM item_state s WHERE s.user_id = ? AND s.media_id = m.id AND s.watched = 1
    )`);
    params.push(userId);
  }
  if (filters.inProgress) {
    sql.push(`EXISTS (
      SELECT 1 FROM progress p WHERE p.user_id = ? AND p.media_id = m.id
        AND p.finished = 0 AND p.position_seconds > 0
    )`);
    params.push(userId);
  }
  return { sql, params };
}

function parseSort(req: Request, fallback = 'added'): { orderBy: string } {
  const sort = (queryString(req, 'sort') || fallback).toLowerCase();
  if (sort === 'random') return { orderBy: 'RANDOM()' };
  const entry = SORTS[sort];
  if (!entry) throw badRequest(`Unknown sort "${sort}". Options: ${[...Object.keys(SORTS), 'random'].join(', ')}.`);
  const rawOrder = queryString(req, 'order')?.toLowerCase();
  if (rawOrder && rawOrder !== 'asc' && rawOrder !== 'desc') throw badRequest('order must be asc or desc.');
  const direction = rawOrder || entry.direction;
  return { orderBy: `${entry.column} ${direction.toUpperCase()}, m.id ${direction.toUpperCase()}` };
}

interface SeasonInfo {
  seasonCount?: number;
  episodeCount?: number;
  trackCount?: number;
}

/** MediaDTO plus browse-only batch counts (extra JSON props, intentionally). */
interface CountedMedia extends MediaDTO {
  seasonCount?: number;
  episodeCount?: number;
  trackCount?: number;
}

function attachCounts(rows: MediaRow[], dtos: MediaDTO[]): CountedMedia[] {
  const db = getDb();
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return dtos;
  const counts = new Map<number, SeasonInfo>();

  const shows = rows.filter((row) => row.kind === 'show').map((row) => row.id);
  if (shows.length > 0) {
    for (const id of shows) counts.set(id, { seasonCount: 0, episodeCount: 0 });
    const placeholders = shows.map(() => '?').join(',');
    const seasonRows = db
      .prepare(`SELECT parent_id, COUNT(*) AS n FROM media WHERE hidden = 0 AND kind = 'season' AND parent_id IN (${placeholders}) GROUP BY parent_id`)
      .all(...shows) as { parent_id: number; n: number }[];
    for (const row of seasonRows) {
      const info = counts.get(row.parent_id) || {};
      info.seasonCount = row.n;
      counts.set(row.parent_id, info);
    }
    const episodeRows = db
      .prepare(
        `SELECT s.parent_id AS show_id, COUNT(*) AS n
         FROM media e JOIN media s ON s.id = e.parent_id
         WHERE e.hidden = 0 AND e.kind = 'episode' AND s.kind = 'season' AND s.parent_id IN (${placeholders})
         GROUP BY s.parent_id`,
      )
      .all(...shows) as { show_id: number; n: number }[];
    for (const row of episodeRows) {
      const info = counts.get(row.show_id) || {};
      info.episodeCount = row.n;
      counts.set(row.show_id, info);
    }
  }

  const albums = rows.filter((row) => row.kind === 'album').map((row) => row.id);
  if (albums.length > 0) {
    for (const id of albums) counts.set(id, counts.get(id) || { trackCount: 0 });
    const placeholders = albums.map(() => '?').join(',');
    const trackRows = db
      .prepare(`SELECT parent_id, COUNT(*) AS n FROM media WHERE hidden = 0 AND kind = 'track' AND parent_id IN (${placeholders}) GROUP BY parent_id`)
      .all(...albums) as { parent_id: number; n: number }[];
    for (const row of trackRows) {
      const info = counts.get(row.parent_id) || {};
      info.trackCount = row.n;
      counts.set(row.parent_id, info);
    }
  }

  return dtos.map((dto, index) => {
    const info = counts.get(rows[index].id);
    return (info ? { ...dto, ...info } : dto) as CountedMedia;
  });
}

function loadMedia(rows: MediaRow[], userId: number): CountedMedia[] {
  return attachCounts(rows, mediaRowsToDTO(rows, userId));
}

/** GET /api/browse — filtered, paginated top-level list. */
browseRouter.get('/', (req, res) => {
  const userId = requireUserId(req);
  const includeChildren = queryBool(req, 'includeChildren') === true;
  const filters = parseBrowseFilters(req, includeChildren);
  const musicOnly = filters.kinds.every((kind) => kind === 'artist' || kind === 'album' || kind === 'track');
  const { orderBy } = parseSort(req, musicOnly ? 'title' : 'added');
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 200 });
  const where = buildWhere(filters, userId);
  const whereSql = where.sql.join(' AND ');
  const db = getDb();

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM media m WHERE ${whereSql}`)
    .get(...where.params) as { total: number };
  const rows = db
    .prepare(`SELECT m.* FROM media m WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...where.params, pageSize, offset) as MediaRow[];

  sendPage(res, loadMedia(rows, userId), totalRow.total, page, pageSize);
});

const HOME_RAIL_KINDS: MediaKind[] = ['movie', 'show', 'album', 'video', 'photo'];

function mediaQuery(kinds: MediaKind[], clause: string, params: unknown[], orderBy: string, limit: number, offset = 0): MediaRow[] {
  const kindSql = kinds.map(() => '?').join(',');
  const where = clause ? ` AND ${clause}` : '';
  return getDb()
    .prepare(`SELECT m.* FROM media m WHERE m.hidden = 0 AND m.kind IN (${kindSql})${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...kinds, ...params, limit, offset) as MediaRow[];
}

function homeCollections(): CollectionDTO[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM collections ORDER BY pinned DESC, sort_order ASC, name COLLATE NOCASE ASC LIMIT 20')
    .all() as CollectionRow[];
  return rows.map((row) => {
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM collection_items ci JOIN media m ON m.id = ci.media_id WHERE ci.collection_id = ? AND m.hidden = 0')
      .get(row.id) as { n: number };
    const artRows = db
      .prepare(
        `SELECT a.media_id, a.kind, a.path, a.source
         FROM collection_items ci
         JOIN media m ON m.id = ci.media_id AND m.hidden = 0
         JOIN media_art a ON a.media_id = ci.media_id
         WHERE ci.collection_id = ?
         ORDER BY ci.sort_order ASC, a.kind = 'poster' DESC
         LIMIT 6`,
      )
      .all(row.id) as { media_id: number; kind: ArtKind; path: string; source: string }[];
    return collectionToDTO(row, { itemCount: count.n, artRows });
  });
}

function attachShowContext(rows: MediaRow[], dtos: MediaDTO[]): MediaDTO[] {
  const episodeRows = rows.filter((row) => row.kind === 'episode');
  if (episodeRows.length === 0) return dtos;
  const db = getDb();
  const ids = episodeRows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const context = db
    .prepare(
      `SELECT e.id AS episode_id, s.id AS season_id, s.title AS season_title, s.season_number AS season_number,
              sh.id AS show_id, sh.title AS show_title
       FROM media e
       JOIN media s ON s.id = e.parent_id
       JOIN media sh ON sh.id = s.parent_id
       WHERE e.id IN (${placeholders})`,
    )
    .all(...ids) as {
    episode_id: number;
    season_id: number;
    season_title: string;
    season_number: number | null;
    show_id: number;
    show_title: string;
  }[];
  const byId = new Map(context.map((row) => [row.episode_id, row]));
  return dtos.map((dto) => {
    const extra = byId.get(dto.id);
    if (!extra) return dto;
    return {
      ...dto,
      showId: extra.show_id,
      showTitle: extra.show_title,
      seasonId: extra.season_id,
      seasonTitle: extra.season_title,
      seasonNumber: dto.seasonNumber ?? extra.season_number,
    } as MediaDTO;
  });
}

function continueWatching(userId: number, limit = 12): MediaDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.* FROM progress p
       JOIN media m ON m.id = p.media_id
       WHERE p.user_id = ? AND p.finished = 0 AND p.position_seconds > 0 AND m.hidden = 0
       ORDER BY p.updated_at DESC LIMIT ?`,
    )
    .all(userId, limit) as MediaRow[];
  return attachShowContext(rows, loadMedia(rows, userId));
}

function preferredGenre(userId: number): string | undefined {
  const db = getDb();
  const watched = db
    .prepare(
      `SELECT g.genre, COUNT(*) AS n
       FROM progress p
       JOIN media m ON m.id = p.media_id AND m.hidden = 0
       JOIN media_genres g ON g.media_id = m.id
       WHERE p.user_id = ? AND m.kind IN ('movie', 'show', 'video', 'episode')
       GROUP BY g.genre COLLATE NOCASE
       ORDER BY n DESC, g.genre COLLATE NOCASE ASC LIMIT 1`,
    )
    .get(userId) as { genre: string } | undefined;
  if (watched) return watched.genre;
  const popular = db
    .prepare(
      `SELECT g.genre, COUNT(*) AS n
       FROM media_genres g
       JOIN media m ON m.id = g.media_id AND m.hidden = 0
       WHERE m.kind IN ('movie', 'show', 'video')
       GROUP BY g.genre COLLATE NOCASE
       ORDER BY n DESC, g.genre COLLATE NOCASE ASC LIMIT 1`,
    )
    .get() as { genre: string } | undefined;
  return popular?.genre;
}

/** GET /api/browse/home — hero, rails, and personal state. Every item is a real row. */
browseRouter.get('/home', (req, res) => {
  const userId = requireUserId(req);
  const db = getDb();
  const memes = req.user?.preferences?.memes !== false;

  const heroRows = mediaQuery(
    ['movie', 'show', 'video'],
    'm.description != \'\'',
    [],
    'm.rating IS NULL ASC, m.rating DESC, m.added_at DESC, m.id ASC',
    6,
  );
  const hero = loadMedia(heroRows, userId);
  const continueItems = continueWatching(userId);
  const recentlyAdded = loadMedia(
    mediaQuery(HOME_RAIL_KINDS, '', [], 'm.added_at DESC, m.id DESC', 16),
    userId,
  );

  const rows: { id: string; title: string; kind: string; items: unknown[] }[] = [];
  if (continueItems.length > 0) {
    rows.push({ id: 'continue', title: 'Continue Watching', kind: 'progress', items: continueItems });
  }
  if (recentlyAdded.length > 0) {
    rows.push({ id: 'recent', title: 'Recently Added', kind: 'mixed', items: recentlyAdded });
  }
  const movies = loadMedia(mediaQuery(['movie'], '', [], 'm.added_at DESC, m.id DESC', 16), userId);
  if (movies.length > 0) rows.push({ id: 'movies', title: 'Movies', kind: 'movie', items: movies });
  const shows = loadMedia(mediaQuery(['show'], '', [], 'm.added_at DESC, m.id DESC', 16), userId);
  if (shows.length > 0) rows.push({ id: 'shows', title: 'Shows', kind: 'show', items: shows });
  const albums = loadMedia(mediaQuery(['album'], '', [], 'm.added_at DESC, m.id DESC', 16), userId);
  if (albums.length > 0) rows.push({ id: 'music', title: memes ? 'Music (for the aux)' : 'Music', kind: 'album', items: albums });

  const collections = homeCollections();
  if (collections.length > 0) {
    const collectionRows = db
      .prepare(
        `SELECT m.* FROM media m
         WHERE m.hidden = 0 AND m.id IN (SELECT media_id FROM collection_items)
         ORDER BY m.added_at DESC, m.id DESC LIMIT 16`,
      )
      .all() as MediaRow[];
    const collectionItems = loadMedia(collectionRows, userId);
    if (collectionItems.length > 0) {
      rows.push({ id: 'collections', title: 'Collections', kind: 'collection', items: collectionItems });
    }
  }

  const genre = preferredGenre(userId);
  if (genre) {
    const genreItems = loadMedia(
      mediaQuery(
        ['movie', 'show', 'video'],
        'EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = m.id AND g.genre = ? COLLATE NOCASE)',
        [genre],
        'm.rating IS NULL ASC, m.rating DESC, m.id ASC',
        12,
      ),
      userId,
    );
    if (genreItems.length > 0) {
      rows.push({
        id: `genre:${genre}`,
        title: memes ? `Because You Like ${genre} (allegedly)` : `Because You Like ${genre}`,
        kind: 'genre',
        items: genreItems,
      });
    }
  }

  const gems = loadMedia(
    mediaQuery(
      ['movie', 'show'],
      'm.rating IS NOT NULL AND m.rating >= 7.5',
      [],
      'RANDOM()',
      12,
    ),
    userId,
  );
  if (gems.length > 0) {
    rows.push({ id: 'gems', title: memes ? 'Certified Bangers' : 'Highly Rated', kind: 'mixed', items: gems });
  }

  // Real fallback rail for odd libraries (e.g. only photos or loose videos).
  if (rows.length === 0) {
    const loose = loadMedia(mediaQuery(TOP_LEVEL_KINDS, '', [], 'RANDOM()', 12), userId);
    if (loose.length > 0) {
      rows.push({ id: 'loose', title: memes ? 'Loose Slop, No Notes' : 'Everything', kind: 'mixed', items: loose });
    }
  }

  const kindCounts = db
    .prepare('SELECT kind, COUNT(*) AS n FROM media WHERE hidden = 0 GROUP BY kind')
    .all() as { kind: MediaKind; n: number }[];
  const counts: Record<string, number> = {};
  for (const row of kindCounts) counts[row.kind] = row.n;
  const watchSeconds = db
    .prepare('SELECT COALESCE(SUM(position_seconds), 0) AS seconds FROM progress WHERE user_id = ?')
    .get(userId) as { seconds: number };
  const libraryCount = db.prepare('SELECT COUNT(*) AS n FROM libraries').get() as { n: number };
  const bytes = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM media WHERE hidden = 0').get() as { n: number };
  const stats = {
    totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0),
    movies: counts.movie || 0,
    shows: counts.show || 0,
    episodes: counts.episode || 0,
    albums: counts.album || 0,
    tracks: counts.track || 0,
    photos: counts.photo || 0,
    watchSeconds: watchSeconds.seconds,
    totalBytes: bytes.n,
    libraries: libraryCount.n,
  };

  res.json({
    hero,
    rows: rows.slice(0, 20),
    continueWatching: continueItems,
    recentlyAdded,
    genres: [...new Set(loadGenres(12))],
    collections,
    stats,
  });
});

function loadGenres(limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT g.genre
       FROM media_genres g
       JOIN media m ON m.id = g.media_id AND m.hidden = 0
       GROUP BY g.genre COLLATE NOCASE
       ORDER BY COUNT(*) DESC, g.genre COLLATE NOCASE ASC
       LIMIT ?`,
    )
    .all(limit) as { genre: string }[];
  return rows.map((row) => row.genre);
}

/** Shared case-insensitive match clause for search (title, aliases, description, genre, cast). */
function searchClause(pattern: string): { clause: string; params: string[] } {
  const clause = `(
    LOWER(m.title) LIKE LOWER(?) ESCAPE '\\'
    OR LOWER(m.sort_title) LIKE LOWER(?) ESCAPE '\\'
    OR LOWER(COALESCE(m.original_title, '')) LIKE LOWER(?) ESCAPE '\\'
    OR LOWER(m.description) LIKE LOWER(?) ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = m.id AND LOWER(g.genre) LIKE LOWER(?) ESCAPE '\\')
    OR EXISTS (SELECT 1 FROM media_people p WHERE p.media_id = m.id AND LOWER(p.name) LIKE LOWER(?) ESCAPE '\\')
  )`;
  return { clause, params: [pattern, pattern, pattern, pattern, pattern, pattern] };
}

function searchGroup(kinds: MediaKind[], clause: string, params: string[], userId: number, limit: number): MediaDTO[] {
  const kindSql = kinds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM media m
       WHERE m.hidden = 0 AND m.kind IN (${kindSql}) AND ${clause}
       ORDER BY
         CASE WHEN LOWER(m.title) LIKE LOWER(?) ESCAPE '\\' THEN 0 ELSE 1 END,
         m.rating IS NULL ASC, m.rating DESC,
         COALESCE(NULLIF(m.sort_title, ''), m.title) COLLATE NOCASE ASC,
         m.id ASC
       LIMIT ?`,
    )
    .all(...kinds, ...params, params[0], limit) as MediaRow[];
  return loadMedia(rows, userId);
}

/** GET /api/browse/search — grouped, case-insensitive results. */
browseRouter.get('/search', (req, res) => {
  const userId = requireUserId(req);
  const q = queryString(req, 'q') || '';
  if (q.length > 120) throw badRequest('Search query is too long. Even the slop has limits (120 chars).');
  const emptyGroups = { movies: [], shows: [], episodes: [], people: [], albums: [], tracks: [], genres: [], videos: [], photos: [], artists: [] };
  if (q.length === 0) {
    res.json({ query: '', items: [], groups: emptyGroups, total: 0 });
    return;
  }

  const db = getDb();
  const pattern = `%${escapeLike(q)}%`;
  const { clause, params } = searchClause(pattern);

  const items = searchGroup(TOP_LEVEL_KINDS, clause, params, userId, 20);
  const movies = searchGroup(['movie'], clause, params, userId, 10);
  const shows = searchGroup(['show'], clause, params, userId, 10);
  const episodes = searchGroup(['episode'], clause, params, userId, 8);
  const albums = searchGroup(['album'], clause, params, userId, 8);
  const tracks = searchGroup(['track'], clause, params, userId, 8);
  const videos = searchGroup(['video'], clause, params, userId, 8);
  const photos = searchGroup(['photo'], clause, params, userId, 8);
  const artists = searchGroup(['artist'], clause, params, userId, 8);

  const personRows = db
    .prepare(
      `SELECT p.name, p.role, COUNT(DISTINCT p.media_id) AS count, MIN(p.media_id) AS media_id
       FROM media_people p
       JOIN media m ON m.id = p.media_id AND m.hidden = 0
       WHERE LOWER(p.name) LIKE LOWER(?) ESCAPE '\\'
       GROUP BY LOWER(p.name), p.role
       ORDER BY count DESC, p.name COLLATE NOCASE ASC
       LIMIT 10`,
    )
    .all(pattern) as { name: string; role: string; count: number; media_id: number }[];
  const sampleIds = personRows.map((row) => row.media_id);
  const sampleRows = sampleIds.length > 0
    ? (db.prepare(`SELECT id, title, kind FROM media WHERE id IN (${sampleIds.map(() => '?').join(',')})`).all(...sampleIds) as {
        id: number;
        title: string;
        kind: MediaKind;
      }[])
    : [];
  const sampleById = new Map(sampleRows.map((row) => [row.id, row]));
  const people = personRows.map((row) => {
    const sample = sampleById.get(row.media_id);
    return {
      name: row.name,
      role: row.role,
      count: row.count,
      mediaId: row.media_id,
      mediaTitle: sample?.title || '',
      mediaKind: sample?.kind || null,
    };
  });

  const genreRows = db
    .prepare(
      `SELECT g.genre AS name, COUNT(DISTINCT g.media_id) AS count
       FROM media_genres g
       JOIN media m ON m.id = g.media_id AND m.hidden = 0
       WHERE LOWER(g.genre) LIKE LOWER(?) ESCAPE '\\'
       GROUP BY g.genre COLLATE NOCASE
       ORDER BY count DESC, g.genre COLLATE NOCASE ASC
       LIMIT 10`,
    )
    .all(pattern) as { name: string; count: number }[];

  const mediaTotal = db
    .prepare(`SELECT COUNT(*) AS n FROM media m WHERE m.hidden = 0 AND ${clause}`)
    .get(...params) as { n: number };
  const personTotal = db
    .prepare(
      `SELECT COUNT(DISTINCT LOWER(p.name)) AS n FROM media_people p
       JOIN media m ON m.id = p.media_id AND m.hidden = 0
       WHERE LOWER(p.name) LIKE LOWER(?) ESCAPE '\\'`,
    )
    .get(pattern) as { n: number };
  const genreTotal = db
    .prepare(
      `SELECT COUNT(DISTINCT LOWER(g.genre)) AS n FROM media_genres g
       JOIN media m ON m.id = g.media_id AND m.hidden = 0
       WHERE LOWER(g.genre) LIKE LOWER(?) ESCAPE '\\'`,
    )
    .get(pattern) as { n: number };

  res.json({
    query: q,
    items,
    groups: { movies, shows, episodes, people, albums, tracks, genres: genreRows, videos, photos, artists },
    total: mediaTotal.n + personTotal.n + genreTotal.n,
  });
});

/** GET /api/browse/filters — everything the filter UI needs, all from real rows. */
browseRouter.get('/filters', (_req, res) => {
  const db = getDb();
  const genres = db
    .prepare(
      `SELECT g.genre
       FROM media_genres g JOIN media m ON m.id = g.media_id AND m.hidden = 0
       GROUP BY g.genre COLLATE NOCASE
       ORDER BY COUNT(*) DESC, g.genre COLLATE NOCASE ASC`,
    )
    .all() as { genre: string }[];
  const tags = db
    .prepare(
      `SELECT t.tag
       FROM media_tags t JOIN media m ON m.id = t.media_id AND m.hidden = 0
       GROUP BY t.tag COLLATE NOCASE
       ORDER BY COUNT(*) DESC, t.tag COLLATE NOCASE ASC`,
    )
    .all() as { tag: string }[];
  const years = db
    .prepare('SELECT MIN(year) AS min, MAX(year) AS max FROM media WHERE hidden = 0 AND year IS NOT NULL')
    .get() as { min: number | null; max: number | null };
  const libraries = db.prepare('SELECT id, name, kind FROM libraries ORDER BY name COLLATE NOCASE ASC').all() as {
    id: number;
    name: string;
    kind: string;
  }[];
  const ratings = db
    .prepare(
      `SELECT DISTINCT content_rating FROM media
       WHERE hidden = 0 AND content_rating IS NOT NULL AND content_rating != ''
       ORDER BY content_rating COLLATE NOCASE ASC`,
    )
    .all() as { content_rating: string }[];
  const yearRange = years.min === null || years.max === null ? [] : [years.min, years.max];
  res.json({
    genres: genres.map((row) => row.genre),
    years: yearRange,
    libraries,
    tags: tags.map((row) => row.tag),
    contentRatings: ratings.map((row) => row.content_rating),
  });
});

const RANDOM_KINDS: MediaKind[] = ['movie', 'show', 'video'];

/** GET /api/browse/random — one movie/show/video that respects the same filters. */
browseRouter.get('/random', (req, res) => {
  const userId = requireUserId(req);
  const filters = parseBrowseFilters(req, false);
  if (queryString(req, 'kind') === undefined) {
    filters.kinds = RANDOM_KINDS;
  } else {
    for (const kind of filters.kinds) {
      if (!RANDOM_KINDS.includes(kind)) {
        throw badRequest(`random only deals in ${RANDOM_KINDS.join(', ')}. "${kind}" is not playable in the fun way.`);
      }
    }
  }
  const where = buildWhere(filters, userId);
  const row = getDb()
    .prepare(`SELECT m.* FROM media m WHERE ${where.sql.join(' AND ')} ORDER BY RANDOM() LIMIT 1`)
    .get(...where.params) as MediaRow | undefined;
  if (!row) {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'No random slop found. Either the library is empty or your filters are too picky.',
      },
    });
    return;
  }
  res.json({ item: loadMedia([row], userId)[0] });
});

/** GET /api/browse/genres/:genre — top-level items in one genre. */
browseRouter.get('/genres/:genre', (req, res) => {
  const userId = requireUserId(req);
  const genre = (req.params.genre || '').trim();
  if (genre.length === 0 || genre.length > 100) throw badRequest('Genre names must be 1–100 characters.');
  const includeChildren = queryBool(req, 'includeChildren') === true;
  const filters = parseBrowseFilters(req, includeChildren);
  filters.genre = genre;
  const musicOnly = filters.kinds.every((kind) => kind === 'artist' || kind === 'album' || kind === 'track');
  const { orderBy } = parseSort(req, musicOnly ? 'title' : 'added');
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 200 });
  const where = buildWhere(filters, userId);
  const db = getDb();
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${where.sql.join(' AND ')}`)
    .get(...where.params) as { n: number };
  const rows = db
    .prepare(`SELECT m.* FROM media m WHERE ${where.sql.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...where.params, pageSize, offset) as MediaRow[];
  res.json({ genre, items: loadMedia(rows, userId), total: total.n, page, pageSize });
});
