import type { Request, Response, NextFunction } from 'express';
import { getDb, nowISO } from '../db.ts';
import { config } from '../config.ts';
import { randomToken } from './passwords.ts';
import { forbidden, unauthorized } from './http.ts';
import type { AuthUser, Role, UserDTO, UserPreferences } from '../types.ts';

export const SESSION_COOKIE = 'slop_session';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  avatar_hue: number;
  pin_hash: string | null;
  disabled: number;
  preferences: string;
  created_at: string;
  last_login_at: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

export function toUserDTO(row: UserRow): UserDTO {
  let preferences: UserPreferences = {};
  try {
    const parsed: unknown = JSON.parse(row.preferences);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) preferences = parsed;
  } catch {
    preferences = {};
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarHue: row.avatar_hue,
    disabled: Boolean(row.disabled),
    preferences,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function findUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function findUserByName(username: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function createSession(userId: number, req: Request): { id: string; expiresAt: string } {
  const id = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionDays * 24 * 60 * 60 * 1000);
  getDb()
    .prepare('INSERT INTO sessions(id, user_id, created_at, expires_at, user_agent, ip) VALUES(?, ?, ?, ?, ?, ?)')
    .run(id, userId, now.toISOString(), expires.toISOString(), (req.headers['user-agent'] || '').slice(0, 300), req.ip || '');
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now.toISOString(), userId);
  return { id, expiresAt: expires.toISOString() };
}

export function destroySession(sessionId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function sessionUser(sessionId: string): AuthUser | undefined {
  const row = getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`,
    )
    .get(sessionId, nowISO()) as UserRow | undefined;
  if (!row) return undefined;
  return { ...toUserDTO(row), hasPin: Boolean(row.pin_hash) };
}

/** Middleware: attach req.user when a valid session cookie is present. Never rejects. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const cookies = parseSessionCookie(req.headers.cookie);
  if (cookies) {
    req.sessionId = cookies;
    req.user = sessionUser(cookies);
  }
  next();
}

function parseSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Admin only. The slop council has spoken.'));
  next();
}

export function requireManager(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return next(forbidden('Curator access only.'));
  next();
}

export function isManager(user: AuthUser | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'manager';
}

export function requirePinIfSet(req: Request, _res: Response, next: NextFunction): void {
  // A PIN is a soft profile lock for shared TVs. The frontend asks for it before
  // switching profiles; the server records it but sessions remain valid.
  if (!req.user) return next(unauthorized());
  next();
}
