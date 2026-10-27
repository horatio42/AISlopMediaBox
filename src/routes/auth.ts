import { Router } from 'express';
import { config } from '../config.ts';
import { getDb, nowISO, settings } from '../db.ts';
import { hashPassword, verifyPassword, randomToken } from '../lib/passwords.ts';
import { createSession, destroySession, findUserByName, SESSION_COOKIE, toUserDTO } from '../lib/auth.ts';
import { clearCookie, clientIp, HttpError, RateLimiter, setCookie } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';
import type { UserRow } from '../lib/auth.ts';

export const authRouter = Router();

const loginLimiter = new RateLimiter(10, 5 * 60_000);
const registerLimiter = new RateLimiter(5, 60 * 60_000);

function publicUser(row: UserRow) {
  const dto = toUserDTO(row);
  const activeSessions = (
    getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(row.id, nowISO()) as { n: number }
  ).n;
  return { ...dto, activeSessions, hasPin: Boolean(row.pin_hash) };
}

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    res.status(401).json({ authenticated: false, allowSignups: settings.get('allowSignups'), serverName: settings.get('serverName') });
    return;
  }
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) as UserRow;
  res.json({ authenticated: true, user: publicUser(row), serverName: settings.get('serverName') });
});

authRouter.post('/login', loginLimiter.middleware('login'), (req, res, next) => {
  const { username, password, pin } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new HttpError(400, 'Username and password required.', 'bad_request');
  }
  const row = findUserByName(username.trim());
  if (!row || !verifyPassword(password, row.password_hash)) {
    logger.warn('auth', 'Failed login attempt', { ip: clientIp(req), username: String(username).slice(0, 60) });
    throw new HttpError(401, 'Wrong credentials. Skill issue.', 'invalid_credentials');
  }
  if (row.disabled) throw new HttpError(403, 'This account is banned by the slop council.', 'account_disabled');
  if (row.pin_hash) {
    if (typeof pin !== 'string' || !verifyPassword(pin, row.pin_hash)) {
      throw new HttpError(401, 'PIN required for this profile.', 'pin_required');
    }
  }
  const session = createSession(row.id, req);
  setCookie(res, SESSION_COOKIE, session.id, config.sessionDays * 24 * 60 * 60);
  logger.info('auth', `Login: ${row.username}`, { userId: row.id });
  res.json({ ok: true, user: publicUser(row) });
});

authRouter.post('/logout', (req, res) => {
  if (req.sessionId) destroySession(req.sessionId);
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

authRouter.post('/register', registerLimiter.middleware('register'), (req, res) => {
  if (!settings.get('allowSignups')) {
    throw new HttpError(403, 'Signups are closed. Ask the admin for an invite, or touch grass.', 'signups_closed');
  }
  const { username, password, displayName, invite } = req.body ?? {};
  if (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 32) {
    throw new HttpError(400, 'Username must be 2-32 characters.', 'bad_request');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
    throw new HttpError(400, 'Username may only contain letters, numbers, dot, dash, underscore.', 'bad_request');
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters. Security through vibes.', 'bad_request');
  }
  if (findUserByName(username.trim())) throw new HttpError(409, 'That username is taken.', 'conflict');

  let inviteRow: { id: string; role: string } | undefined;
  if (settings.get('requireInvite')) {
    if (typeof invite !== 'string' || !invite.trim()) throw new HttpError(403, 'An invite code is required.', 'invite_required');
    inviteRow = getDb()
      .prepare(`SELECT id, role FROM invites WHERE code = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(invite.trim(), nowISO()) as { id: string; role: string } | undefined;
    if (!inviteRow) throw new HttpError(403, 'Invite is invalid, used, or expired. L.', 'invite_invalid');
  }

  const now = nowISO();
  const hue = Math.floor(Math.random() * 360);
  const info = getDb()
    .prepare(
      `INSERT INTO users(username, display_name, password_hash, role, avatar_hue, preferences, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      username.trim(),
      typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 40) : username.trim(),
      hashPassword(password),
      inviteRow?.role === 'manager' ? 'manager' : 'user',
      hue,
      '{}',
      now,
    );
  const userId = Number(info.lastInsertRowid);
  if (inviteRow) {
    getDb().prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?').run(userId, now, inviteRow.id);
  }
  const session = createSession(userId, req);
  setCookie(res, SESSION_COOKIE, session.id, config.sessionDays * 24 * 60 * 60);
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  logger.info('auth', `Registered: ${row.username}`, { userId });
  res.status(201).json({ ok: true, user: publicUser(row) });
});

authRouter.get('/invites/check/:code', (req, res) => {
  const row = getDb()
    .prepare('SELECT id FROM invites WHERE code = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)')
    .get(req.params.code, nowISO());
  if (!row) {
    res.json({ valid: false });
    return;
  }
  res.json({ valid: true });
});

authRouter.post('/pin', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Log in first.', 'unauthorized');
  const { pin } = req.body ?? {};
  if (pin !== null && (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin))) {
    throw new HttpError(400, 'PIN must be 4-8 digits.', 'bad_request');
  }
  getDb()
    .prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
    .run(pin === null ? null : hashPassword(pin), req.user.id);
  res.json({ ok: true, hasPin: pin !== null });
});

authRouter.get('/sessions', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Log in first.', 'unauthorized');
  const rows = getDb()
    .prepare('SELECT id, created_at, expires_at, user_agent, ip FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id) as { id: string; created_at: string; expires_at: string; user_agent: string; ip: string }[];
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      ip: row.ip,
      current: row.id === req.sessionId,
    })),
  });
});

authRouter.delete('/sessions/:id', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Log in first.', 'unauthorized');
  if (req.params.id !== req.sessionId) {
    const owned = getDb().prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!owned) throw new HttpError(404, 'Session not found.', 'not_found');
  }
  destroySession(req.params.id);
  if (req.params.id === req.sessionId) clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

export function issueInvite(createdBy: number, role: 'user' | 'manager' = 'user', ttlHours = 72): { code: string; expiresAt: string } {
  const code = randomToken(12).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toUpperCase();
  const expires = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  getDb()
    .prepare('INSERT INTO invites(id, code, role, created_by, expires_at, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(randomToken(8), code, role, createdBy, expires, nowISO());
  return { code, expiresAt: expires };
}
