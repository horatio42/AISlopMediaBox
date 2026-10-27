import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, nowISO } from '../db.ts';
import { HttpError, pageParams, queryInt, queryString, sendPage } from '../lib/http.ts';
import { mediaRowsToDTO } from '../lib/dto.ts';
import type { MediaDTO, MediaKind, MediaRow, ProgressRow } from '../types.ts';

/**
 * Mounted three times in server.ts:
 *   /api/progress  — write/read progress, state, favorites, stats
 *   /api/continue  — resume rail (episode-aware, one entry per show)
 *   /api/history   — watched/progressed list
 * The bare `GET /` and `GET /stats` dispatch on the mount prefix.
 */
export const progressRouter = Router();

const MEDIA_KINDS: Record<MediaKind, true> = {
  movie: true,
  show: true,
  season: true,
  episode: true,
  artist: true,
  album: true,
  track: true,
  photo: true,
  video: true,
};

type Section = 'progress' | 'continue' | 'history';

function section(req: Request): Section {
  const base = req.baseUrl.split('?')[0];
  if (base.endsWith('/continue')) return 'continue';
  if (base.endsWith('/history')) return 'history';
  return 'progress';
}

function requireSection(req: Request, expected: Section): void {
  if (section(req) !== expected) throw new HttpError(404, 'Wrong door, chief.', 'not_found');
}

function body(req: Request): Record<string, unknown> {
  const raw: unknown = req.body;
  const result: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) result[key] = value;
  return result;
}

function positiveInt(raw: unknown, label = 'id'): number {
  const value = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, `Invalid ${label}.`, 'bad_request');
  return value;
}

function finiteNumber(raw: unknown, label: string, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) throw new HttpError(400, `${label} must be a number.`, 'bad_request');
  if (value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`, 'bad_request');
  return value;
}

function getMedia(id: number): MediaRow {
  const row = getDb().prepare('SELECT * FROM media WHERE id = ? AND hidden = 0').get(id) as MediaRow | undefined;
  if (!row) throw new HttpError(404, 'That media does not exist. Imaginary rizz.', 'not_found');
  return row;
}

function progressDTO(row: ProgressRow) {
  return {
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    finished: Boolean(row.finished),
    playCount: row.play_count,
    updatedAt: row.updated_at,
    episodeId: row.episode_id,
  };
}

function readState(userId: number, mediaId: number) {
  const row = getDb()
    .prepare('SELECT favorite, watched, rating FROM item_state WHERE user_id = ? AND media_id = ?')
    .get(userId, mediaId) as { favorite: number; watched: number; rating: number | null } | undefined;
  return {
    favorite: Boolean(row?.favorite ?? 0),
    watched: Boolean(row?.watched ?? 0),
    rating: row?.rating ?? null,
  };
}

interface StatePatch {
  favorite?: boolean;
  watched?: boolean;
  rating?: number | null;
}

function writeState(userId: number, mediaId: number, patch: StatePatch): { favorite: boolean; watched: boolean; rating: number | null } {
  const db = getDb();
  const existing = readState(userId, mediaId);
  const favorite = patch.favorite === undefined ? existing.favorite : patch.favorite;
  const watched = patch.watched === undefined ? existing.watched : patch.watched;
  const rating = patch.rating === undefined ? existing.rating : patch.rating;
  db.prepare(
    `INSERT INTO item_state(user_id, media_id, favorite, watched, rating, updated_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, media_id) DO UPDATE SET
       favorite = excluded.favorite,
       watched = excluded.watched,
       rating = excluded.rating,
       updated_at = excluded.updated_at`,
  ).run(userId, mediaId, favorite ? 1 : 0, watched ? 1 : 0, rating, nowISO());
  return { favorite, watched, rating };
}

progressRouter.get('/', (req, res) => {
  const where = section(req);
  if (where === 'continue') return continueList(req, res);
  if (where === 'history') return historyList(req, res);
  return statsHandler(req, res);
});

// Keep the resume rail explicit for clients that prefer /api/progress routes.
progressRouter.get('/continue', (req, res) => {
  requireSection(req, 'progress');
  continueList(req, res);
});

progressRouter.get('/history', (req, res) => {
  requireSection(req, 'progress');
  historyList(req, res);
});

progressRouter.get('/stats', (req, res) => {
  requireSection(req, 'progress');
  statsHandler(req, res);
});

progressRouter.put('/:mediaId', (req, res) => {
  requireSection(req, 'progress');
  const user = req.user!;
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  const media = getMedia(mediaId);
  const input = body(req);

  if (input.positionSeconds === undefined && input.position === undefined) {
    throw new HttpError(400, 'positionSeconds is required.', 'bad_request');
  }
  const position = finiteNumber(input.positionSeconds ?? input.position, 'positionSeconds', 0, 60 * 60 * 24 * 7);
  const durationInput = input.durationSeconds ?? input.duration;
  const db = getDb();

  let duration = durationInput === undefined ? 0 : finiteNumber(durationInput, 'durationSeconds', 0, 60 * 60 * 24 * 365);
  if (duration === 0) duration = media.runtime_seconds ?? 0;
  const positionSeconds = duration > 0 ? Math.min(position, duration) : position;
  const autoFinished = duration >= 60 && (positionSeconds >= duration * 0.9 || duration - positionSeconds <= 30);
  const finished = input.finished === true || autoFinished;

  let episodeId: number | null = null;
  if (media.kind === 'episode') episodeId = media.id;
  else if (input.episodeId !== undefined && input.episodeId !== null) {
    const candidate = positiveInt(input.episodeId, 'episodeId');
    const episode = db.prepare("SELECT id FROM media WHERE id = ? AND kind = 'episode' AND hidden = 0").get(candidate) as
      | { id: number }
      | undefined;
    if (!episode) throw new HttpError(400, 'episodeId is not an episode.', 'bad_request');
    episodeId = episode.id;
  }

  const upsert = db.transaction((): ProgressRow => {
    const existing = db
      .prepare('SELECT * FROM progress WHERE user_id = ? AND media_id = ?')
      .get(user.id, mediaId) as ProgressRow | undefined;
    const playCount = existing ? existing.play_count + (finished && !existing.finished ? 1 : 0) : 1;
    const updatedAt = nowISO();
    db.prepare(
      `INSERT INTO progress(user_id, media_id, episode_id, position_seconds, duration_seconds, finished, play_count, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, media_id) DO UPDATE SET
         episode_id = excluded.episode_id,
         position_seconds = excluded.position_seconds,
         duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE progress.duration_seconds END,
         finished = excluded.finished,
         play_count = excluded.play_count,
         updated_at = excluded.updated_at`,
    ).run(user.id, mediaId, episodeId, positionSeconds, duration, finished ? 1 : 0, playCount, updatedAt);

    if (finished) {
      db.prepare(
        `INSERT INTO item_state(user_id, media_id, favorite, watched, updated_at)
         VALUES(?, ?, 0, 1, ?)
         ON CONFLICT(user_id, media_id) DO UPDATE SET watched = 1, updated_at = excluded.updated_at`,
      ).run(user.id, mediaId, updatedAt);
    }
    return {
      user_id: user.id,
      media_id: mediaId,
      episode_id: episodeId,
      position_seconds: positionSeconds,
      duration_seconds: duration,
      finished: finished ? 1 : 0,
      play_count: playCount,
      updated_at: updatedAt,
    };
  });

  const progress = upsert();
  res.json({ ok: true, progress: progressDTO(progress), state: readState(user.id, mediaId) });
});

progressRouter.get('/:mediaId', (req, res) => {
  requireSection(req, 'progress');
  const user = req.user!;
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  const media = getMedia(mediaId);
  const row = getDb()
    .prepare('SELECT * FROM progress WHERE user_id = ? AND media_id = ?')
    .get(user.id, mediaId) as ProgressRow | undefined;
  res.json({
    progress: row ? progressDTO(row) : null,
    state: readState(user.id, mediaId),
    durationSeconds: row?.duration_seconds ?? media.runtime_seconds ?? 0,
  });
});

progressRouter.delete('/:mediaId', (req, res) => {
  requireSection(req, 'progress');
  const user = req.user!;
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  const info = getDb()
    .prepare('UPDATE progress SET position_seconds = 0, updated_at = ? WHERE user_id = ? AND media_id = ?')
    .run(nowISO(), user.id, mediaId);
  if (info.changes === 0) throw new HttpError(404, 'No resume point to clear. Nothing to see here.', 'not_found');
  res.json({ ok: true });
});

progressRouter.put('/:mediaId/state', (req, res) => {
  requireSection(req, 'progress');
  const user = req.user!;
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  getMedia(mediaId);
  const input = body(req);
  const patch: StatePatch = {};

  if (input.favorite !== undefined) {
    if (typeof input.favorite !== 'boolean') throw new HttpError(400, 'favorite must be a boolean.', 'bad_request');
    patch.favorite = input.favorite;
  }
  if (input.watched !== undefined) {
    if (typeof input.watched !== 'boolean') throw new HttpError(400, 'watched must be a boolean.', 'bad_request');
    patch.watched = input.watched;
  }
  if (input.rating !== undefined) {
    if (input.rating === null) patch.rating = null;
    else patch.rating = finiteNumber(input.rating, 'rating', 0, 10);
  }
  if (patch.favorite === undefined && patch.watched === undefined && patch.rating === undefined) {
    throw new HttpError(400, 'Send favorite, watched, or rating. Pick a lane.', 'bad_request');
  }

  const db = getDb();
  const apply = db.transaction(() => {
    const state = writeState(user.id, mediaId, patch);
    if (patch.watched !== undefined) {
      const media = getMedia(mediaId);
      const existing = db
        .prepare('SELECT * FROM progress WHERE user_id = ? AND media_id = ?')
        .get(user.id, mediaId) as ProgressRow | undefined;
      const updatedAt = nowISO();
      const runtime = media.runtime_seconds ?? 0;
      if (patch.watched) {
        if (existing) {
          db.prepare(
            `UPDATE progress SET finished = 1,
               position_seconds = CASE WHEN duration_seconds >= 60 THEN duration_seconds ELSE position_seconds END,
               updated_at = ? WHERE user_id = ? AND media_id = ?`,
          ).run(updatedAt, user.id, mediaId);
        } else {
          db.prepare(
            `INSERT INTO progress(user_id, media_id, episode_id, position_seconds, duration_seconds, finished, play_count, updated_at)
             VALUES(?, ?, ?, ?, ?, 1, 1, ?)`,
          ).run(user.id, mediaId, media.kind === 'episode' ? media.id : null, runtime, runtime, updatedAt);
        }
      } else if (existing) {
        db.prepare('UPDATE progress SET finished = 0, position_seconds = 0, updated_at = ? WHERE user_id = ? AND media_id = ?').run(
          updatedAt,
          user.id,
          mediaId,
        );
      }
    }
    return state;
  });

  res.json({ ok: true, ...apply() });
});

progressRouter.post('/:mediaId/favorite', (req, res) => {
  requireSection(req, 'progress');
  const user = req.user!;
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  getMedia(mediaId);
  const current = readState(user.id, mediaId);
  const state = writeState(user.id, mediaId, { favorite: !current.favorite });
  res.json({ ok: true, favorite: state.favorite });
});

interface ContinueEntry extends MediaDTO {
  showId: number | null;
  show: MediaDTO | null;
}

function continueList(req: Request, res: Response): void {
  const user = req.user!;
  const limit = Math.max(1, Math.min(queryInt(req, 'limit') ?? 20, 50));
  const db = getDb();

  const progressRows = db
    .prepare(
      `SELECT p.media_id, m.parent_id, m.kind
       FROM progress p JOIN media m ON m.id = p.media_id
       WHERE p.user_id = ? AND m.hidden = 0 AND p.finished = 0 AND p.position_seconds > 5
       ORDER BY p.updated_at DESC, p.media_id DESC LIMIT 200`,
    )
    .all(user.id) as { media_id: number; parent_id: number | null; kind: MediaKind }[];
  if (progressRows.length === 0) {
    res.json({ items: [], total: 0 });
    return;
  }

  const mediaIds = [...new Set(progressRows.map((row) => row.media_id))];
  const mediaRows = db
    .prepare(`SELECT * FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`)
    .all(...mediaIds) as MediaRow[];
  const dtoById = new Map(mediaRowsToDTO(mediaRows, user.id).map((dto) => [dto.id, dto]));
  const rowById = new Map(mediaRows.map((row) => [row.id, row]));

  // Episode → season → show. Shows are synthetic containers; episodes own the progress.
  const parentIds = [...new Set(progressRows.map((row) => row.parent_id).filter((id): id is number => typeof id === 'number'))];
  const parentRows =
    parentIds.length > 0
      ? (db.prepare(`SELECT * FROM media WHERE id IN (${parentIds.map(() => '?').join(',')})`).all(...parentIds) as MediaRow[])
      : [];
  const parentById = new Map(parentRows.map((row) => [row.id, row]));

  const showIds = new Set<number>();
  for (const row of progressRows) {
    if (row.kind !== 'episode' || row.parent_id === null) continue;
    const parent = parentById.get(row.parent_id);
    if (parent?.kind === 'show') showIds.add(parent.id);
    else if (parent?.kind === 'season' && parent.parent_id !== null) showIds.add(parent.parent_id);
  }
  const showRows =
    showIds.size > 0
      ? (db.prepare(`SELECT * FROM media WHERE id IN (${[...showIds].map(() => '?').join(',')})`).all(...showIds) as MediaRow[])
      : [];
  const showDtoById = new Map(mediaRowsToDTO(showRows).map((dto) => [dto.id, dto]));

  const seen = new Set<string>();
  const entries: ContinueEntry[] = [];
  for (const progressRow of progressRows) {
    const dto = dtoById.get(progressRow.media_id);
    const media = rowById.get(progressRow.media_id);
    if (!dto || !media) continue;

    let showId: number | null = null;
    if (media.kind === 'episode' && media.parent_id !== null) {
      const parent = parentById.get(media.parent_id);
      if (parent?.kind === 'show') showId = parent.id;
      else if (parent?.kind === 'season' && parent.parent_id !== null) showId = parent.parent_id;
    }
    const key = showId !== null ? `show:${showId}` : `media:${media.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      ...dto,
      showId,
      show: showId !== null ? showDtoById.get(showId) ?? null : null,
    });
  }

  res.json({ items: entries.slice(0, limit), total: entries.length, limit });
}

function historyList(req: Request, res: Response): void {
  const user = req.user!;
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 100 });
  const kindFilter = queryString(req, 'kind');
  if (kindFilter !== undefined && !(kindFilter in MEDIA_KINDS)) {
    throw new HttpError(400, `Unknown kind: ${kindFilter}.`, 'bad_request');
  }

  const clauses = ['p.user_id = ?', 'm.hidden = 0', '(p.finished = 1 OR p.position_seconds > 0)'];
  const params: unknown[] = [user.id];
  if (kindFilter) {
    clauses.push('m.kind = ?');
    params.push(kindFilter);
  }
  const where = clauses.join(' AND ');
  const db = getDb();
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM progress p JOIN media m ON m.id = p.media_id WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT m.* FROM progress p JOIN media m ON m.id = p.media_id
       WHERE ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as MediaRow[];
  sendPage(res, mediaRowsToDTO(rows, user.id), total, page, pageSize);
}

function statsHandler(req: Request, res: Response): void {
  const userId = req.user!.id;
  const db = getDb();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(play_count), 0) AS plays,
              COALESCE(SUM(CASE WHEN finished = 1
                THEN CASE WHEN duration_seconds > position_seconds THEN duration_seconds ELSE position_seconds END
                ELSE position_seconds END), 0) AS seconds,
              MAX(updated_at) AS last_at
       FROM progress WHERE user_id = ?`,
    )
    .get(userId) as { items: number; plays: number; seconds: number; last_at: string | null };

  const kindRows = db
    .prepare(
      `SELECT m.kind, COUNT(*) AS n FROM progress p JOIN media m ON m.id = p.media_id
       WHERE p.user_id = ? AND p.finished = 1 GROUP BY m.kind`,
    )
    .all(userId) as { kind: MediaKind; n: number }[];
  const finishedByKind: Record<string, number> = {};
  for (const row of kindRows) finishedByKind[row.kind] = row.n;

  const stateCounts = db
    .prepare(
      `SELECT COALESCE(SUM(favorite), 0) AS favorites,
              COALESCE(SUM(watched), 0) AS watched,
              COALESCE(SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END), 0) AS rated
       FROM item_state WHERE user_id = ?`,
    )
    .get(userId) as { favorites: number; watched: number; rated: number };

  const topGenres = db
    .prepare(
      `SELECT g.genre AS genre, COUNT(*) AS items,
              COALESCE(SUM(CASE WHEN p.finished = 1
                THEN CASE WHEN p.duration_seconds > p.position_seconds THEN p.duration_seconds ELSE p.position_seconds END
                ELSE p.position_seconds END), 0) AS seconds
       FROM progress p JOIN media_genres g ON g.media_id = p.media_id
       WHERE p.user_id = ? GROUP BY g.genre ORDER BY seconds DESC, items DESC LIMIT 5`,
    )
    .all(userId) as { genre: string; items: number; seconds: number }[];

  const dayRows = db
    .prepare('SELECT DISTINCT substr(updated_at, 1, 10) AS day FROM progress WHERE user_id = ? ORDER BY day ASC')
    .all(userId) as { day: string }[];
  const days = dayRows.map((row) => row.day);
  const daySet = new Set(days);

  let streakDays = 0;
  const cursor = new Date();
  // A streak survives until a full day is missed; start today, fall back to yesterday.
  if (!daySet.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (daySet.has(cursor.toISOString().slice(0, 10))) {
    streakDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let longestStreakDays = 0;
  let run = 0;
  let previous = 0;
  for (const day of days) {
    const current = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(current)) continue;
    run = previous > 0 && current - previous === 86_400_000 ? run + 1 : 1;
    if (run > longestStreakDays) longestStreakDays = run;
    previous = current;
  }

  res.json({
    totalSeconds: Math.round(totals.seconds),
    totalMinutes: Math.round(totals.seconds / 60),
    totalHours: Math.round((totals.seconds / 3600) * 10) / 10,
    itemsStarted: totals.items,
    playCount: totals.plays,
    favorites: stateCounts.favorites,
    watched: stateCounts.watched,
    rated: stateCounts.rated,
    finished: {
      movies: finishedByKind.movie ?? 0,
      episodes: finishedByKind.episode ?? 0,
      tracks: finishedByKind.track ?? 0,
      videos: finishedByKind.video ?? 0,
      total: Object.values(finishedByKind).reduce((sum, n) => sum + n, 0),
    },
    topGenres: topGenres.map((row) => ({ genre: row.genre, items: row.items, seconds: Math.round(row.seconds) })),
    streakDays,
    longestStreakDays,
    lastActivityAt: totals.last_at,
  });
}
