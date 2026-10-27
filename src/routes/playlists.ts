import { Router } from 'express';
import type { Request } from 'express';
import { getDb, nowISO } from '../db.ts';
import { HttpError, pageParams, queryBool, queryString, sendPage } from '../lib/http.ts';
import { artUrl, mediaRowsToDTO } from '../lib/dto.ts';
import type { ArtDTO, ArtKind, MediaDTO, MediaKind, MediaRow, PlaylistDTO, PlaylistRow } from '../types.ts';

export const playlistsRouter = Router();

type PlaylistKind = 'mixed' | 'video' | 'audio' | 'photo';

const PLAYLIST_KINDS: Record<PlaylistKind, true> = { mixed: true, video: true, audio: true, photo: true };
const VIDEO_KINDS: Record<string, true> = { movie: true, episode: true, video: true };
const AUDIO_KINDS: Record<string, true> = { track: true };
const PHOTO_KINDS: Record<string, true> = { photo: true };
const MAX_ITEMS = 500;

interface PlaylistRowWithStats extends PlaylistRow {
  item_count: number;
  duration_seconds: number;
}

function itemFits(playlistKind: PlaylistKind, mediaKind: MediaKind): boolean {
  if (playlistKind === 'video') return mediaKind in VIDEO_KINDS;
  if (playlistKind === 'audio') return mediaKind in AUDIO_KINDS;
  if (playlistKind === 'photo') return mediaKind in PHOTO_KINDS;
  return mediaKind in VIDEO_KINDS || mediaKind in AUDIO_KINDS;
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

function requiredString(raw: unknown, label: string, min: number, max: number): string {
  if (typeof raw !== 'string') throw new HttpError(400, `${label} must be a string.`, 'bad_request');
  const trimmed = raw.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, `${label} must be ${min}-${max} characters.`, 'bad_request');
  }
  return trimmed;
}

function optionalDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new HttpError(400, 'description must be a string.', 'bad_request');
  if (raw.length > 2000) throw new HttpError(400, 'description is capped at 2000 characters.', 'bad_request');
  return raw.trim();
}

function playlistKind(raw: unknown): PlaylistKind {
  if (typeof raw !== 'string' || !(raw in PLAYLIST_KINDS)) {
    throw new HttpError(400, "kind must be one of: mixed, video, audio, photo.", 'bad_request');
  }
  return raw as PlaylistKind;
}

function boolValue(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') throw new HttpError(400, `${label} must be a boolean.`, 'bad_request');
  return raw;
}

function mediaIdList(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'mediaIds must be a non-empty array of media ids.', 'bad_request');
  }
  if (raw.length > MAX_ITEMS) throw new HttpError(400, `At most ${MAX_ITEMS} media ids at once.`, 'bad_request');
  const ids: number[] = [];
  for (const entry of raw) {
    const value = typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry) : NaN;
    if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, 'mediaIds contains an invalid id.', 'bad_request');
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

function canSee(row: PlaylistRow, user: { id: number; role: string }): boolean {
  return row.is_public === 1 || row.created_by === user.id || user.role === 'admin';
}

function canEdit(row: PlaylistRow, user: { id: number; role: string }): boolean {
  return row.created_by === user.id || user.role === 'admin';
}

function getPlaylist(id: number): PlaylistRow {
  const row = getDb().prepare('SELECT * FROM playlists WHERE id = ?').get(id) as PlaylistRow | undefined;
  if (!row) throw new HttpError(404, 'That playlist does not exist. Diluted brand.', 'not_found');
  return row;
}

function accessiblePlaylist(id: number, user: { id: number; role: string }): PlaylistRow {
  const row = getPlaylist(id);
  if (!canSee(row, user)) throw new HttpError(403, 'That playlist is private. Not your aux cord.', 'forbidden');
  return row;
}

function editablePlaylist(id: number, user: { id: number; role: string }): PlaylistRow {
  const row = accessiblePlaylist(id, user);
  if (!canEdit(row, user)) throw new HttpError(403, 'Only the owner or an admin can edit this playlist.', 'forbidden');
  return row;
}

function playlistItemIds(id: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT media_id FROM playlist_items WHERE playlist_id = ?
       ORDER BY sort_order ASC, added_at ASC, media_id ASC`,
    )
    .all(id) as { media_id: number }[];
  return rows.map((row) => row.media_id);
}

function firstMedia(id: number): Pick<MediaRow, 'id' | 'updated_at'> | undefined {
  return getDb()
    .prepare(
      `SELECT m.id, m.updated_at FROM playlist_items pi JOIN media m ON m.id = pi.media_id
       WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC, pi.added_at ASC, pi.media_id ASC LIMIT 1`,
    )
    .get(id) as Pick<MediaRow, 'id' | 'updated_at'> | undefined;
}

function artFor(media: Pick<MediaRow, 'id' | 'updated_at'> | undefined): ArtDTO {
  const art: ArtDTO = {};
  if (!media) return art;
  const rows = getDb().prepare('SELECT kind, source FROM media_art WHERE media_id = ?').all(media.id) as {
    kind: ArtKind;
    source: string;
  }[];
  for (const row of rows) art[row.kind] = artUrl(media.id, row.kind, `${row.source}-${media.updated_at}`);
  return art;
}

function toPlaylistDTO(row: PlaylistRowWithStats): PlaylistDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    isPublic: row.is_public === 1,
    createdBy: row.created_by
      ? ((getDb().prepare('SELECT username FROM users WHERE id = ?').get(row.created_by) as { username: string } | undefined)?.username ??
        null)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: row.item_count,
    durationSeconds: Math.round(row.duration_seconds),
    art: artFor(firstMedia(row.id)),
  };
}

function playlistItems(id: number, userId?: number): MediaDTO[] {
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM playlist_items pi JOIN media m ON m.id = pi.media_id
       WHERE pi.playlist_id = ? AND m.hidden = 0
       ORDER BY pi.sort_order ASC, pi.added_at ASC, pi.media_id ASC LIMIT ?`,
    )
    .all(id, MAX_ITEMS) as MediaRow[];
  return mediaRowsToDTO(rows, userId);
}

const STATS_SELECT = `SELECT pl.*,
  (SELECT COUNT(*) FROM playlist_items pi JOIN media m ON m.id = pi.media_id
     WHERE pi.playlist_id = pl.id AND m.hidden = 0) AS item_count,
  (SELECT COALESCE(SUM(COALESCE(m.runtime_seconds, 0)), 0)
     FROM playlist_items pi JOIN media m ON m.id = pi.media_id
     WHERE pi.playlist_id = pl.id AND m.hidden = 0) AS duration_seconds
FROM playlists pl`;

function playlistDTOById(id: number): PlaylistDTO {
  const row = getDb().prepare(`${STATS_SELECT} WHERE pl.id = ?`).get(id) as PlaylistRowWithStats | undefined;
  if (!row) throw new HttpError(404, 'That playlist does not exist. Diluted brand.', 'not_found');
  return toPlaylistDTO(row);
}

/**
 * Every id must exist and match the playlist's kind: video lists take movies/episodes,
 * audio lists take tracks, photo lists take photos, mixed takes video + audio.
 */
function validateItemKinds(ids: number[], kind: PlaylistKind): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, kind, title FROM media WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { id: number; kind: MediaKind; title: string }[];
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new HttpError(400, 'Some media ids do not exist.', 'bad_request', { missing });
  const incompatible = rows.filter((row) => !itemFits(kind, row.kind)).map((row) => ({ id: row.id, kind: row.kind, title: row.title }));
  if (incompatible.length > 0) {
    throw new HttpError(400, `Those items do not fit a ${kind} playlist.`, 'bad_request', { incompatible });
  }
}

playlistsRouter.get('/', (req, res) => {
  const user = req.user!;
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 100 });
  const mineOnly = queryBool(req, 'mine') === true;
  const kindFilter = queryString(req, 'kind');
  const kind = kindFilter === undefined ? undefined : playlistKind(kindFilter);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (mineOnly) {
    clauses.push('pl.created_by = ?');
    params.push(user.id);
  } else if (user.role !== 'admin') {
    clauses.push('(pl.is_public = 1 OR pl.created_by = ?)');
    params.push(user.id);
  }
  if (kind) {
    clauses.push('pl.kind = ?');
    params.push(kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM playlists pl ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${STATS_SELECT} ${where} ORDER BY pl.updated_at DESC, pl.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as PlaylistRowWithStats[];
  sendPage(res, rows.map(toPlaylistDTO), total, page, pageSize);
});

playlistsRouter.post('/', (req, res) => {
  const user = req.user!;
  const input = body(req);
  const name = requiredString(input.name, 'name', 1, 120);
  const description = optionalDescription(input.description);
  const kind = input.kind === undefined ? 'mixed' : playlistKind(input.kind);
  const isPublic = input.isPublic === undefined ? true : boolValue(input.isPublic, 'isPublic');
  const timestamp = nowISO();
  const info = getDb()
    .prepare(
      `INSERT INTO playlists(name, description, kind, is_public, created_by, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, description, kind, isPublic ? 1 : 0, user.id, timestamp, timestamp);
  res.status(201).json(playlistDTOById(Number(info.lastInsertRowid)));
});

playlistsRouter.post('/:id/duplicate', (req, res) => {
  const id = positiveInt(req.params.id, 'id');
  const source = accessiblePlaylist(id, req.user!);
  const db = getDb();
  const suffix = ' (copy)';
  const name = `${source.name.slice(0, 120 - suffix.length)}${suffix}`;
  const timestamp = nowISO();

  const duplicate = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO playlists(name, description, kind, is_public, created_by, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, source.description, source.kind, source.is_public, req.user!.id, timestamp, timestamp);
    const newId = Number(info.lastInsertRowid);
    const items = db
      .prepare(
        `SELECT media_id, sort_order FROM playlist_items WHERE playlist_id = ?
         ORDER BY sort_order ASC, added_at ASC, media_id ASC`,
      )
      .all(id) as { media_id: number; sort_order: number }[];
    const insert = db.prepare('INSERT INTO playlist_items(playlist_id, media_id, sort_order, added_at) VALUES(?, ?, ?, ?)');
    for (const item of items) insert.run(newId, item.media_id, item.sort_order, timestamp);
    return newId;
  });
  res.status(201).json(playlistDTOById(duplicate()));
});

playlistsRouter.get('/:id', (req, res) => {
  const row = accessiblePlaylist(positiveInt(req.params.id, 'id'), req.user!);
  const dto = playlistDTOById(row.id);
  res.json({ ...dto, items: playlistItems(row.id, req.user!.id) });
});

playlistsRouter.patch('/:id', (req, res) => {
  const row = editablePlaylist(positiveInt(req.params.id, 'id'), req.user!);
  const input = body(req);
  const updates: string[] = [];
  const params: unknown[] = [];
  let nextKind = row.kind;

  if (input.name !== undefined) {
    updates.push('name = ?');
    params.push(requiredString(input.name, 'name', 1, 120));
  }
  if (input.description !== undefined) {
    updates.push('description = ?');
    params.push(optionalDescription(input.description));
  }
  if (input.kind !== undefined) {
    nextKind = playlistKind(input.kind);
    if (nextKind !== row.kind) {
      const existing = playlistItemIds(row.id);
      if (existing.length > 0) validateItemKinds(existing, nextKind);
      updates.push('kind = ?');
      params.push(nextKind);
    }
  }
  if (input.isPublic !== undefined) {
    updates.push('is_public = ?');
    params.push(boolValue(input.isPublic, 'isPublic') ? 1 : 0);
  }
  if (updates.length === 0) throw new HttpError(400, 'Nothing to update. Send a field.', 'bad_request');

  updates.push('updated_at = ?');
  params.push(nowISO(), row.id);
  getDb().prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(playlistDTOById(row.id));
});

playlistsRouter.delete('/:id', (req, res) => {
  const row = editablePlaylist(positiveInt(req.params.id, 'id'), req.user!);
  getDb().prepare('DELETE FROM playlists WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

playlistsRouter.post('/:id/items', (req, res) => {
  const row = editablePlaylist(positiveInt(req.params.id, 'id'), req.user!);
  const ids = mediaIdList(body(req).mediaIds);
  const db = getDb();
  const existing = playlistItemIds(row.id);
  if (existing.length + ids.length > MAX_ITEMS) {
    throw new HttpError(400, `Playlists cap at ${MAX_ITEMS} tracks.`, 'bad_request', { cap: MAX_ITEMS });
  }
  validateItemKinds(ids, row.kind);

  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM playlist_items WHERE playlist_id = ?').get(row.id) as {
    n: number;
  }).n;
  const timestamp = nowISO();
  const insert = db.prepare('INSERT OR IGNORE INTO playlist_items(playlist_id, media_id, sort_order, added_at) VALUES(?, ?, ?, ?)');
  const add = db.transaction(() => {
    ids.forEach((mediaId, index) => insert.run(row.id, mediaId, maxSort + 1 + index, timestamp));
  });
  add();
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(timestamp, row.id);
  res.status(201).json({ ok: true, added: ids.length, itemCount: playlistItemIds(row.id).length });
});

playlistsRouter.delete('/:id/items/:mediaId', (req, res) => {
  const row = editablePlaylist(positiveInt(req.params.id, 'id'), req.user!);
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  const db = getDb();
  const info = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?').run(row.id, mediaId);
  if (info.changes === 0) throw new HttpError(404, 'That item is not in this playlist.', 'not_found');
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(nowISO(), row.id);
  res.json({ ok: true, itemCount: playlistItemIds(row.id).length });
});

playlistsRouter.put('/:id/items', (req, res) => {
  const row = editablePlaylist(positiveInt(req.params.id, 'id'), req.user!);
  const ids = mediaIdList(body(req).mediaIds);
  const current = playlistItemIds(row.id);
  const currentSet = new Set(current);
  const unknown = ids.filter((id) => !currentSet.has(id));
  if (unknown.length > 0) {
    throw new HttpError(400, 'Reorder payload includes items not in this playlist.', 'bad_request', { unknown });
  }
  const provided = new Set(ids);
  const order = [...ids, ...current.filter((id) => !provided.has(id))];
  const db = getDb();
  const update = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE playlist_id = ? AND media_id = ?');
  const reorder = db.transaction(() => {
    order.forEach((mediaId, index) => update.run(index, row.id, mediaId));
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(nowISO(), row.id);
  });
  reorder();
  res.json({ ok: true, itemCount: order.length });
});

