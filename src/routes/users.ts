import { Router } from 'express';
import type { Request } from 'express';
import { getDb, nowISO } from '../db.ts';
import { clearCookie, HttpError, RateLimiter } from '../lib/http.ts';
import { findUserById, SESSION_COOKIE, toUserDTO } from '../lib/auth.ts';
import { hashPassword, verifyPassword } from '../lib/passwords.ts';
import type { AuthUser, UserPreferences } from '../types.ts';

export const usersRouter = Router();

const THEMES: Record<string, true> = { slop: true, dark: true, light: true, midnight: true };
const CARD_DENSITIES: Record<string, true> = { cozy: true, compact: true };
const PROFILE_FIELDS = ['displayName', 'preferences', 'avatarHue'];
const passwordLimiter = new RateLimiter(6, 15 * 60_000);

function body(req: Request): Record<string, unknown> {
  const raw: unknown = req.body;
  const result: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) result[key] = value;
  return result;
}

function requireCurrentRow(user: AuthUser) {
  const row = findUserById(user.id);
  if (!row) throw new HttpError(404, 'Your account vanished. Impressive.', 'not_found');
  return row;
}

function enforcePasswordLimit(userId: number): void {
  const result = passwordLimiter.check(`password:${userId}`);
  if (!result.ok) {
    throw new HttpError(429, `Too many password attempts. Touch grass for ${result.retryAfter}s.`, 'rate_limited');
  }
}

function requirePassword(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new HttpError(400, 'Password is required.', 'bad_request');
  }
  return input;
}

function narrowPreferences(raw: unknown, current: UserPreferences): UserPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'preferences must be an object.', 'bad_request');
  }
  const next: UserPreferences = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'theme':
        if (typeof value !== 'string' || !(value in THEMES)) {
          throw new HttpError(400, "preferences.theme must be 'slop', 'dark', 'light', or 'midnight'.", 'bad_request');
        }
        next.theme = value as UserPreferences['theme'];
        break;
      case 'autoPlayNext':
      case 'reduceMotion':
      case 'spoilerBlur':
      case 'memes':
        if (typeof value !== 'boolean') throw new HttpError(400, `preferences.${key} must be a boolean.`, 'bad_request');
        next[key] = value;
        break;
      case 'cardDensity':
        if (typeof value !== 'string' || !(value in CARD_DENSITIES)) {
          throw new HttpError(400, "preferences.cardDensity must be 'cozy' or 'compact'.", 'bad_request');
        }
        next.cardDensity = value as UserPreferences['cardDensity'];
        break;
      case 'defaultSubtitle':
      case 'defaultAudio':
        if (typeof value !== 'string' || value.length > 40) {
          throw new HttpError(400, `preferences.${key} must be a string of at most 40 characters.`, 'bad_request');
        }
        next[key] = value.trim();
        break;
      default:
        throw new HttpError(400, `Unknown preference: ${key}.`, 'bad_request', {
          allowed: ['theme', 'autoPlayNext', 'defaultSubtitle', 'defaultAudio', 'reduceMotion', 'spoilerBlur', 'cardDensity', 'memes'],
        });
    }
  }
  return next;
}

function userStats(userId: number) {
  return getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM item_state WHERE user_id = ? AND favorite = 1) AS favorites,
        (SELECT COUNT(*) FROM item_state WHERE user_id = ? AND watched = 1) AS watched,
        (SELECT COUNT(*) FROM item_state WHERE user_id = ? AND rating IS NOT NULL) AS rated,
        (SELECT COUNT(*) FROM progress WHERE user_id = ?) AS progressCount,
        (SELECT COUNT(*) FROM progress WHERE user_id = ? AND finished = 0 AND position_seconds > 5) AS inProgress,
        (SELECT COUNT(*) FROM playlists WHERE created_by = ?) AS playlists,
        (SELECT COUNT(*) FROM collections WHERE created_by = ?) AS collections,
        (SELECT COUNT(*) FROM requests WHERE user_id = ?) AS requests,
        (SELECT COUNT(*) FROM reports WHERE user_id = ?) AS reports`,
    )
    .get(userId, userId, userId, userId, userId, userId, userId, userId, userId) as {
    favorites: number;
    watched: number;
    rated: number;
    progressCount: number;
    inProgress: number;
    playlists: number;
    collections: number;
    requests: number;
    reports: number;
  };
}

usersRouter.get('/me', (req, res) => {
  const row = requireCurrentRow(req.user!);
  const activeSessions = (
    getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(row.id, nowISO()) as { n: number }
  ).n;
  res.json({ ...toUserDTO(row), hasPin: Boolean(row.pin_hash), activeSessions, stats: userStats(row.id) });
});

usersRouter.patch('/me', (req, res) => {
  const user = req.user!;
  const row = requireCurrentRow(user);
  const input = body(req);

  const unknown = Object.keys(input).filter((key) => !PROFILE_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'Those fields cannot be changed here. No role escalation today.', 'bad_request', {
      unknown,
      allowed: PROFILE_FIELDS,
    });
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string') throw new HttpError(400, 'displayName must be a string.', 'bad_request');
    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 60) {
      throw new HttpError(400, 'displayName must be 1-60 characters.', 'bad_request');
    }
    updates.push('display_name = ?');
    params.push(displayName);
  }
  if (input.avatarHue !== undefined) {
    if (typeof input.avatarHue !== 'number' || !Number.isInteger(input.avatarHue) || input.avatarHue < 0 || input.avatarHue > 360) {
      throw new HttpError(400, 'avatarHue must be an integer between 0 and 360.', 'bad_request');
    }
    updates.push('avatar_hue = ?');
    params.push(input.avatarHue);
  }
  if (input.preferences !== undefined) {
    let current: UserPreferences = {};
    try {
      const parsed: unknown = JSON.parse(row.preferences);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as UserPreferences;
    } catch {
      current = {};
    }
    const preferences = narrowPreferences(input.preferences, current);
    updates.push('preferences = ?');
    params.push(JSON.stringify(preferences));
  }
  if (updates.length === 0) throw new HttpError(400, 'Nothing to update. Send displayName, preferences, or avatarHue.', 'bad_request');

  params.push(row.id);
  getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = requireCurrentRow(user);
  res.json({ ...toUserDTO(updated), hasPin: Boolean(updated.pin_hash), stats: userStats(updated.id) });
});

usersRouter.post('/me/password', (req, res) => {
  const user = req.user!;
  enforcePasswordLimit(user.id);
  const row = requireCurrentRow(user);
  const input = body(req);
  const current = requirePassword(input.current);
  if (typeof input.next !== 'string') throw new HttpError(400, 'next password must be a string.', 'bad_request');
  if (input.next.length < 6 || input.next.length > 200) {
    throw new HttpError(400, 'New password must be 6-200 characters.', 'bad_request');
  }
  if (!verifyPassword(current, row.password_hash)) {
    throw new HttpError(400, 'Current password is wrong. Nice try.', 'invalid_password');
  }
  if (input.next === current) throw new HttpError(400, 'New password must differ from the current one.', 'bad_request');

  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(input.next), row.id);
  const revoked = req.sessionId
    ? getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(row.id, req.sessionId).changes
    : getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id).changes;
  res.json({ ok: true, sessionsRevoked: revoked });
});

usersRouter.get('/me/export', (req, res) => {
  const user = req.user!;
  const row = requireCurrentRow(user);
  const db = getDb();

  const states = db
    .prepare(
      `SELECT s.media_id, s.favorite, s.watched, s.rating, s.updated_at, m.title, m.kind
       FROM item_state s JOIN media m ON m.id = s.media_id
       WHERE s.user_id = ? ORDER BY s.updated_at DESC`,
    )
    .all(user.id) as {
    media_id: number;
    favorite: number;
    watched: number;
    rating: number | null;
    updated_at: string;
    title: string;
    kind: string;
  }[];

  const progress = db
    .prepare(
      `SELECT p.media_id, p.position_seconds, p.duration_seconds, p.finished, p.play_count, p.updated_at,
              m.title, m.kind, m.season_number, m.episode_number,
              COALESCE(sh.title, se.title) AS parent_title
       FROM progress p JOIN media m ON m.id = p.media_id
       LEFT JOIN media se ON se.id = m.parent_id
       LEFT JOIN media sh ON sh.id = se.parent_id
       WHERE p.user_id = ? ORDER BY p.updated_at DESC`,
    )
    .all(user.id) as {
    media_id: number;
    position_seconds: number;
    duration_seconds: number;
    finished: number;
    play_count: number;
    updated_at: string;
    title: string;
    kind: string;
    season_number: number | null;
    episode_number: number | null;
    parent_title: string | null;
  }[];

  const collections = db
    .prepare('SELECT id, name, kind, created_at FROM collections WHERE created_by = ? ORDER BY created_at ASC')
    .all(user.id) as { id: number; name: string; kind: string; created_at: string }[];
  const collectionItems = db.prepare(
    'SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY sort_order ASC, added_at ASC',
  );

  const playlists = db
    .prepare('SELECT id, name, description, kind, is_public, created_at FROM playlists WHERE created_by = ? ORDER BY created_at ASC')
    .all(user.id) as { id: number; name: string; description: string; kind: string; is_public: number; created_at: string }[];
  const playlistItems = db.prepare(
    `SELECT pi.media_id, m.title, m.kind FROM playlist_items pi JOIN media m ON m.id = pi.media_id
     WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC, pi.added_at ASC`,
  );

  const requests = db
    .prepare(
      `SELECT id, title, kind, year, note, status, review_note, created_at, updated_at
       FROM requests WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(user.id) as {
    id: number;
    title: string;
    kind: string;
    year: number | null;
    note: string;
    status: string;
    review_note: string;
    created_at: string;
    updated_at: string;
  }[];
  const reports = db
    .prepare(
      `SELECT r.id, r.media_id, m.title AS media_title, r.reason, r.status, r.created_at
       FROM reports r LEFT JOIN media m ON m.id = r.media_id
       WHERE r.user_id = ? ORDER BY r.created_at DESC`,
    )
    .all(user.id) as {
    id: number;
    media_id: number | null;
    media_title: string | null;
    reason: string;
    status: string;
    created_at: string;
  }[];

  const sessions = db
    .prepare(
      `SELECT created_at, expires_at, user_agent, ip, (id = ?) AS current
       FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(req.sessionId ?? '', user.id, nowISO()) as {
    created_at: string;
    expires_at: string;
    user_agent: string | null;
    ip: string | null;
    current: number;
  }[];

  const payload = {
    exportedAt: nowISO(),
    version: 1,
    app: 'AISlopMediaBox',
    user: toUserDTO(row),
    state: {
      favorites: states
        .filter((entry) => entry.favorite === 1)
        .map((entry) => ({ mediaId: entry.media_id, title: entry.title, kind: entry.kind, updatedAt: entry.updated_at })),
      watched: states
        .filter((entry) => entry.watched === 1)
        .map((entry) => ({ mediaId: entry.media_id, title: entry.title, kind: entry.kind, updatedAt: entry.updated_at })),
      ratings: states
        .filter((entry) => entry.rating !== null)
        .map((entry) => ({ mediaId: entry.media_id, title: entry.title, rating: entry.rating, updatedAt: entry.updated_at })),
    },
    progress: progress.map((entry) => ({
      mediaId: entry.media_id,
      title: entry.title,
      kind: entry.kind,
      parentTitle: entry.parent_title,
      seasonNumber: entry.season_number,
      episodeNumber: entry.episode_number,
      positionSeconds: entry.position_seconds,
      durationSeconds: entry.duration_seconds,
      finished: Boolean(entry.finished),
      playCount: entry.play_count,
      updatedAt: entry.updated_at,
    })),
    collections: collections.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      createdAt: entry.created_at,
      itemIds: (collectionItems.all(entry.id) as { media_id: number }[]).map((item) => item.media_id),
    })),
    playlists: playlists.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: entry.kind,
      isPublic: entry.is_public === 1,
      createdAt: entry.created_at,
      items: (playlistItems.all(entry.id) as { media_id: number; title: string; kind: string }[]).map((item) => ({
        mediaId: item.media_id,
        title: item.title,
        kind: item.kind,
      })),
    })),
    requests: requests.map((entry) => ({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      year: entry.year,
      note: entry.note,
      status: entry.status,
      reviewNote: entry.review_note,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    })),
    reports: reports.map((entry) => ({
      id: entry.id,
      mediaId: entry.media_id,
      mediaTitle: entry.media_title,
      reason: entry.reason,
      status: entry.status,
      createdAt: entry.created_at,
    })),
    sessions: sessions.map((entry) => ({
      createdAt: entry.created_at,
      expiresAt: entry.expires_at,
      userAgent: entry.user_agent,
      ip: entry.ip,
      current: entry.current === 1,
    })),
  };

  const safeName = row.username.replace(/[^A-Za-z0-9_-]/g, '_');
  const filename = `aislopmediabox-export-${safeName}-${nowISO().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
});

usersRouter.delete('/me', (req, res) => {
  const user = req.user!;
  enforcePasswordLimit(user.id);
  const row = requireCurrentRow(user);
  const input = body(req);
  const password = requirePassword(input.password);
  if (!verifyPassword(password, row.password_hash)) {
    throw new HttpError(400, 'Password is wrong. Account stays undefeated.', 'invalid_password');
  }
  if (row.role === 'admin') {
    const others = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
        .get(row.id) as { n: number }
    ).n;
    if (others === 0) throw new HttpError(409, 'Cannot delete the last admin. The council needs a head.', 'last_admin');
  }
  getDb().prepare('DELETE FROM users WHERE id = ?').run(row.id);
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

