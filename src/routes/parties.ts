import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getDb, nowISO, settings } from '../db.ts';
import { HttpError, pageParams, queryInt, sendPage } from '../lib/http.ts';
import { mediaRowsToDTO, playableKind } from '../lib/dto.ts';
import { bus } from '../lib/logger.ts';
import type { MediaDTO, MediaRow, PartyRow } from '../types.ts';

export const partiesRouter = Router();

const MAX_MEMBERS = 20;
const MAX_POSITION = 60 * 60 * 24;

let partySchemaReady = false;

/**
 * parties has no membership table in schema.sql, so the Social slice adds one
 * lazily. Additive + idempotent; no core schema edits.
 */
function ensurePartySchema(): void {
  if (partySchemaReady) return;
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS party_members (
       party_id  TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
       user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       joined_at TEXT NOT NULL,
       PRIMARY KEY (party_id, user_id)
     )`,
  );
  partySchemaReady = true;
}

interface MemberDTO {
  userId: number;
  username: string;
  displayName: string;
  avatarHue: number;
  isHost: boolean;
  joinedAt: string;
}

interface PartyDTO {
  id: string;
  name: string;
  hostId: number | null;
  host: { id: number; username: string; displayName: string; avatarHue: number } | null;
  mediaId: number | null;
  media: MediaDTO | null;
  position: number;
  paused: boolean;
  isActive: boolean;
  memberCount: number;
  members: MemberDTO[];
  isHost: boolean;
  createdAt: string;
  updatedAt: string;
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

function partyId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new HttpError(400, 'Invalid party id.', 'bad_request');
  }
  return raw;
}

function userSummary(id: number) {
  const row = getDb().prepare('SELECT id, username, display_name, avatar_hue FROM users WHERE id = ?').get(id) as
    | { id: number; username: string; display_name: string; avatar_hue: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, avatarHue: row.avatar_hue };
}

function getParty(id: string): PartyRow {
  const row = getDb().prepare('SELECT * FROM parties WHERE id = ?').get(id) as PartyRow | undefined;
  if (!row) throw new HttpError(404, 'That party is over. F.', 'not_found');
  return row;
}

function partyMembers(partyIdValue: string): MemberDTO[] {
  const rows = getDb()
    .prepare(
      `SELECT pm.user_id, pm.joined_at, u.username, u.display_name, u.avatar_hue
       FROM party_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.party_id = ? ORDER BY pm.joined_at ASC, pm.user_id ASC`,
    )
    .all(partyIdValue) as { user_id: number; joined_at: string; username: string; display_name: string; avatar_hue: number }[];
  return rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    isHost: false,
    joinedAt: row.joined_at,
  }));
}

function memberCount(partyIdValue: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?').get(partyIdValue) as { n: number }).n;
}

function partyDTO(row: PartyRow, viewerId: number, includeMembers: boolean): PartyDTO {
  const hostId = row.host_id;
  const members = includeMembers ? partyMembers(row.id) : [];
  if (hostId !== null) for (const member of members) member.isHost = member.userId === hostId;
  let media: MediaDTO | null = null;
  if (row.media_id !== null) {
    const mediaRow = getDb().prepare('SELECT * FROM media WHERE id = ?').get(row.media_id) as MediaRow | undefined;
    if (mediaRow) media = mediaRowsToDTO([mediaRow], viewerId)[0] ?? null;
  }
  return {
    id: row.id,
    name: row.name,
    hostId,
    host: hostId !== null ? userSummary(hostId) : null,
    mediaId: row.media_id,
    media,
    position: row.position,
    paused: Boolean(row.paused),
    isActive: Boolean(row.is_active),
    memberCount: includeMembers ? members.length : memberCount(row.id),
    members,
    isHost: hostId === viewerId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publishSync(row: PartyRow): void {
  bus.publish('party.sync', {
    partyId: row.id,
    mediaId: row.media_id,
    position: row.position,
    paused: Boolean(row.paused),
    updatedAt: row.updated_at,
  });
}

partiesRouter.get('/', (req, res) => {
  ensurePartySchema();
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 24, maxPageSize: 100 });
  const mediaId = queryInt(req, 'mediaId');
  if (mediaId !== undefined && mediaId <= 0) throw new HttpError(400, 'Invalid mediaId.', 'bad_request');
  const clauses = ['is_active = 1'];
  const params: unknown[] = [];
  if (mediaId !== undefined) {
    clauses.push('media_id = ?');
    params.push(mediaId);
  }
  const where = clauses.join(' AND ');
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM parties WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM parties WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as PartyRow[];
  sendPage(
    res,
    rows.map((row) => partyDTO(row, req.user!.id, false)),
    total,
    page,
    pageSize,
  );
});

partiesRouter.post('/', (req, res) => {
  ensurePartySchema();
  if (!settings.get('allowParties')) throw new HttpError(403, 'Parties are disabled by the council.', 'parties_disabled');
  const user = req.user!;
  const input = body(req);
  if (typeof input.name !== 'string') throw new HttpError(400, 'name must be a string.', 'bad_request');
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters.', 'bad_request');
  const mediaId = positiveInt(input.mediaId, 'mediaId');
  const media = getDb().prepare('SELECT * FROM media WHERE id = ? AND hidden = 0').get(mediaId) as MediaRow | undefined;
  if (!media) throw new HttpError(404, 'Cannot start a party on media that does not exist.', 'not_found');
  if (!playableKind(media.kind)) throw new HttpError(400, 'That media is not playable. No party for you.', 'bad_request');

  const id = randomUUID();
  const timestamp = nowISO();
  const db = getDb();
  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO parties(id, name, host_id, media_id, position, paused, is_active, created_at, updated_at)
       VALUES(?, ?, ?, ?, 0, 1, 1, ?, ?)`,
    ).run(id, name, user.id, mediaId, timestamp, timestamp);
    db.prepare('INSERT INTO party_members(party_id, user_id, joined_at) VALUES(?, ?, ?)').run(id, user.id, timestamp);
  });
  create();
  const row = getParty(id);
  publishSync(row);
  res.status(201).json(partyDTO(row, user.id, true));
});

partiesRouter.get('/:id', (req, res) => {
  ensurePartySchema();
  const row = getParty(partyId(req.params.id));
  res.json(partyDTO(row, req.user!.id, true));
});

partiesRouter.post('/:id/join', (req, res) => {
  ensurePartySchema();
  if (!settings.get('allowParties')) throw new HttpError(403, 'Parties are disabled by the council.', 'parties_disabled');
  const row = getParty(partyId(req.params.id));
  if (!row.is_active) throw new HttpError(409, 'This party has ended. L + ratio.', 'party_ended');
  const user = req.user!;
  const db = getDb();
  const already = db.prepare('SELECT 1 FROM party_members WHERE party_id = ? AND user_id = ?').get(row.id, user.id);
  if (!already) {
    if (memberCount(row.id) >= MAX_MEMBERS) {
      throw new HttpError(409, `Party is full (${MAX_MEMBERS} attendees). Bring your own couch.`, 'party_full');
    }
    db.prepare('INSERT OR IGNORE INTO party_members(party_id, user_id, joined_at) VALUES(?, ?, ?)').run(row.id, user.id, nowISO());
  }
  res.json({ ok: true, joined: true, memberCount: memberCount(row.id) });
});

partiesRouter.post('/:id/state', (req, res) => {
  ensurePartySchema();
  const row = getParty(partyId(req.params.id));
  const user = req.user!;
  if (row.host_id !== user.id && user.role !== 'admin') {
    throw new HttpError(403, 'Only the host can drive this party.', 'forbidden');
  }
  if (!row.is_active) throw new HttpError(409, 'This party has ended.', 'party_ended');

  const input = body(req);
  let position = row.position;
  if (input.position !== undefined) {
    if (typeof input.position !== 'number' || !Number.isFinite(input.position) || input.position < 0) {
      throw new HttpError(400, 'position must be a non-negative number.', 'bad_request');
    }
    if (input.position > MAX_POSITION) throw new HttpError(400, 'position is out of range.', 'bad_request');
    position = input.position;
    if (row.media_id !== null) {
      const media = getDb().prepare('SELECT runtime_seconds FROM media WHERE id = ?').get(row.media_id) as
        | { runtime_seconds: number | null }
        | undefined;
      const duration = media?.runtime_seconds ?? 0;
      if (duration > 0) position = Math.min(position, duration);
    }
  }
  let paused = Boolean(row.paused);
  if (input.paused !== undefined) {
    if (typeof input.paused !== 'boolean') throw new HttpError(400, 'paused must be a boolean.', 'bad_request');
    paused = input.paused;
  }
  if (input.position === undefined && input.paused === undefined) {
    throw new HttpError(400, 'Send position or paused. Hosting requires input.', 'bad_request');
  }

  getDb()
    .prepare('UPDATE parties SET position = ?, paused = ?, updated_at = ? WHERE id = ?')
    .run(position, paused ? 1 : 0, nowISO(), row.id);
  const updated = getParty(row.id);
  publishSync(updated);
  res.json({ ok: true, ...partyDTO(updated, user.id, true) });
});

partiesRouter.post('/:id/leave', (req, res) => {
  ensurePartySchema();
  const row = getParty(partyId(req.params.id));
  const user = req.user!;
  const db = getDb();
  const member = db.prepare('SELECT 1 FROM party_members WHERE party_id = ? AND user_id = ?').get(row.id, user.id);
  if (!member) throw new HttpError(400, 'You are not in this party.', 'not_in_party');
  db.prepare('DELETE FROM party_members WHERE party_id = ? AND user_id = ?').run(row.id, user.id);

  let ended = false;
  if (row.host_id === user.id && row.is_active) {
    const timestamp = nowISO();
    db.prepare('UPDATE parties SET is_active = 0, updated_at = ? WHERE id = ?').run(timestamp, row.id);
    bus.publish('party.sync', { partyId: row.id, mediaId: row.media_id, ended: true, updatedAt: timestamp });
    ended = true;
  }
  res.json({ ok: true, left: true, ended, memberCount: memberCount(row.id) });
});

partiesRouter.delete('/:id', (req, res) => {
  ensurePartySchema();
  const row = getParty(partyId(req.params.id));
  const user = req.user!;
  if (row.host_id !== user.id && user.role !== 'admin') {
    throw new HttpError(403, 'Only the host can end this party.', 'forbidden');
  }
  if (row.is_active) {
    const timestamp = nowISO();
    getDb().prepare('UPDATE parties SET is_active = 0, updated_at = ? WHERE id = ?').run(timestamp, row.id);
    bus.publish('party.sync', { partyId: row.id, mediaId: row.media_id, ended: true, updatedAt: timestamp });
  }
  res.json({ ok: true, ended: true });
});

