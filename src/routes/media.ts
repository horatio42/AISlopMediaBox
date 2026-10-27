import { Router } from 'express';
import { getDb, nowISO } from '../db.ts';
import { isManager, requireAdmin, requireManager } from '../lib/auth.ts';
import { getMediaDTO, getMediaRow, mediaRowsToDTO } from '../lib/dto.ts';
import { badRequest, notFound, pageParams, queryBool, queryInt, queryString, sendPage } from '../lib/http.ts';
import { bus } from '../lib/logger.ts';
import type { MediaDTO, MediaRow, SubtitleRow } from '../types.ts';
import { ensureArtForMedia, downloadRemoteArt, purgeArtForMedia } from '../services/artwork.ts';
import { applyEnrichment, refreshMedia } from '../services/scanner.ts';
import type { Enrichment } from '../services/scanner.ts';
import { tmdbConfigured } from '../services/metadata.ts';
import type { MatchKind } from '../services/metadata.ts';
import { PROVIDER_IDS, providerStatuses, resolveProvider, searchProviders } from '../services/providers.ts';
import type { ProviderCandidate, ProviderId } from '../services/providers.ts';

function visibleRow(id: number, userId: number | undefined, manager: boolean): MediaRow {
  const row = getMediaRow(id);
  if (!row) throw notFound(`Media ${id} does not exist. It has left the building.`);
  if (row.hidden === 1 && !manager) throw notFound(`Media ${id} does not exist. It has left the building.`);
  return row;
}

function rowsToDTO(rows: MediaRow[], userId: number | undefined): MediaDTO[] {
  return mediaRowsToDTO(rows, userId);
}

function subtitlesFor(mediaId: number): SubtitleRow[] {
  return getDb()
    .prepare('SELECT id, media_id, language, label, format, is_external, path, stream_index, forced FROM subtitles WHERE media_id = ? ORDER BY language, label')
    .all(mediaId) as SubtitleRow[];
}

function seasonsOf(showId: number): MediaRow[] {
  return getDb()
    .prepare('SELECT * FROM media WHERE parent_id = ? AND kind = ? AND hidden = 0 ORDER BY season_number, id')
    .all(showId, 'season') as MediaRow[];
}

function episodesOfSeason(seasonId: number): MediaRow[] {
  return getDb()
    .prepare('SELECT * FROM media WHERE parent_id = ? AND kind = ? AND hidden = 0 ORDER BY episode_number, id')
    .all(seasonId, 'episode') as MediaRow[];
}

function episodesOfShow(showId: number): MediaRow[] {
  return getDb()
    .prepare(
      `SELECT e.* FROM media e JOIN media s ON e.parent_id = s.id
       WHERE s.parent_id = ? AND s.kind = 'season' AND e.hidden = 0 AND s.hidden = 0
       ORDER BY e.season_number, e.episode_number, e.id LIMIT 3000`,
    )
    .all(showId) as MediaRow[];
}

function tracksOfAlbum(albumId: number): MediaRow[] {
  return getDb()
    .prepare('SELECT * FROM media WHERE album_id = ? AND kind = ? AND hidden = 0 ORDER BY disc_number, track_number, title COLLATE NOCASE')
    .all(albumId, 'track') as MediaRow[];
}

function tracksOfArtist(artistId: number): MediaRow[] {
  return getDb()
    .prepare("SELECT * FROM media WHERE artist_id = ? AND kind = 'track' AND hidden = 0 ORDER BY title COLLATE NOCASE LIMIT 500")
    .all(artistId) as MediaRow[];
}

function albumsOfArtist(artistId: number): MediaRow[] {
  return getDb()
    .prepare("SELECT * FROM media WHERE artist_id = ? AND kind = 'album' AND hidden = 0 ORDER BY year DESC NULLS LAST, title COLLATE NOCASE")
    .all(artistId) as MediaRow[];
}

function relatedTo(row: MediaRow, userId: number | undefined): MediaDTO[] {
  const db = getDb();
  const genreRows = db.prepare('SELECT genre FROM media_genres WHERE media_id = ? LIMIT 8').all(row.id) as { genre: string }[];
  let relatedRows: MediaRow[] = [];
  if (genreRows.length > 0) {
    const genres = genreRows.map((entry) => entry.genre);
    relatedRows = db
      .prepare(
        `SELECT DISTINCT m.* FROM media m JOIN media_genres g ON g.media_id = m.id
         WHERE g.genre IN (${genres.map(() => '?').join(',')}) AND m.id != ? AND m.hidden = 0
           AND m.kind IN ('movie','show')
         ORDER BY COALESCE(m.rating, 0) DESC, m.added_at DESC LIMIT 12`,
      )
      .all(...genres, row.id) as MediaRow[];
  }
  if (relatedRows.length === 0) {
    relatedRows = db
      .prepare(
        `SELECT * FROM media WHERE library_id = ? AND id != ? AND hidden = 0 AND kind = ?
         ORDER BY COALESCE(rating, 0) DESC, added_at DESC LIMIT 12`,
      )
      .all(row.library_id, row.id, row.kind === 'show' ? 'show' : 'movie') as MediaRow[];
  }
  return rowsToDTO(relatedRows, userId);
}

function nextEpisodeOf(episode: MediaRow): MediaRow | undefined {
  if (episode.kind !== 'episode' || episode.parent_id === null) return undefined;
  const season = getMediaRow(episode.parent_id);
  if (!season || season.parent_id === null) return undefined;
  const seasonNumber = episode.season_number ?? 0;
  const episodeNumber = episode.episode_number ?? 0;
  return getDb()
    .prepare(
      `SELECT e.* FROM media e JOIN media s ON e.parent_id = s.id
       WHERE s.parent_id = ? AND s.kind = 'season' AND e.hidden = 0
         AND (e.season_number > ? OR (e.season_number = ? AND e.episode_number > ?))
       ORDER BY e.season_number, e.episode_number LIMIT 1`,
    )
    .get(season.parent_id, seasonNumber, seasonNumber, episodeNumber) as MediaRow | undefined;
}

function showContext(row: MediaRow): { show?: MediaRow; season?: MediaRow } {
  if (row.kind === 'season') return { show: row.parent_id ? getMediaRow(row.parent_id) : undefined };
  if (row.kind !== 'episode') return {};
  const season = row.parent_id ? getMediaRow(row.parent_id) : undefined;
  const show = season?.parent_id ? getMediaRow(season.parent_id) : undefined;
  return { show, season };
}

/** Movies match themselves; seasons/episodes enrich their parent show. */
function matchTarget(row: MediaRow): { subject: MediaRow; kind: MatchKind } {
  const { show } = showContext(row);
  const subject = row.kind === 'movie' ? row : row.kind === 'show' ? row : show;
  if (!subject || (subject.kind !== 'movie' && subject.kind !== 'show')) {
    throw badRequest('Provider matching supports movies and shows (and their seasons/episodes) only. Music metadata stays local.');
  }
  return { subject, kind: subject.kind === 'show' ? 'show' : 'movie' };
}

function parseProviderId(value: unknown): ProviderId | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (PROVIDER_IDS as string[]).includes(normalized) ? (normalized as ProviderId) : null;
}

export const mediaRouter = Router();

mediaRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid media id');
  const row = visibleRow(id, req.user?.id, isManager(req.user));
  const userId = req.user?.id;
  const item = getMediaDTO(row.id, userId);
  if (!item) throw notFound('Media vanished mid-request. Rude.');
  const { show, season } = showContext(row);
  let seasons: MediaDTO[] = [];
  let episodes: MediaDTO[] = [];
  let tracks: MediaDTO[] = [];
  let albums: MediaDTO[] = [];
  let related: MediaDTO[] = [];
  let nextEpisode: MediaDTO | undefined;

  if (row.kind === 'show') {
    seasons = rowsToDTO(seasonsOf(row.id), userId);
    episodes = rowsToDTO(episodesOfShow(row.id), userId);
    related = relatedTo(row, userId);
  } else if (row.kind === 'season') {
    seasons = show ? rowsToDTO(seasonsOf(show.id), userId) : [];
    episodes = rowsToDTO(episodesOfSeason(row.id), userId);
    if (show) related = relatedTo(show, userId);
  } else if (row.kind === 'episode') {
    episodes = season ? rowsToDTO(episodesOfSeason(season.id), userId) : [];
    seasons = show ? rowsToDTO(seasonsOf(show.id), userId) : [];
    if (show) related = relatedTo(show, userId);
    const next = nextEpisodeOf(row);
    if (next) nextEpisode = getMediaDTO(next.id, userId);
  } else if (row.kind === 'album') {
    tracks = rowsToDTO(tracksOfAlbum(row.id), userId);
  } else if (row.kind === 'artist') {
    tracks = rowsToDTO(tracksOfArtist(row.id), userId);
    albums = rowsToDTO(albumsOfArtist(row.id), userId);
    episodes = [];
  } else if (row.kind === 'track' && row.album_id) {
    tracks = rowsToDTO(tracksOfAlbum(row.album_id), userId);
  } else {
    related = relatedTo(row, userId);
  }

  const artistRow = row.artist_id ? getMediaRow(row.artist_id) : row.kind === 'artist' ? row : undefined;
  const albumRow = row.kind === 'album' ? row : row.album_id ? getMediaRow(row.album_id) : undefined;
  res.json({
    item,
    show: show ? getMediaDTO(show.id, userId) : undefined,
    season: season ? getMediaDTO(season.id, userId) : undefined,
    seasons,
    episodes,
    tracks,
    albums,
    albumCount: albums.length,
    trackCount: tracks.length,
    subtitles: subtitlesFor(row.id),
    related,
    nextEpisode,
    artist: artistRow ? getMediaDTO(artistRow.id, userId) : undefined,
    album: albumRow ? getMediaDTO(albumRow.id, userId) : undefined,
  });
});

mediaRouter.get('/:id/children', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid media id');
  const row = visibleRow(id, req.user?.id, isManager(req.user));
  const { page, pageSize, offset } = pageParams(req);
  const seasonParam = queryInt(req, 'season');
  let source: MediaRow[] = [];
  let total = 0;

  if (row.kind === 'show') {
    if (seasonParam === undefined) {
      source = seasonsOf(row.id);
      total = source.length;
      source = source.slice(offset, offset + pageSize);
    } else {
      const seasonRows = seasonsOf(row.id);
      const target = seasonRows.find((season) => season.season_number === seasonParam);
      if (!target) throw notFound(`No season ${seasonParam} for this show. Check the DVD extras bin.`);
      source = episodesOfSeason(target.id);
      total = source.length;
      source = source.slice(offset, offset + pageSize);
    }
  } else if (row.kind === 'season') {
    source = episodesOfSeason(row.id);
    total = source.length;
    source = source.slice(offset, offset + pageSize);
  } else if (row.kind === 'album') {
    source = tracksOfAlbum(row.id);
    total = source.length;
    source = source.slice(offset, offset + pageSize);
  } else if (row.kind === 'artist') {
    source = albumsOfArtist(row.id);
    total = source.length;
    source = source.slice(offset, offset + pageSize);
  } else {
    total = 0;
  }
  sendPage(res, rowsToDTO(source, req.user?.id), total, page, pageSize);
});

mediaRouter.get('/:id/subtitles', (req, res) => {
  const id = Number(req.params.id);
  const row = visibleRow(id, req.user?.id, isManager(req.user));
  res.json({ items: subtitlesFor(row.id), total: subtitlesFor(row.id).length });
});

mediaRouter.patch('/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  const row = visibleRow(id, req.user?.id, true);
  const body = req.body as Record<string, unknown>;
  const db = getDb();
  const updates: Record<string, unknown> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw badRequest('title must be a string');
    const title = body.title.trim();
    if (title.length === 0 || title.length > 300) throw badRequest('title must be 1-300 characters');
    updates.title = title;
    updates.sort_title = title.toLowerCase().replace(/^(the|an|a)\s+/, '');
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw badRequest('description must be a string');
    if (body.description.length > 5000) throw badRequest('description is too long (5000 chars max)');
    updates.description = body.description.trim();
  }
  if (body.year !== undefined) {
    if (body.year === null) updates.year = null;
    else {
      const year = Number(body.year);
      if (!Number.isInteger(year) || year < 1800 || year > 2200) throw badRequest('year must be 1800-2200 or null');
      updates.year = year;
    }
  }
  if (body.rating !== undefined) {
    if (body.rating === null) updates.rating = null;
    else {
      const rating = Number(body.rating);
      if (!Number.isFinite(rating) || rating < 0 || rating > 10) throw badRequest('rating must be 0-10 or null');
      updates.rating = rating;
    }
  }
  if (body.tagline !== undefined) {
    if (body.tagline !== null && typeof body.tagline !== 'string') throw badRequest('tagline must be a string or null');
    if (typeof body.tagline === 'string' && body.tagline.length > 300) throw badRequest('tagline is too long');
    updates.tagline = body.tagline === null ? null : body.tagline.trim();
  }
  if (body.contentRating !== undefined) {
    if (body.contentRating !== null && typeof body.contentRating !== 'string') throw badRequest('contentRating must be a string or null');
    if (typeof body.contentRating === 'string' && body.contentRating.length > 20) throw badRequest('contentRating is too long');
    updates.content_rating = body.contentRating === null ? null : body.contentRating.trim();
  }
  if (body.metadataLocked !== undefined) {
    if (typeof body.metadataLocked !== 'boolean') throw badRequest('metadataLocked must be boolean');
    updates.metadata_locked = body.metadataLocked ? 1 : 0;
  }
  if (body.genres !== undefined) {
    if (!Array.isArray(body.genres) || body.genres.length > 20 || !body.genres.every((genre) => typeof genre === 'string')) {
      throw badRequest('genres must be an array of up to 20 strings');
    }
    const genres = (body.genres as string[]).map((genre) => genre.trim().slice(0, 60)).filter(Boolean);
    db.prepare('DELETE FROM media_genres WHERE media_id = ?').run(row.id);
    const insert = db.prepare('INSERT OR IGNORE INTO media_genres(media_id, genre) VALUES(?, ?)');
    for (const genre of genres) insert.run(row.id, genre);
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20 || !body.tags.every((tag) => typeof tag === 'string')) {
      throw badRequest('tags must be an array of up to 20 strings');
    }
    const tags = (body.tags as string[]).map((tag) => tag.trim().slice(0, 60)).filter(Boolean);
    db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(row.id);
    const insert = db.prepare('INSERT OR IGNORE INTO media_tags(media_id, tag) VALUES(?, ?)');
    for (const tag of tags) insert.run(row.id, tag);
  }
  if (body.people !== undefined) {
    if (!Array.isArray(body.people) || body.people.length > 80) throw badRequest('people must be an array of up to 80 entries');
    const people: { name: string; role: string; character: string | null }[] = [];
    for (const entry of body.people as unknown[]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest('Each person must be { name, role, character? }');
      const person = entry as Record<string, unknown>;
      if (typeof person.name !== 'string' || person.name.trim().length === 0 || person.name.length > 120) throw badRequest('person.name must be 1-120 characters');
      if (person.role !== undefined && (typeof person.role !== 'string' || person.role.length > 40)) throw badRequest('person.role must be a string up to 40 characters');
      if (person.character !== undefined && person.character !== null && (typeof person.character !== 'string' || person.character.length > 200)) {
        throw badRequest('person.character must be a string up to 200 characters or null');
      }
      people.push({
        name: person.name.trim(),
        role: typeof person.role === 'string' && person.role.trim() ? person.role.trim() : 'cast',
        character: typeof person.character === 'string' && person.character.trim() ? person.character.trim() : null,
      });
    }
    db.prepare('DELETE FROM media_people WHERE media_id = ?').run(row.id);
    const insert = db.prepare('INSERT INTO media_people(media_id, name, role, character, ord) VALUES(?, ?, ?, ?, ?)');
    people.forEach((person, index) => insert.run(row.id, person.name, person.role, person.character, index));
  }
  if (Object.keys(updates).length > 0) {
    updates.updated_at = nowISO();
    const columns = Object.keys(updates);
    db.prepare(`UPDATE media SET ${columns.map((column) => `${column} = @${column}`).join(', ')} WHERE id = @id`).run({ ...updates, id: row.id });
  }
  bus.publish('media.changed', { mediaId: row.id, kind: row.kind, edited: true });
  void ensureArtForMedia(row.id).catch(() => undefined);
  res.json({ ok: true, item: getMediaDTO(row.id, req.user?.id) });
});

mediaRouter.delete('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = visibleRow(id, req.user?.id, true);
  const db = getDb();
  if (queryBool(req, 'hard')) {
    const descendants = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM media WHERE id = ?
           UNION ALL
           SELECT m.id FROM media m JOIN tree t ON m.parent_id = t.id
         ) SELECT id FROM tree`,
      )
      .all(row.id) as { id: number }[];
    for (const entry of descendants) purgeArtForMedia(entry.id);
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    bus.publish('media.changed', { mediaId: row.id, removed: true, count: descendants.length });
    res.json({ ok: true, hard: true, removed: descendants.length, sourceFiles: 'living rent-free on disk, untouched' });
    return;
  }
  db.prepare('UPDATE media SET hidden = 1, updated_at = ? WHERE id = ?').run(nowISO(), row.id);
  bus.publish('media.changed', { mediaId: row.id, hidden: true });
  res.json({ ok: true, hidden: true, sourceFiles: 'still on disk, obviously' });
});

mediaRouter.post('/:id/refresh', requireManager, async (req, res) => {
  const row = visibleRow(Number(req.params.id), req.user?.id, true);
  const result = await refreshMedia(row.id);
  res.json({ ok: result.ok, warnings: result.warnings, item: getMediaDTO(row.id, req.user?.id) });
});

mediaRouter.get('/:id/matches', requireManager, async (req, res) => {
  const row = visibleRow(Number(req.params.id), req.user?.id, true);
  const { subject } = matchTarget(row);
  const kindParam = queryString(req, 'kind')?.trim().toLowerCase();
  if (kindParam && kindParam !== 'movie' && kindParam !== 'show') throw badRequest('kind must be "movie" or "show"');
  const kind: MatchKind = kindParam === 'movie' || kindParam === 'show' ? kindParam : subject.kind === 'show' ? 'show' : 'movie';
  const query = (queryString(req, 'query')?.trim() || subject.title || '').slice(0, 200);
  const year = queryInt(req, 'year') ?? subject.year;
  const candidates = await searchProviders(kind, query, year, { limit: queryInt(req, 'limit') ?? 8, manual: true });
  res.json({
    ok: true,
    targetId: subject.id,
    kind,
    query,
    year,
    providers: providerStatuses(),
    candidates,
  });
});

mediaRouter.post('/:id/match', requireManager, async (req, res) => {
  const row = visibleRow(Number(req.params.id), req.user?.id, true);
  const body = req.body as Record<string, unknown>;
  const requestedProvider = body.provider !== undefined ? parseProviderId(body.provider) : undefined;
  if (body.provider !== undefined && !requestedProvider) {
    throw badRequest(`provider must be one of: ${PROVIDER_IDS.join(', ')}`, { allowed: PROVIDER_IDS });
  }
  const legacy = body.provider === undefined;
  // Legacy numeric TMDB ids keep the old "key required" contract.
  if (legacy && !tmdbConfigured()) {
    res.json({
      ok: false,
      matched: false,
      reason: 'tmdb_not_configured',
      matchScore: null,
      providers: providerStatuses(),
      message: 'No TMDB key configured. Local NFO inference still works; add a key in Admin → Settings to summon the cloud.',
    });
    return;
  }
  const { subject, kind } = matchTarget(row);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : '';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
  const wantedTitle = title || subject.title;
  let wantedYear = subject.year;
  if (body.year !== undefined) {
    if (body.year === null) wantedYear = null;
    else {
      const year = Number(body.year);
      if (!Number.isInteger(year) || year < 1800 || year > 2200) throw badRequest('year must be 1800-2200 or null');
      wantedYear = year;
    }
  }
  const rawProviderId = body.providerId !== undefined ? body.providerId : body.id !== undefined ? body.id : body.tmdbId;
  const providerId = rawProviderId !== undefined && rawProviderId !== null ? String(rawProviderId).trim() : '';
  if (!providerId && !query) throw badRequest('Pass { provider, providerId } or { query } to match (legacy: { id } / { tmdbId })');
  if (providerId && !/^[A-Za-z0-9._-]{1,64}$/.test(providerId)) throw badRequest('providerId must be 1-64 characters (letters, numbers, dot, dash, underscore)');

  const provider: ProviderId = requestedProvider ?? 'tmdb';
  if (legacy && providerId && !/^\d{1,10}$/.test(providerId)) throw badRequest('TMDB id must be numeric');

  let candidates: ProviderCandidate[] = [];
  let remote = null;
  if (providerId) {
    remote = await resolveProvider(provider, kind, providerId, wantedTitle, wantedYear, { manual: true });
  } else {
    candidates = await searchProviders(kind, query, wantedYear, { limit: 8, manual: true });
    if (requestedProvider) candidates = candidates.filter((candidate) => candidate.provider === requestedProvider);
    const best = candidates[0];
    if (best) remote = await resolveProvider(best.provider, kind, best.providerId, wantedTitle, wantedYear, { manual: true });
  }
  if (!remote) {
    res.json({ ok: false, matched: false, reason: 'no_match', matchScore: 0, provider, providers: providerStatuses(), candidates });
    return;
  }
  const enrichment: Enrichment = {
    title: remote.title,
    originalTitle: remote.originalTitle,
    year: remote.year,
    releaseDate: remote.releaseDate,
    description: remote.description,
    tagline: remote.tagline,
    rating: remote.rating,
    contentRating: remote.contentRating,
    runtimeSeconds: remote.runtimeSeconds,
    genres: remote.genres,
    tags: remote.tags,
    people: remote.people,
    provider: remote.provider,
    providerId: remote.providerId,
    matchScore: remote.matchScore,
  };
  applyEnrichment(subject.id, enrichment, true);
  if (remote.posterUrl) await downloadRemoteArt(subject.id, 'poster', remote.posterUrl, remote.provider);
  if (remote.backdropUrl) await downloadRemoteArt(subject.id, 'backdrop', remote.backdropUrl, remote.provider);
  await ensureArtForMedia(subject.id);
  bus.publish('media.changed', { mediaId: subject.id, kind: subject.kind, matched: true });
  res.json({
    ok: true,
    matched: true,
    provider: remote.provider,
    providerId: remote.providerId,
    matchScore: remote.matchScore,
    targetId: subject.id,
    candidates,
    item: getMediaDTO(subject.id, req.user?.id),
  });
});
