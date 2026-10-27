import { Router } from 'express';
import type { Request } from 'express';
import { getDb, nowISO, settings } from '../db.ts';
import { HttpError, pageParams, queryBool, queryString, RateLimiter, sendPage } from '../lib/http.ts';
import type { RequestRow } from '../types.ts';

export const requestsRouter = Router();

type RequestKind = 'movie' | 'show' | 'music' | 'other';
type RequestStatus = 'pending' | 'approved' | 'rejected' | 'fulfilled';

const REQUEST_KINDS: Record<RequestKind, true> = { movie: true, show: true, music: true, other: true };
const REQUEST_STATUSES: Record<RequestStatus, true> = {
  pending: true,
  approved: true,
  rejected: true,
  fulfilled: true,
};
/** Review pipeline: pending → approved|rejected|fulfilled, and approved → fulfilled. Terminals stay dead. */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  pending: ['approved', 'rejected', 'fulfilled'],
  approved: ['fulfilled'],
  rejected: [],
  fulfilled: [],
};

const createLimiter = new RateLimiter(10, 60 * 60_000);
const reportLimiter = new RateLimiter(10, 60 * 60_000);

interface RequestDTO {
  id: number;
  title: string;
  kind: RequestKind;
  year: number | null;
  note: string;
  status: RequestStatus;
  reviewNote: string;
  user: { id: number; username: string; displayName: string } | null;
  reviewedBy: { id: number; username: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface RequestJoinRow extends RequestRow {
  user_username: string | null;
  user_display_name: string | null;
  reviewer_username: string | null;
  reviewer_display_name: string | null;
}

const REQUEST_SELECT = `SELECT r.*,
  u.username AS user_username, u.display_name AS user_display_name,
  ru.username AS reviewer_username, ru.display_name AS reviewer_display_name
  FROM requests r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users ru ON ru.id = r.reviewed_by`;

function toRequestDTO(row: RequestJoinRow): RequestDTO {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    year: row.year,
    note: row.note,
    status: row.status,
    reviewNote: row.review_note,
    user:
      row.user_id !== null
        ? { id: row.user_id, username: row.user_username ?? 'ghost', displayName: row.user_display_name ?? 'Deleted user' }
        : null,
    reviewedBy:
      row.reviewed_by !== null
        ? { id: row.reviewed_by, username: row.reviewer_username ?? 'ghost', displayName: row.reviewer_display_name ?? 'Deleted user' }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requestById(id: number): RequestDTO {
  const row = getDb().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) as RequestJoinRow | undefined;
  if (!row) throw new HttpError(404, 'That request does not exist. Skill issue.', 'not_found');
  return toRequestDTO(row);
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

function isManager(user: { role: string }): boolean {
  return user.role === 'admin' || user.role === 'manager';
}

function parseKind(raw: unknown): RequestKind {
  if (typeof raw !== 'string' || !(raw in REQUEST_KINDS)) {
    throw new HttpError(400, 'kind must be one of: movie, show, music, other.', 'bad_request');
  }
  return raw as RequestKind;
}

function parseStatus(raw: unknown): RequestStatus {
  if (typeof raw !== 'string' || !(raw in REQUEST_STATUSES)) {
    throw new HttpError(400, 'status must be one of: pending, approved, rejected, fulfilled.', 'bad_request');
  }
  return raw as RequestStatus;
}

function enforceLimit(limiter: RateLimiter, userId: number, label: string): void {
  const result = limiter.check(`${label}:${userId}`);
  if (!result.ok) {
    throw new HttpError(429, `Too many ${label}. Touch grass for ${result.retryAfter}s.`, 'rate_limited');
  }
}

requestsRouter.get('/', (req, res) => {
  const user = req.user!;
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 100 });
  const mine = queryBool(req, 'mine') === true;
  const scopeAll = isManager(user) && !mine;
  const statusFilter = queryString(req, 'status');
  const status = statusFilter === undefined ? undefined : parseStatus(statusFilter);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!scopeAll) {
    clauses.push('r.user_id = ?');
    params.push(user.id);
  }
  if (status) {
    clauses.push('r.status = ?');
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM requests r ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${REQUEST_SELECT} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as RequestJoinRow[];
  sendPage(res, rows.map(toRequestDTO), total, page, pageSize);
});

requestsRouter.get('/stats', (req, res) => {
  const user = req.user!;
  const mine = queryBool(req, 'mine') === true;
  const scopeAll = isManager(user) && !mine;
  const params: unknown[] = [];
  let where = '';
  if (!scopeAll) {
    where = 'WHERE user_id = ?';
    params.push(user.id);
  }
  const rows = getDb().prepare(`SELECT status, COUNT(*) AS n FROM requests ${where} GROUP BY status`).all(...params) as {
    status: RequestStatus;
    n: number;
  }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.n;
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  res.json({
    total,
    pending: counts.pending ?? 0,
    approved: counts.approved ?? 0,
    rejected: counts.rejected ?? 0,
    fulfilled: counts.fulfilled ?? 0,
    scope: scopeAll ? 'all' : 'own',
    allowRequests: settings.get('allowRequests'),
  });
});

requestsRouter.post('/', (req, res) => {
  if (!settings.get('allowRequests')) {
    throw new HttpError(403, 'Requests are closed. The council is busy touching grass.', 'requests_disabled');
  }
  const user = req.user!;
  enforceLimit(createLimiter, user.id, 'request');

  const input = body(req);
  if (typeof input.title !== 'string') throw new HttpError(400, 'title must be a string.', 'bad_request');
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) throw new HttpError(400, 'title must be 1-200 characters.', 'bad_request');
  const kind = input.kind === undefined ? 'movie' : parseKind(input.kind);

  let year: number | null = null;
  if (input.year !== undefined && input.year !== null) {
    if (typeof input.year !== 'number' || !Number.isInteger(input.year) || input.year < 1880 || input.year > 2200) {
      throw new HttpError(400, 'year must be an integer between 1880 and 2200.', 'bad_request');
    }
    year = input.year;
  }
  let note = '';
  if (input.note !== undefined) {
    if (typeof input.note !== 'string') throw new HttpError(400, 'note must be a string.', 'bad_request');
    if (input.note.length > 2000) throw new HttpError(400, 'note is capped at 2000 characters.', 'bad_request');
    note = input.note.trim();
  }

  const db = getDb();
  const duplicate = db
    .prepare("SELECT id FROM requests WHERE user_id = ? AND status = 'pending' AND title = ? COLLATE NOCASE")
    .get(user.id, title);
  if (duplicate) throw new HttpError(409, 'You already requested that. Patience, padawan.', 'conflict');

  const timestamp = nowISO();
  const info = db
    .prepare(
      `INSERT INTO requests(user_id, title, kind, year, note, status, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(user.id, title, kind, year, note, timestamp, timestamp);
  res.status(201).json(requestById(Number(info.lastInsertRowid)));
});

requestsRouter.patch('/:id', (req, res) => {
  const user = req.user!;
  if (!isManager(user)) throw new HttpError(403, 'Only curators can review requests.', 'forbidden');
  const id = positiveInt(req.params.id, 'id');
  const row = getDb().prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!row) throw new HttpError(404, 'That request does not exist.', 'not_found');

  const input = body(req);
  if (input.status === undefined) throw new HttpError(400, 'status is required for a review.', 'bad_request');
  const status = parseStatus(input.status);
  if (status === 'pending') throw new HttpError(409, 'Cannot send a request back to pending.', 'invalid_transition');

  if (status !== row.status && !TRANSITIONS[row.status].includes(status)) {
    throw new HttpError(409, `Cannot move a ${row.status} request to ${status}.`, 'invalid_transition', {
      allowed: TRANSITIONS[row.status],
    });
  }
  let reviewNote = '';
  if (input.reviewNote !== undefined) {
    if (typeof input.reviewNote !== 'string') throw new HttpError(400, 'reviewNote must be a string.', 'bad_request');
    if (input.reviewNote.length > 1000) throw new HttpError(400, 'reviewNote is capped at 1000 characters.', 'bad_request');
    reviewNote = input.reviewNote.trim();
  }
  getDb()
    .prepare('UPDATE requests SET status = ?, review_note = ?, reviewed_by = ?, updated_at = ? WHERE id = ?')
    .run(status, reviewNote, user.id, nowISO(), id);
  res.json({ ok: true, request: requestById(id) });
});

requestsRouter.delete('/:id', (req, res) => {
  const user = req.user!;
  const id = positiveInt(req.params.id, 'id');
  const row = getDb().prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!row) throw new HttpError(404, 'That request does not exist.', 'not_found');
  const isOwnerPending = row.user_id === user.id && row.status === 'pending';
  if (!isOwnerPending && user.role !== 'admin') {
    throw new HttpError(403, 'You can only delete your own pending requests.', 'forbidden');
  }
  getDb().prepare('DELETE FROM requests WHERE id = ?').run(id);
  res.json({ ok: true });
});

interface ReportJoinRow {
  id: number;
  user_id: number | null;
  media_id: number | null;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  notes: string;
  resolved_by: number | null;
  created_at: string;
  resolved_at: string | null;
  media_title: string | null;
}

function reportDTO(row: ReportJoinRow) {
  return {
    id: row.id,
    mediaId: row.media_id,
    mediaTitle: row.media_title,
    reason: row.reason,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** File a moderation report against a media item, or by title when the item is not in the library yet. */
requestsRouter.post('/reports', (req, res) => {
  const user = req.user!;
  enforceLimit(reportLimiter, user.id, 'report');
  const input = body(req);

  if (typeof input.reason !== 'string') throw new HttpError(400, 'reason must be a string.', 'bad_request');
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1000) {
    throw new HttpError(400, 'reason must be 3-1000 characters.', 'bad_request');
  }

  const db = getDb();
  let mediaId: number | null = null;
  let notes = '';
  if (input.mediaId !== undefined && input.mediaId !== null) {
    mediaId = positiveInt(input.mediaId, 'mediaId');
    const media = db.prepare('SELECT id FROM media WHERE id = ?').get(mediaId);
    if (!media) throw new HttpError(404, 'That media does not exist.', 'not_found');
  } else {
    if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.trim().length > 200) {
      throw new HttpError(400, 'Report needs a mediaId or a title (1-200 chars).', 'bad_request');
    }
    notes = `Reported title: ${input.title.trim()}`;
  }

  const timestamp = nowISO();
  const info = db
    .prepare(
      `INSERT INTO reports(user_id, media_id, reason, status, notes, created_at)
       VALUES(?, ?, ?, 'open', ?, ?)`,
    )
    .run(user.id, mediaId, reason, notes, timestamp);
  const row = db
    .prepare(
      `SELECT r.*, m.title AS media_title FROM reports r LEFT JOIN media m ON m.id = r.media_id WHERE r.id = ?`,
    )
    .get(Number(info.lastInsertRowid)) as ReportJoinRow;
  res.status(201).json({ ok: true, report: reportDTO(row) });
});

requestsRouter.get('/reports/mine', (req, res) => {
  const user = req.user!;
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 100 });
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ?').get(user.id) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT r.*, m.title AS media_title FROM reports r LEFT JOIN media m ON m.id = r.media_id
       WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(user.id, pageSize, offset) as ReportJoinRow[];
  sendPage(res, rows.map(reportDTO), total, page, pageSize);
});

