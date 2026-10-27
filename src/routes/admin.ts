import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, paths } from '../config.ts';
import { DEFAULT_SETTINGS, getDb, nowISO, settings } from '../db.ts';
import { findUserById, requireAdmin, toUserDTO } from '../lib/auth.ts';
import type { UserRow } from '../lib/auth.ts';
import { badRequest, clientIp, conflict, HttpError, notFound, pageParams, queryInt, queryString } from '../lib/http.ts';
import { bus, logger, serverInfo } from '../lib/logger.ts';
import { mediaRowsToDTO } from '../lib/dto.ts';
import { hashPassword, randomToken } from '../lib/passwords.ts';
import { issueInvite } from './auth.ts';
import { jobQueue } from '../services/jobs.ts';
import { providerStatuses } from '../services/providers.ts';
import type { ProviderId } from '../services/providers.ts';
import type { JobRow, JobStatus, JobType, MediaRow, ReportRow, RequestRow, Role, SiteSettings } from '../types.ts';

export const adminRouter = Router();

// server.ts already gates this prefix; belt + suspenders because admin mistakes are permanent.
adminRouter.use(requireAdmin);

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const ROLES: readonly Role[] = ['admin', 'manager', 'user'];
const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'fulfilled'] as const;
const REQUEST_KINDS = ['movie', 'show', 'music', 'other'] as const;
const LIBRARY_KINDS = ['movies', 'shows', 'music', 'photos', 'mixed'] as const;
const SCAN_SCHEDULES = ['manual', 'hourly', 'daily', 'weekly'] as const;
const PLAYLIST_KINDS = ['mixed', 'video', 'audio', 'photo'] as const;

type Loose = Record<string, unknown>;

interface LogFilters {
  level?: string;
  scope?: string;
  q?: string;
  olderThanDays?: number;
}

interface LogRow {
  id: number;
  level: string;
  scope: string;
  message: string;
  meta: string | null;
  created_at: string;
}

interface LogDTO {
  id: number;
  level: string;
  scope: string;
  message: string;
  meta: unknown;
  createdAt: string;
}

interface UserListRow extends UserRow {
  active_sessions: number;
}

interface JobQueueInternals {
  handlers?: Map<JobType, unknown>;
}

/**
 * Maintenance/report helpers reach into the queue's handler registry (the only runtime
 * signal of whether a job type will actually run). The queue deliberately keeps no
 * handler listing because handlers self-register on import.
 */
function hasJobHandler(type: JobType): boolean {
  const internals = jobQueue as unknown as JobQueueInternals;
  return internals.handlers instanceof Map && internals.handlers.has(type);
}

function actor(req: Request): { id: number; username: string } {
  if (!req.user) throw new HttpError(401, 'Log in first, chief.', 'unauthorized');
  return { id: req.user.id, username: req.user.username };
}

function audit(req: Request, action: string, details: Loose = {}): void {
  const who = req.user ? { userId: req.user.id, username: req.user.username } : {};
  logger.info('audit', `admin.${action}`, { ...who, ip: clientIp(req), ...details });
}

function requireObject(value: unknown, label = 'body'): Loose {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`Expected a JSON object in the ${label}.`, { expected: 'object' });
  }
  return value as Loose;
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('That id is not even a number. Skill issue.');
  return id;
}

function parseJSON(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function logToDTO(row: LogRow): LogDTO {
  return {
    id: row.id,
    level: row.level,
    scope: row.scope,
    message: row.message,
    meta: parseJSON(row.meta),
    createdAt: row.created_at,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

interface DirStats {
  bytes: number;
  files: number;
}

/** Size a cache tree without following symlinks. Cache dirs are local and bounded by disk. */
function dirStats(root: string): DirStats {
  let bytes = 0;
  let files = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* raced with a cleanup; not our problem */
        }
      }
    }
  }
  return { bytes, files };
}

function emptyDir(dir: string): DirStats {
  const stats = dirStats(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  } catch (error) {
    throw new HttpError(500, `Could not clear ${path.basename(dir)} cache. It insists upon itself.`, 'cache_clear_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return stats;
}

interface DiskInfo {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  percentUsed: number;
}

function diskInfo(dir: string): DiskInfo {
  try {
    const stats = fs.statfsSync(dir);
    const blockSize = Number(stats.bsize);
    const totalBytes = blockSize * Number(stats.blocks);
    const freeBytes = blockSize * Number(stats.bfree);
    const availableBytes = blockSize * Number(stats.bavail);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      path: dir,
      totalBytes,
      usedBytes,
      freeBytes,
      availableBytes,
      percentUsed: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return { path: dir, totalBytes: 0, usedBytes: 0, freeBytes: 0, availableBytes: 0, percentUsed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Settings (strict allowlist; no arbitrary knobs, no stringly-typed booleans)
// ---------------------------------------------------------------------------

const BOOLEAN_SETTING_KEYS = new Set<string>([
  'allowSignups',
  'requireInvite',
  'tvmazeEnabled',
  'imdbEnabled',
  'ingestWatch',
  'transcodeEnabled',
  'subtitleBurnIn',
  'hwAccelDecode',
  'scanOnStart',
  'autoMatch',
  'generateArt',
  'allowRequests',
  'allowParties',
  'maintenanceMode',
  'memes',
  'telemetry',
]);

const SECRET_SETTING_KEYS = new Set<string>(['tmdbApiKey', 'tvdbApiKey', 'omdbApiKey']);

const TRANSCODE_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const HWACCEL_MODES = ['auto', 'none', 'nvenc', 'qsv', 'vaapi', 'amf', 'v4l2m2m', 'rkmpp', 'vulkan', 'videotoolbox'];
const ACCENTS = ['slop', 'light', 'midnight', 'goblin'];
const MAX_TRANSCODE_HEIGHT = { min: 144, max: 2160 };

function validateSettingValue(key: string, value: unknown): unknown {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
    throw badRequest(`Unknown setting "${key}". The council does not recognize this knob.`, { key });
  }
  if (key === 'telemetry') {
    if (value !== false) throw badRequest('Telemetry must stay false. This box does not phone home.', { key });
    return false;
  }
  if (BOOLEAN_SETTING_KEYS.has(key)) {
    if (typeof value !== 'boolean') throw badRequest(`Setting "${key}" must be a boolean, not vibes.`, { key, expected: 'boolean' });
    return value;
  }
  if (key === 'maxTranscodeHeight') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MAX_TRANSCODE_HEIGHT.min || value > MAX_TRANSCODE_HEIGHT.max) {
      throw badRequest(`maxTranscodeHeight must be an integer between ${MAX_TRANSCODE_HEIGHT.min} and ${MAX_TRANSCODE_HEIGHT.max}.`, {
        key,
        min: MAX_TRANSCODE_HEIGHT.min,
        max: MAX_TRANSCODE_HEIGHT.max,
      });
    }
    return value;
  }
  if (key === 'accent') {
    if (typeof value !== 'string' || !ACCENTS.includes(value)) {
      throw badRequest(`accent must be one of: ${ACCENTS.join(', ')}.`, { key, allowed: ACCENTS });
    }
    return value;
  }
  if (key === 'transcodePreset') {
    if (typeof value !== 'string' || !TRANSCODE_PRESETS.includes(value)) {
      throw badRequest(`transcodePreset must be a valid ffmpeg preset.`, { key, allowed: TRANSCODE_PRESETS });
    }
    return value;
  }
  if (key === 'hwAccel') {
    if (typeof value !== 'string' || !HWACCEL_MODES.includes(value)) {
      throw badRequest('hwAccel must be one of the supported acceleration modes.', { key, allowed: HWACCEL_MODES });
    }
    return value;
  }
  if (key === 'hwAccelDevice') {
    if (typeof value !== 'string') throw badRequest('hwAccelDevice must be a string; empty means autodetect.', { key });
    const trimmed = value.trim();
    if (trimmed !== '' && !/^\/dev\/[A-Za-z0-9_./-]{1,120}$/.test(trimmed)) {
      throw badRequest('hwAccelDevice must look like /dev/dri/renderD128, or be empty.', { key });
    }
    return trimmed;
  }
  if (key === 'transcodeThrottleSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 900) {
      throw badRequest('transcodeThrottleSeconds must be an integer between 0 and 900 (0 disables throttling).', { key, min: 0, max: 900 });
    }
    return value;
  }
  if (SECRET_SETTING_KEYS.has(key)) {
    if (typeof value !== 'string') throw badRequest(`${key} must be a string. Empty clears it.`, { key });
    const trimmed = value.trim();
    // TMDB v3 keys are 32 hex chars, v4 keys are long JWTs; TVDB/OMDb keys are shorter tokens.
    if (trimmed !== '' && !/^[A-Za-z0-9._-]{8,512}$/.test(trimmed)) {
      throw badRequest(`${key} looks malformed. Use an 8-512 char provider key (letters, numbers, dot, dash, underscore), or empty to clear.`, { key });
    }
    return trimmed;
  }
  if (key === 'ingestIntervalSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 3600) {
      throw badRequest('ingestIntervalSeconds must be an integer between 5 and 3600.', { key, min: 5, max: 3600 });
    }
    return value;
  }
  if (typeof value !== 'string') throw badRequest(`Setting "${key}" must be a string.`, { key, expected: 'string' });
  if (key === 'serverName') {
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 60) throw badRequest('serverName must be 1-60 characters.', { key });
    return trimmed;
  }
  if (key === 'tagline') {
    const trimmed = value.trim();
    if (trimmed.length > 160) throw badRequest('tagline must be at most 160 characters.', { key });
    return trimmed;
  }
  throw badRequest(`Setting "${key}" is not editable.`, { key });
}

function validateSettingsPatch(body: Loose): Map<string, unknown> {
  const validated = new Map<string, unknown>();
  for (const [key, value] of Object.entries(body)) {
    validated.set(key, validateSettingValue(key, value));
  }
  if (validated.size === 0) throw badRequest('Settings patch is empty. Change something or change nothing.', {});
  return validated;
}

/** SSE fans out to every client, so never include provider keys in a broadcast. */
function broadcastSettings(): Loose {
  const all = settings.all();
  return { ...all, tmdbApiKey: '', tvdbApiKey: '', omdbApiKey: '' };
}

adminRouter.get('/settings', (_req, res) => {
  res.json(settings.all());
});

adminRouter.patch('/settings', (req, res) => {
  const body = requireObject(req.body, 'settings patch');
  const validated = validateSettingsPatch(body);
  const patch: Loose = {};
  for (const [key, value] of validated) patch[key] = value;
  settings.setMany(patch as Partial<SiteSettings>);
  const after = settings.all();
  const afterMap: Loose = { ...after };
  const changedKeys = [...validated.keys()];
  const changes: Loose = {};
  for (const key of changedKeys) {
    changes[key] = SECRET_SETTING_KEYS.has(key) ? (afterMap[key] ? '[set]' : '[cleared]') : afterMap[key];
  }
  audit(req, 'settings.update', { keys: changedKeys, changes });
  bus.publish('settings.changed', {
    changed: changedKeys,
    settings: broadcastSettings(),
    hasTmdbKey: Boolean(after.tmdbApiKey),
    hasTvdbKey: Boolean(after.tvdbApiKey),
    hasOmdbKey: Boolean(after.omdbApiKey),
    by: actor(req),
  });
  res.json({ ok: true, changed: changedKeys, settings: after });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function logFilters(req: Request, body?: Loose): LogFilters {
  const level = (typeof body?.level === 'string' ? body.level : queryString(req, 'level'))?.trim();
  if (level && !(LEVELS as readonly string[]).includes(level)) {
    throw badRequest(`level must be one of: ${LEVELS.join(', ')}.`, { allowed: LEVELS });
  }
  const scopeRaw = typeof body?.scope === 'string' ? body.scope : queryString(req, 'scope');
  const scope = scopeRaw?.trim().slice(0, 60) || undefined;
  const qRaw = typeof body?.q === 'string' ? body.q : queryString(req, 'q');
  const q = qRaw?.trim().slice(0, 200) || undefined;
  const daysRaw = body?.olderThanDays ?? queryInt(req, 'olderThanDays');
  let olderThanDays: number | undefined;
  if (daysRaw !== undefined) {
    const days = Number(daysRaw);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      throw badRequest('olderThanDays must be between 0 and 3650.', { olderThanDays: daysRaw });
    }
    olderThanDays = Math.floor(days);
  }
  return { level, scope, q, olderThanDays };
}

function logWhere(filters: LogFilters): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.level) {
    where.push('level = ?');
    params.push(filters.level);
  }
  if (filters.scope) {
    where.push('scope = ?');
    params.push(filters.scope);
  }
  if (filters.q) {
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&');
    where.push("(message LIKE ? ESCAPE '\\' OR meta LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (filters.olderThanDays !== undefined) {
    where.push('created_at < ?');
    params.push(new Date(Date.now() - filters.olderThanDays * 24 * 60 * 60 * 1000).toISOString());
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

adminRouter.get('/logs', (req, res) => {
  const filters = logFilters(req);
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 100, maxPageSize: 500 });
  const { clause, params } = logWhere(filters);
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM logs ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT id, level, scope, message, meta, created_at FROM logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as LogRow[];
  const byLevel: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of db.prepare('SELECT level, COUNT(*) AS n FROM logs GROUP BY level').all() as { level: string; n: number }[]) {
    if (row.level in byLevel) byLevel[row.level] = row.n;
  }
  const scopes = (db.prepare('SELECT DISTINCT scope FROM logs ORDER BY scope LIMIT 60').all() as { scope: string }[]).map((row) => row.scope);
  res.json({ items: rows.map(logToDTO), total, page, pageSize, byLevel, scopes });
});

adminRouter.delete('/logs', (req, res) => {
  const body = req.body ? requireObject(req.body) : {};
  const filters = logFilters(req, body);
  const { clause, params } = logWhere(filters);
  const deleted = getDb().prepare(`DELETE FROM logs ${clause}`).run(...params).changes;
  audit(req, 'logs.delete', { filters, deleted });
  res.json({ ok: true, deleted });
});

adminRouter.get('/logs/export', (req, res) => {
  const filters = logFilters(req);
  const limit = clamp(queryInt(req, 'limit') ?? 5000, 1, 50000);
  const { clause, params } = logWhere(filters);
  const rows = getDb()
    .prepare(`SELECT id, level, scope, message, meta, created_at FROM logs ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as LogRow[];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aislop-logs-${stamp}.jsonl"`);
  for (const row of rows) res.write(`${JSON.stringify(logToDTO(row))}\n`);
  res.end();
  audit(req, 'logs.export', { filters, exported: rows.length });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USER_SORTS: Record<string, string> = {
  created: 'u.created_at',
  username: 'u.username',
  lastLogin: 'u.last_login_at',
  role: 'u.role',
  id: 'u.id',
};

function enabledOtherAdmins(excludeId: number): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
      .get(excludeId) as { n: number }
  ).n;
}

function userListItem(row: UserListRow): Loose {
  return { ...toUserDTO(row), hasPin: Boolean(row.pin_hash), activeSessions: row.active_sessions };
}

function fetchUserListItem(id: number): Loose {
  const row = getDb()
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
       FROM users u WHERE u.id = ?`,
    )
    .get(nowISO(), id) as UserListRow | undefined;
  if (!row) throw notFound('That user does not exist. Invented, perhaps?');
  return userListItem(row);
}

function revokeUserSessions(userId: number): number {
  return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

adminRouter.get('/users', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 50, maxPageSize: 200 });
  const role = queryString(req, 'role');
  if (role && !ROLES.includes(role as Role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}.`, { allowed: ROLES });
  const q = queryString(req, 'q')?.slice(0, 80);
  const sortKey = queryString(req, 'sort') || 'created';
  const sortColumn = USER_SORTS[sortKey];
  if (!sortColumn) throw badRequest(`sort must be one of: ${Object.keys(USER_SORTS).join(', ')}.`, { allowed: Object.keys(USER_SORTS) });
  const order = (queryString(req, 'order') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where: string[] = [];
  const params: unknown[] = [];
  if (role) {
    where.push('u.role = ?');
    params.push(role);
  }
  if (q) {
    const escaped = q.replace(/[\\%_]/g, '\\$&');
    where.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
       FROM users u ${clause} ORDER BY ${sortColumn} ${order}, u.id ASC LIMIT ? OFFSET ?`,
    )
    .all(nowISO(), ...params, pageSize, offset) as UserListRow[];
  const byRole: Record<string, number> = { admin: 0, manager: 0, user: 0 };
  for (const row of db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all() as { role: string; n: number }[]) {
    if (row.role in byRole) byRole[row.role] = row.n;
  }
  res.json({ items: rows.map(userListItem), total, page, pageSize, byRole });
});

adminRouter.post('/users', (req, res) => {
  const body = requireObject(req.body, 'user body');
  const usernameRaw = body.username;
  if (typeof usernameRaw !== 'string' || !/^[a-zA-Z0-9_.-]{2,32}$/.test(usernameRaw.trim())) {
    throw badRequest('Username must be 2-32 characters: letters, numbers, dot, dash, underscore.', { field: 'username' });
  }
  const username = usernameRaw.trim();
  const password = body.password;
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    throw badRequest('Password must be 6-200 characters. Security through vibes has limits.', { field: 'password' });
  }
  const roleRaw = body.role ?? 'user';
  if (typeof roleRaw !== 'string' || !ROLES.includes(roleRaw as Role)) {
    throw badRequest(`role must be one of: ${ROLES.join(', ')}.`, { field: 'role', allowed: ROLES });
  }
  const displayNameRaw = body.displayName;
  if (displayNameRaw !== undefined && (typeof displayNameRaw !== 'string' || displayNameRaw.trim().length < 1 || displayNameRaw.trim().length > 40)) {
    throw badRequest('displayName must be 1-40 characters.', { field: 'displayName' });
  }
  if (getDb().prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw conflict('That username is taken. Pick a less goated one.');
  }
  const hue = Math.floor(Math.random() * 360);
  const info = getDb()
    .prepare(
      `INSERT INTO users(username, display_name, password_hash, role, avatar_hue, preferences, created_at)
       VALUES(?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(username, (displayNameRaw as string | undefined)?.trim() || username, hashPassword(password), roleRaw, hue, nowISO());
  const user = fetchUserListItem(Number(info.lastInsertRowid));
  audit(req, 'users.create', { targetId: user.id, username, role: roleRaw });
  res.status(201).json({ ok: true, user });
});

adminRouter.patch('/users/:id', (req, res) => {
  const id = idParam(req);
  const target = findUserById(id);
  if (!target) throw notFound('That user does not exist. Invented, perhaps?');
  const body = requireObject(req.body, 'user patch');
  const allowed = new Set(['role', 'disabled', 'displayName', 'pin']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw badRequest(`Field "${key}" is not editable here.`, { field: key, allowed: [...allowed] });
  }
  if (Object.keys(body).length === 0) throw badRequest('Nothing to update. Bold strategy.');

  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Loose = {};
  let revokeSessions = false;

  if ('role' in body) {
    const role = body.role;
    if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
      throw badRequest(`role must be one of: ${ROLES.join(', ')}.`, { field: 'role', allowed: ROLES });
    }
    if (target.role === 'admin' && !target.disabled && role !== 'admin' && enabledOtherAdmins(target.id) === 0) {
      throw conflict('Cannot demote the last enabled admin. You would be ruling an empty kingdom.');
    }
    sets.push('role = ?');
    params.push(role);
    changes.role = role;
  }

  if ('disabled' in body) {
    const disabled = body.disabled;
    if (typeof disabled !== 'boolean') throw badRequest('disabled must be a boolean.', { field: 'disabled' });
    if (disabled) {
      if (target.role === 'admin' && enabledOtherAdmins(target.id) === 0) {
        throw conflict('Cannot disable the last enabled admin. The slop council needs one adult.');
      }
      revokeSessions = true;
    }
    sets.push('disabled = ?');
    params.push(disabled ? 1 : 0);
    changes.disabled = disabled;
  }

  if ('displayName' in body) {
    const displayName = body.displayName;
    if (typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.trim().length > 40) {
      throw badRequest('displayName must be 1-40 characters.', { field: 'displayName' });
    }
    sets.push('display_name = ?');
    params.push(displayName.trim());
    changes.displayName = displayName.trim();
  }

  if ('pin' in body) {
    const pin = body.pin;
    if (pin !== null && (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin))) {
      throw badRequest('pin must be 4-8 digits, or null to clear it.', { field: 'pin' });
    }
    sets.push('pin_hash = ?');
    params.push(pin === null ? null : hashPassword(pin));
    changes.hasPin = pin !== null;
  }

  if (sets.length === 0) throw badRequest('Nothing to update. Bold strategy.');
  params.push(id);
  getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const sessionsRevoked = revokeSessions ? revokeUserSessions(id) : 0;
  const user = fetchUserListItem(id);
  audit(req, 'users.update', { targetId: id, username: target.username, changes, sessionsRevoked });
  res.json({ ok: true, user, sessionsRevoked });
});

adminRouter.delete('/users/:id', (req, res) => {
  const id = idParam(req);
  const target = findUserById(id);
  if (!target) throw notFound('That user does not exist. Invented, perhaps?');
  const who = actor(req);
  if (id === who.id) throw badRequest('Deleting yourself is not a personality trait. Ask another admin.', { field: 'id' });
  if (target.role === 'admin' && !target.disabled && enabledOtherAdmins(target.id) === 0) {
    throw conflict('Cannot delete the last enabled admin. This box would become a republic of one.');
  }
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(req, 'users.delete', { targetId: id, username: target.username });
  res.json({ ok: true, deleted: true });
});

adminRouter.post('/users/:id/reset-password', (req, res) => {
  const id = idParam(req);
  const target = findUserById(id);
  if (!target) throw notFound('That user does not exist. Invented, perhaps?');
  const body = req.body ? requireObject(req.body, 'password reset') : {};
  const supplied = body.password;
  if (supplied !== undefined && (typeof supplied !== 'string' || supplied.length < 6 || supplied.length > 200)) {
    throw badRequest('Password must be 6-200 characters.', { field: 'password' });
  }
  const generated = supplied === undefined;
  const password = generated ? randomToken(12).slice(0, 12) : (supplied as string);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  const sessionsRevoked = revokeUserSessions(id);
  audit(req, 'users.reset_password', { targetId: id, username: target.username, generated, sessionsRevoked });
  res.json({
    ok: true,
    user: fetchUserListItem(id),
    generated,
    sessionsRevoked,
    ...(generated ? { password } : {}),
  });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

interface InviteRow {
  id: string;
  code: string;
  role: string;
  created_by: number | null;
  expires_at: string | null;
  used_by: number | null;
  used_at: string | null;
  created_at: string;
  created_username: string | null;
  created_display: string | null;
  used_username: string | null;
  used_display: string | null;
}

function inviteDTO(row: InviteRow): Loose {
  const now = Date.now();
  const expired = row.expires_at !== null && new Date(row.expires_at).getTime() <= now;
  return {
    id: row.id,
    code: row.code,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    expired,
    valid: !row.used_by && !expired,
    usedBy: row.used_by
      ? { id: row.used_by, username: row.used_username, displayName: row.used_display }
      : null,
    createdBy: row.created_by
      ? { id: row.created_by, username: row.created_username, displayName: row.created_display }
      : null,
  };
}

function fetchInviteByCode(code: string): Loose {
  const row = getDb()
    .prepare(
      `SELECT i.*, cu.username AS created_username, cu.display_name AS created_display,
              uu.username AS used_username, uu.display_name AS used_display
       FROM invites i
       LEFT JOIN users cu ON cu.id = i.created_by
       LEFT JOIN users uu ON uu.id = i.used_by
       WHERE i.code = ?`,
    )
    .get(code) as InviteRow | undefined;
  if (!row) throw notFound('Invite vanished into the void.');
  return inviteDTO(row);
}

adminRouter.get('/invites', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 50, maxPageSize: 200 });
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT i.*, cu.username AS created_username, cu.display_name AS created_display,
              uu.username AS used_username, uu.display_name AS used_display
       FROM invites i
       LEFT JOIN users cu ON cu.id = i.created_by
       LEFT JOIN users uu ON uu.id = i.used_by
       ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as InviteRow[];
  res.json({ items: rows.map(inviteDTO), total, page, pageSize });
});

adminRouter.post('/invites', (req, res) => {
  const body = req.body ? requireObject(req.body, 'invite body') : {};
  const role = body.role ?? 'user';
  if (role !== 'user' && role !== 'manager') {
    throw badRequest('Invites can grant user or manager only. Admins are appointed, not mass-produced.', {
      field: 'role',
      allowed: ['user', 'manager'],
    });
  }
  const ttlRaw = body.ttlHours ?? 72;
  if (typeof ttlRaw !== 'number' || !Number.isInteger(ttlRaw) || ttlRaw < 1 || ttlRaw > 720) {
    throw badRequest('ttlHours must be an integer between 1 and 720.', { field: 'ttlHours' });
  }
  const who = actor(req);
  const issued = issueInvite(who.id, role, ttlRaw);
  const invite = fetchInviteByCode(issued.code);
  audit(req, 'invites.create', { inviteId: invite.id, role, ttlHours: ttlRaw });
  res.status(201).json({ ok: true, invite });
});

adminRouter.delete('/invites/:id', (req, res) => {
  const id = req.params.id;
  const row = getDb().prepare('SELECT id, role, used_by FROM invites WHERE id = ?').get(id) as
    | { id: string; role: string; used_by: number | null }
    | undefined;
  if (!row) throw notFound('Invite vanished into the void.');
  getDb().prepare('DELETE FROM invites WHERE id = ?').run(id);
  audit(req, 'invites.delete', { inviteId: id, role: row.role, used: Boolean(row.used_by) });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Moderation reports (creation lives with social; review lives here)
// ---------------------------------------------------------------------------

interface ReportListRow extends ReportRow {
  media_title: string | null;
  media_kind: string | null;
  reporter_username: string | null;
  reporter_display: string | null;
  resolver_username: string | null;
  resolver_display: string | null;
}

const REPORT_SQL = `SELECT r.*, m.title AS media_title, m.kind AS media_kind,
  u.username AS reporter_username, u.display_name AS reporter_display,
  rb.username AS resolver_username, rb.display_name AS resolver_display
  FROM reports r
  LEFT JOIN media m ON m.id = r.media_id
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users rb ON rb.id = r.resolved_by`;

function reportDTO(row: ReportListRow): Loose {
  return {
    id: row.id,
    mediaId: row.media_id,
    media: row.media_id ? { id: row.media_id, title: row.media_title, kind: row.media_kind } : null,
    reason: row.reason,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    reporter: row.user_id
      ? { id: row.user_id, username: row.reporter_username, displayName: row.reporter_display }
      : null,
    resolvedBy: row.resolved_by
      ? { id: row.resolved_by, username: row.resolver_username, displayName: row.resolver_display }
      : null,
  };
}

function fetchReport(id: number): Loose {
  const row = getDb().prepare(`${REPORT_SQL} WHERE r.id = ?`).get(id) as ReportListRow | undefined;
  if (!row) throw notFound('Report not found. Maybe it got ratioed out of existence.');
  return reportDTO(row);
}

adminRouter.get('/reports', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 50, maxPageSize: 200 });
  const status = queryString(req, 'status');
  if (status && !(REPORT_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of: ${REPORT_STATUSES.join(', ')}.`, { allowed: REPORT_STATUSES });
  }
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM reports r ${clause}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`${REPORT_SQL} ${clause} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as ReportListRow[];
  const byStatus: Record<string, number> = { open: 0, resolved: 0, dismissed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status').all() as { status: string; n: number }[]) {
    if (row.status in byStatus) byStatus[row.status] = row.n;
  }
  res.json({ items: rows.map(reportDTO), total, page, pageSize, byStatus });
});

adminRouter.patch('/reports/:id', (req, res) => {
  const id = idParam(req);
  const existing = getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
  if (!existing) throw notFound('Report not found. Maybe it got ratioed out of existence.');
  const body = requireObject(req.body, 'report review');
  const allowed = new Set(['status', 'notes']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw badRequest(`Field "${key}" is not editable here.`, { field: key, allowed: [...allowed] });
  }
  let status = existing.status;
  if ('status' in body) {
    if (typeof body.status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(body.status)) {
      throw badRequest(`status must be one of: ${REPORT_STATUSES.join(', ')}.`, { field: 'status', allowed: REPORT_STATUSES });
    }
    status = body.status as ReportRow['status'];
  }
  let notes = existing.notes;
  if ('notes' in body) {
    if (typeof body.notes !== 'string' || body.notes.length > 2000) {
      throw badRequest('notes must be a string of at most 2000 characters.', { field: 'notes' });
    }
    notes = body.notes;
  }
  if (!('status' in body) && !('notes' in body)) throw badRequest('Nothing to update. Review harder.');
  const who = actor(req);
  const resolvedAt = status === 'open' ? null : existing.resolved_at ?? nowISO();
  const resolvedBy = status === 'open' ? null : who.id;
  getDb()
    .prepare('UPDATE reports SET status = ?, notes = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(status, notes, resolvedBy, resolvedAt, id);
  audit(req, 'reports.review', { reportId: id, status, notesChanged: 'notes' in body });
  res.json({ ok: true, report: fetchReport(id) });
});

// ---------------------------------------------------------------------------
// Requests review (alias of the social requests API for admin convenience)
// ---------------------------------------------------------------------------

interface RequestListRow extends RequestRow {
  requester_username: string | null;
  requester_display: string | null;
  reviewer_username: string | null;
  reviewer_display: string | null;
}

const REQUEST_SQL = `SELECT r.*, u.username AS requester_username, u.display_name AS requester_display,
  rv.username AS reviewer_username, rv.display_name AS reviewer_display
  FROM requests r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by`;

function requestDTO(row: RequestListRow): Loose {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    kind: row.kind,
    year: row.year,
    note: row.note,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requester: row.user_id
      ? { id: row.user_id, username: row.requester_username, displayName: row.requester_display }
      : null,
    reviewer: row.reviewed_by
      ? { id: row.reviewed_by, username: row.reviewer_username, displayName: row.reviewer_display }
      : null,
  };
}

function fetchRequest(id: number): Loose {
  const row = getDb().prepare(`${REQUEST_SQL} WHERE r.id = ?`).get(id) as RequestListRow | undefined;
  if (!row) throw notFound('Request not found. It never wanted to be here anyway.');
  return requestDTO(row);
}

adminRouter.get('/requests', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 50, maxPageSize: 200 });
  const status = queryString(req, 'status');
  if (status && !(REQUEST_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of: ${REQUEST_STATUSES.join(', ')}.`, { allowed: REQUEST_STATUSES });
  }
  const kind = queryString(req, 'kind');
  if (kind && !(REQUEST_KINDS as readonly string[]).includes(kind)) {
    throw badRequest(`kind must be one of: ${REQUEST_KINDS.join(', ')}.`, { allowed: REQUEST_KINDS });
  }
  const q = queryString(req, 'q')?.slice(0, 120);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (kind) {
    where.push('r.kind = ?');
    params.push(kind);
  }
  if (q) {
    const escaped = q.replace(/[\\%_]/g, '\\$&');
    where.push("(r.title LIKE ? ESCAPE '\\' OR r.note LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM requests r ${clause}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`${REQUEST_SQL} ${clause} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as RequestListRow[];
  const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0, fulfilled: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all() as { status: string; n: number }[]) {
    if (row.status in byStatus) byStatus[row.status] = row.n;
  }
  res.json({ items: rows.map(requestDTO), total, page, pageSize, byStatus });
});

adminRouter.patch('/requests/:id', (req, res) => {
  const id = idParam(req);
  const existing = getDb().prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!existing) throw notFound('Request not found. It never wanted to be here anyway.');
  const body = requireObject(req.body, 'request review');
  const allowed = new Set(['status', 'reviewNote']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw badRequest(`Field "${key}" is not editable here.`, { field: key, allowed: [...allowed] });
  }
  let status = existing.status;
  if ('status' in body) {
    if (typeof body.status !== 'string' || !(REQUEST_STATUSES as readonly string[]).includes(body.status)) {
      throw badRequest(`status must be one of: ${REQUEST_STATUSES.join(', ')}.`, { field: 'status', allowed: REQUEST_STATUSES });
    }
    status = body.status as RequestRow['status'];
  }
  let reviewNote = existing.review_note;
  if ('reviewNote' in body) {
    if (typeof body.reviewNote !== 'string' || body.reviewNote.length > 2000) {
      throw badRequest('reviewNote must be a string of at most 2000 characters.', { field: 'reviewNote' });
    }
    reviewNote = body.reviewNote;
  }
  if (!('status' in body) && !('reviewNote' in body)) throw badRequest('Nothing to update. Review harder.');
  const who = actor(req);
  getDb()
    .prepare('UPDATE requests SET status = ?, review_note = ?, reviewed_by = ?, updated_at = ? WHERE id = ?')
    .run(status, reviewNote, status === 'pending' ? null : who.id, nowISO(), id);
  audit(req, 'requests.review', { requestId: id, status });
  res.json({ ok: true, request: fetchRequest(id) });
});

// ---------------------------------------------------------------------------
// Storage / server stats
// ---------------------------------------------------------------------------

interface CountRow {
  n: number;
}

interface WatchTotalsRow {
  total_seconds: number;
  total_plays: number;
  watchers: number;
  finished: number;
}

interface GenreWatchRow {
  genre: string;
  seconds: number;
  plays: number;
  items: number;
}

interface WatchAggRow {
  media_id: number;
  plays: number;
  seconds: number;
}

interface KindStorageRow {
  kind: string;
  items: number;
  bytes: number;
}

interface LibraryStorageRow {
  id: number;
  name: string;
  kind: string;
  path: string;
  items: number;
  bytes: number;
}

interface ActiveStreamRow {
  id: string;
  user_id: number | null;
  media_id: number | null;
  mode: string;
  client: string | null;
  position: number;
  started_at: string;
  last_seen_at: string;
  bytes_sent: number;
  username: string | null;
  display_name: string | null;
  title: string | null;
  kind: string | null;
}

interface WatchRecentRow {
  user_id: number;
  media_id: number;
  position_seconds: number;
  duration_seconds: number;
  finished: number;
  updated_at: string;
  username: string | null;
  title: string | null;
  kind: string | null;
}

interface DBTableRow {
  name: string;
}

interface DBStats {
  path: string;
  sizeBytes: number;
  walBytes: number;
  totalBytes: number;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  freePages: number;
  tables: { name: string; rows: number }[];
}

function scalar(sql: string, ...params: unknown[]): number {
  const row = getDb().prepare(sql).get(...params) as CountRow | undefined;
  return row?.n ?? 0;
}

function dbStats(): DBStats {
  const db = getDb();
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const freePages = Number(db.pragma('freelist_count', { simple: true }));
  const journalMode = String(db.pragma('journal_mode', { simple: true }));
  const sizeBytes = fileSize(paths.db);
  const walBytes = fileSize(`${paths.db}-wal`);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as DBTableRow[];
  const rows = tables.map((table) => {
    const quoted = `"${table.name.replace(/"/g, '""')}"`;
    return { name: table.name, rows: scalar(`SELECT COUNT(*) AS n FROM ${quoted}`) };
  });
  return {
    path: paths.db,
    sizeBytes,
    walBytes,
    totalBytes: sizeBytes + walBytes,
    journalMode,
    pageSize,
    pageCount,
    freePages,
    tables: rows,
  };
}

function buildStorage(): Loose {
  const db = getDb();
  const mediaTotals = db
    .prepare('SELECT COUNT(*) AS items, COALESCE(SUM(size_bytes), 0) AS bytes FROM media')
    .get() as { items: number; bytes: number };
  const byKind = db
    .prepare('SELECT kind, COUNT(*) AS items, COALESCE(SUM(size_bytes), 0) AS bytes FROM media GROUP BY kind ORDER BY bytes DESC')
    .all() as KindStorageRow[];
  const libraries = db
    .prepare(
      `SELECT l.id, l.name, l.kind, l.path, COUNT(m.id) AS items, COALESCE(SUM(m.size_bytes), 0) AS bytes
       FROM libraries l LEFT JOIN media m ON m.library_id = l.id
       GROUP BY l.id ORDER BY bytes DESC`,
    )
    .all() as LibraryStorageRow[];
  const imageStats = dirStats(paths.images);
  const transcodeStats = dirStats(paths.transcode);
  const subtitleStats = dirStats(path.join(paths.cache, 'subtitles'));
  const tempStats = dirStats(paths.temp);
  const logStats = dirStats(paths.logs);
  const cacheTotalBytes = imageStats.bytes + transcodeStats.bytes + subtitleStats.bytes + tempStats.bytes + logStats.bytes;
  const cacheTotalFiles = imageStats.files + transcodeStats.files + subtitleStats.files + tempStats.files + logStats.files;
  let artBytes = 0;
  const artRows = db.prepare('SELECT path FROM media_art').all() as { path: string }[];
  for (const row of artRows) artBytes += fileSize(row.path);
  const database = dbStats();
  const disk = diskInfo(paths.data);
  return {
    mediaBytes: mediaTotals.bytes,
    mediaItems: mediaTotals.items,
    byKind,
    libraries: libraries.map((library) => ({ ...library, exists: fs.existsSync(library.path) })),
    cache: {
      root: paths.cache,
      totalBytes: cacheTotalBytes,
      totalFiles: cacheTotalFiles,
      images: imageStats,
      transcode: transcodeStats,
      subtitles: subtitleStats,
      temp: tempStats,
      logs: logStats,
    },
    db: { bytes: database.sizeBytes, path: database.path, walBytes: database.walBytes },
    art: { count: artRows.length, bytes: artBytes },
    disk,
  };
}

function jobStatusCounts(): Record<string, number> {
  const counts: Record<string, number> = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as { status: string; n: number }[];
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row.n;
  }
  return counts;
}

function buildWatchStats(): Loose {
  const db = getDb();
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(position_seconds), 0) AS total_seconds,
              COALESCE(SUM(play_count), 0) AS total_plays,
              COUNT(DISTINCT user_id) AS watchers,
              COALESCE(SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END), 0) AS finished
       FROM progress`,
    )
    .get() as WatchTotalsRow;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const last24hSeconds = scalar('SELECT COALESCE(SUM(position_seconds), 0) AS n FROM progress WHERE updated_at >= ?', since);
  const topGenres = db
    .prepare(
      `SELECT g.genre AS genre, COALESCE(SUM(p.position_seconds), 0) AS seconds,
              COALESCE(SUM(p.play_count), 0) AS plays, COUNT(DISTINCT p.media_id) AS items
       FROM progress p JOIN media_genres g ON g.media_id = p.media_id
       GROUP BY g.genre ORDER BY seconds DESC, plays DESC LIMIT 8`,
    )
    .all() as GenreWatchRow[];
  const recent = db
    .prepare(
      `SELECT p.user_id, p.media_id, p.position_seconds, p.duration_seconds, p.finished, p.updated_at,
              u.username, m.title, m.kind
       FROM progress p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN media m ON m.id = p.media_id
       ORDER BY p.updated_at DESC LIMIT 10`,
    )
    .all() as WatchRecentRow[];
  return {
    totalSeconds: totals.total_seconds,
    totalPlays: totals.total_plays,
    watchers: totals.watchers,
    finishedCount: totals.finished,
    last24hSeconds,
    topGenres,
    recent: recent.map((row) => ({
      userId: row.user_id,
      username: row.username,
      mediaId: row.media_id,
      title: row.title,
      kind: row.kind,
      positionSeconds: row.position_seconds,
      durationSeconds: row.duration_seconds,
      finished: Boolean(row.finished),
      updatedAt: row.updated_at,
    })),
  };
}

function buildTopMedia(): Loose {
  const db = getDb();
  const largestRows = db
    .prepare(
      `SELECT * FROM media WHERE hidden = 0 AND kind IN ('movie','episode','track','photo','video')
       ORDER BY COALESCE(size_bytes, 0) DESC LIMIT 8`,
    )
    .all() as MediaRow[];
  const largestDTOs = mediaRowsToDTO(largestRows);
  const largest = largestRows.map((row, index) => ({ item: largestDTOs[index], bytes: row.size_bytes ?? 0 }));

  const playRows = db
    .prepare(
      `SELECT media_id, COALESCE(SUM(play_count), 0) AS plays, COALESCE(SUM(position_seconds), 0) AS seconds
       FROM progress GROUP BY media_id ORDER BY plays DESC, seconds DESC LIMIT 8`,
    )
    .all() as WatchAggRow[];
  let mostPlayed: Loose[] = [];
  if (playRows.length > 0) {
    const placeholders = playRows.map(() => '?').join(', ');
    const mediaRows = db
      .prepare(`SELECT * FROM media WHERE id IN (${placeholders}) AND hidden = 0`)
      .all(...playRows.map((row) => row.media_id)) as MediaRow[];
    const dtos = mediaRowsToDTO(mediaRows);
    const byId = new Map<number, (typeof dtos)[number]>();
    for (const row of mediaRows) {
      const dto = dtos.find((candidate) => candidate.id === row.id);
      if (dto) byId.set(row.id, dto);
    }
    mostPlayed = playRows
      .map((row) => ({ item: byId.get(row.media_id), plays: row.plays, seconds: row.seconds }))
      .filter((entry) => entry.item !== undefined);
  }
  return { largest, mostPlayed };
}

adminRouter.get('/storage', (_req, res) => {
  res.json(buildStorage());
});

adminRouter.get('/overview', (_req, res) => {
  const db = getDb();
  const now = new Date();
  const activeSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const mediaByKind: Record<string, number> = {};
  for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM media GROUP BY kind').all() as { kind: string; n: number }[]) {
    mediaByKind[row.kind] = row.n;
  }
  const dbInfo = dbStats();
  const counts = {
    users: scalar('SELECT COUNT(*) AS n FROM users'),
    admins: scalar("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
    libraries: scalar('SELECT COUNT(*) AS n FROM libraries'),
    media: scalar('SELECT COUNT(*) AS n FROM media'),
    hiddenMedia: scalar('SELECT COUNT(*) AS n FROM media WHERE hidden = 1'),
    art: scalar('SELECT COUNT(*) AS n FROM media_art'),
    subtitles: scalar('SELECT COUNT(*) AS n FROM subtitles'),
    collections: scalar('SELECT COUNT(*) AS n FROM collections'),
    playlists: scalar('SELECT COUNT(*) AS n FROM playlists'),
    requests: scalar('SELECT COUNT(*) AS n FROM requests'),
    openReports: scalar("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    sessions: scalar('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', nowISO()),
    invitesActive: scalar('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)', nowISO()),
    mediaByKind,
  };

  const streamRows = db
    .prepare(
      `SELECT s.id, s.user_id, s.media_id, s.mode, s.client, s.position, s.started_at, s.last_seen_at, s.bytes_sent,
              u.username, u.display_name, m.title, m.kind
       FROM streams s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN media m ON m.id = s.media_id
       WHERE s.last_seen_at >= ? ORDER BY s.last_seen_at DESC LIMIT 20`,
    )
    .all(activeSince) as ActiveStreamRow[];

  const recentLogRows = db
    .prepare('SELECT id, level, scope, message, meta, created_at FROM logs ORDER BY id DESC LIMIT 20')
    .all() as LogRow[];
  const byLevel: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of db.prepare('SELECT level, COUNT(*) AS n FROM logs GROUP BY level').all() as { level: string; n: number }[]) {
    if (row.level in byLevel) byLevel[row.level] = row.n;
  }

  const jobCounts = jobStatusCounts();
  const jobTotal = Object.values(jobCounts).reduce((sum, value) => sum + value, 0);
  const memory = process.memoryUsage();
  const allSettings = settings.all();
  const info = serverInfo();

  res.json({
    generatedAt: now.toISOString(),
    server: {
      ...info,
      startedAt: new Date(info.startedAt).toISOString(),
      host: config.host,
      port: config.port,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
    },
    database: dbInfo,
    disk: diskInfo(paths.data),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      systemTotalBytes: os.totalmem(),
      systemFreeBytes: os.freemem(),
    },
    counts,
    streams: {
      active: streamRows.length,
      items: streamRows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        mediaId: row.media_id,
        title: row.title,
        kind: row.kind,
        mode: row.mode,
        client: row.client,
        position: row.position,
        startedAt: row.started_at,
        lastSeenAt: row.last_seen_at,
        bytesSent: row.bytes_sent,
      })),
    },
    logs: {
      total: scalar('SELECT COUNT(*) AS n FROM logs'),
      byLevel,
      recent: recentLogRows.map(logToDTO),
    },
    jobs: {
      counts: { ...jobCounts, total: jobTotal },
      active: jobQueue.active(),
      recent: jobQueue.list({ limit: 10 }).items,
    },
    storage: buildStorage(),
    topMedia: buildTopMedia(),
    watch: buildWatchStats(),
    settingsSummary: {
      serverName: allSettings.serverName,
      maintenanceMode: allSettings.maintenanceMode,
      allowSignups: allSettings.allowSignups,
      requireInvite: allSettings.requireInvite,
      allowRequests: allSettings.allowRequests,
      allowParties: allSettings.allowParties,
      tmdbConfigured: Boolean(allSettings.tmdbApiKey || config.tmdbApiKey),
    },
  });
});

// ---------------------------------------------------------------------------
// Privacy audit
// ---------------------------------------------------------------------------

adminRouter.get('/privacy', (_req, res) => {
  const all = settings.all();
  const statuses = providerStatuses();
  const envConfigured: Record<ProviderId, boolean> = {
    tmdb: Boolean(config.tmdbApiKey),
    tvdb: Boolean(config.tvdbApiKey),
    omdb: Boolean(config.omdbApiKey),
    tvmaze: false,
    imdb: false,
  };
  const settingConfigured: Record<ProviderId, boolean> = {
    tmdb: Boolean(all.tmdbApiKey),
    tvdb: Boolean(all.tvdbApiKey),
    omdb: Boolean(all.omdbApiKey),
    tvmaze: false,
    imdb: false,
  };
  const toggles: Record<ProviderId, boolean> = {
    tmdb: true,
    tvdb: true,
    omdb: true,
    tvmaze: all.tvmazeEnabled === true,
    imdb: all.imdbEnabled === true,
  };
  const keySources: Record<ProviderId, 'env' | 'settings' | 'none'> = {
    tmdb: envConfigured.tmdb ? 'env' : settingConfigured.tmdb ? 'settings' : 'none',
    tvdb: envConfigured.tvdb ? 'env' : settingConfigured.tvdb ? 'settings' : 'none',
    omdb: envConfigured.omdb ? 'env' : settingConfigured.omdb ? 'settings' : 'none',
    tvmaze: 'none',
    imdb: 'none',
  };
  const apiHosts: Record<ProviderId, string> = {
    tmdb: 'api.themoviedb.org',
    tvdb: 'api4.thetvdb.com',
    omdb: 'www.omdbapi.com',
    tvmaze: 'api.tvmaze.com',
    imdb: 'v2.sg.media-imdb.com',
  };

  interface OutboundEndpoint {
    host: string;
    reason: string;
    enabled: true;
    modes: string[];
    providers: ProviderId[];
  }
  const endpoints = new Map<string, OutboundEndpoint>();
  for (const status of statuses) {
    // Key providers need a key; keyless ones need their explicit toggle. autoMatch only gates scans.
    if (!status.configured || !toggles[status.id]) continue;
    const modes = status.enabled ? ['manual', 'scan'] : ['manual'];
    for (const host of status.hosts) {
      const reason =
        host === apiHosts[status.id]
          ? `${status.label} metadata API: manual matching whenever configured; automatic scans only when autoMatch is on`
          : `${status.label} artwork download after a successful match`;
      const existing = endpoints.get(host);
      if (existing) {
        for (const mode of modes) if (!existing.modes.includes(mode)) existing.modes.push(mode);
        if (!existing.providers.includes(status.id)) existing.providers.push(status.id);
      } else {
        endpoints.set(host, { host, reason, enabled: true, modes: [...modes], providers: [status.id] });
      }
    }
  }
  const outboundEndpoints = [...endpoints.values()];
  const zeroOutbound = outboundEndpoints.length === 0;
  const tmdbStatus = statuses.find((status) => status.id === 'tmdb')!;
  const tvdbStatus = statuses.find((status) => status.id === 'tvdb')!;
  const omdbStatus = statuses.find((status) => status.id === 'omdb')!;
  const tvmazeStatus = statuses.find((status) => status.id === 'tvmaze')!;
  const imdbStatus = statuses.find((status) => status.id === 'imdb')!;

  res.json({
    // Any configured provider (including keyless toggles) can make outbound calls, manual or automatic.
    zeroOutbound,
    outboundNote: zeroOutbound
      ? 'No outbound hosts configured. Metadata, art, logs and streaming stay local.'
      : 'Metadata providers are enabled: manual matching may call the listed hosts; automatic scans only when autoMatch is on and the provider is eligible. Telemetry, analytics and third-party scripts stay off.',
    telemetry: false,
    analytics: false,
    externalFonts: 0,
    cdnAssets: 0,
    thirdPartyScripts: 0,
    outboundEndpoints,
    providers: statuses.map((status) => ({
      ...status,
      keySource: keySources[status.id],
      toggle: toggles[status.id],
    })),
    tmdb: {
      configured: tmdbStatus.configured,
      source: keySources.tmdb,
      autoMatch: all.autoMatch === true,
      manualMatching: tmdbStatus.configured,
      autoMatching: tmdbStatus.enabled,
      host: 'api.themoviedb.org',
      imageHost: 'image.tmdb.org',
    },
    tvdb: {
      configured: tvdbStatus.configured,
      source: keySources.tvdb,
      enabled: tvdbStatus.enabled,
      hosts: tvdbStatus.hosts,
    },
    omdb: {
      configured: omdbStatus.configured,
      source: keySources.omdb,
      enabled: omdbStatus.enabled,
      hosts: omdbStatus.hosts,
    },
    tvmaze: {
      keyless: true,
      toggle: all.tvmazeEnabled === true,
      enabled: tvmazeStatus.enabled,
      hosts: tvmazeStatus.hosts,
    },
    imdb: {
      keyless: true,
      unofficial: true,
      toggle: all.imdbEnabled === true,
      enabled: imdbStatus.enabled,
      hosts: imdbStatus.hosts,
    },
    cookie: {
      name: 'slop_session',
      httpOnly: true,
      sameSite: 'Strict',
      secure: config.secureCookies,
      sessionDays: config.sessionDays,
    },
    passwordHashing: 'scrypt (N=16384, r=8, p=1, 64-byte key)',
    logs: { local: true, store: 'sqlite' },
    dataDir: config.dataDir,
    exports: { user: '/api/users/me/export', instance: '/api/admin/export' },
  });
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

const CACHE_TARGETS: Record<string, string> = {
  transcode: paths.transcode,
  subtitles: path.join(paths.cache, 'subtitles'),
  temp: paths.temp,
  images: paths.images,
};

adminRouter.post('/maintenance', (req, res) => {
  const body = requireObject(req.body, 'maintenance body');
  const action = body.action;
  if (typeof action !== 'string') throw badRequest('Pick a maintenance action. Actions: optimize, vacuum, clear-cache, regenerate-art, reindex.', { field: 'action' });
  const who = actor(req);
  const started = Date.now();

  if (action === 'optimize') {
    const before = dbStats();
    getDb().pragma('optimize');
    getDb().exec('ANALYZE');
    const after = dbStats();
    audit(req, 'maintenance.optimize', { bytesBefore: before.totalBytes, bytesAfter: after.totalBytes });
    res.json({
      ok: true,
      action,
      bytesBefore: before.totalBytes,
      bytesAfter: after.totalBytes,
      bytesFreed: Math.max(0, before.totalBytes - after.totalBytes),
      durationMs: Date.now() - started,
      database: { pageSize: after.pageSize, pageCount: after.pageCount, freePages: after.freePages },
    });
    return;
  }

  if (action === 'vacuum') {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
    const before = dbStats();
    getDb().exec('VACUUM');
    const after = dbStats();
    audit(req, 'maintenance.vacuum', { bytesBefore: before.totalBytes, bytesAfter: after.totalBytes });
    res.json({
      ok: true,
      action,
      bytesBefore: before.totalBytes,
      bytesAfter: after.totalBytes,
      bytesFreed: Math.max(0, before.totalBytes - after.totalBytes),
      durationMs: Date.now() - started,
    });
    return;
  }

  if (action === 'clear-cache') {
    const rawTargets = body.targets ?? ['transcode', 'subtitles', 'temp'];
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw badRequest('targets must be a non-empty array of: transcode, subtitles, temp, images.', {
        allowed: Object.keys(CACHE_TARGETS),
      });
    }
    const targets: string[] = [];
    for (const raw of rawTargets) {
      if (typeof raw !== 'string' || !(raw in CACHE_TARGETS)) {
        throw badRequest('targets must be a non-empty array of: transcode, subtitles, temp, images.', {
          allowed: Object.keys(CACHE_TARGETS),
        });
      }
      if (!targets.includes(raw)) targets.push(raw);
    }
    let freedBytes = 0;
    let removedFiles = 0;
    for (const target of targets) {
      const stats = emptyDir(CACHE_TARGETS[target]);
      freedBytes += stats.bytes;
      removedFiles += stats.files;
    }
    let artRowsCleared = 0;
    if (targets.includes('images')) {
      // Image cache was explicitly nuked, so the art index would point at ghosts.
      artRowsCleared = getDb().prepare('DELETE FROM media_art').run().changes;
      fs.mkdirSync(path.join(paths.images, 'generated'), { recursive: true });
      bus.publish('media.changed', { reason: 'art-cache-cleared', artRowsCleared });
    }
    audit(req, 'maintenance.clear_cache', { targets, freedBytes, removedFiles, artRowsCleared });
    res.json({ ok: true, action, targets, freedBytes, removedFiles, artRowsCleared, durationMs: Date.now() - started });
    return;
  }

  if (action === 'regenerate-art') {
    if (!hasJobHandler('art')) {
      throw new HttpError(
        503,
        'No art job handler is registered yet, so there is nobody to regenerate anything. Blame the scanner.',
        'job_handler_missing',
        { type: 'art' },
      );
    }
    const payload: Loose = {};
    if (body.mediaId !== undefined) {
      if (typeof body.mediaId !== 'number' || !Number.isInteger(body.mediaId) || body.mediaId <= 0) {
        throw badRequest('mediaId must be a positive integer.', { field: 'mediaId' });
      }
      payload.mediaId = body.mediaId;
    } else {
      payload.scope = 'all';
    }
    const job = jobQueue.create('art', payload, who.id);
    audit(req, 'maintenance.regenerate_art', { jobId: job.id, payload });
    res.status(202).json({ ok: true, action, queued: true, mode: 'job', jobId: job.id, job });
    return;
  }

  if (action === 'reindex') {
    if (hasJobHandler('probe')) {
      const job = jobQueue.create('probe', { scope: 'all', reason: 'admin-reindex' }, who.id);
      audit(req, 'maintenance.reindex', { mode: 'probe', jobId: job.id });
      res.status(202).json({ ok: true, action, queued: true, mode: 'probe', jobId: job.id, job });
      return;
    }
    if (hasJobHandler('scan')) {
      const libraries = getDb().prepare('SELECT id FROM libraries ORDER BY id').all() as { id: number }[];
      const jobs = libraries.map((library) => jobQueue.create('scan', { libraryId: library.id, force: true, reason: 'admin-reindex' }, who.id));
      audit(req, 'maintenance.reindex', { mode: 'scan', jobIds: jobs.map((job) => job.id) });
      res.status(202).json({
        ok: true,
        action,
        queued: true,
        mode: 'scan',
        jobs,
        jobIds: jobs.map((job) => job.id),
        message: 'Re-probe handlers unavailable; queued full library rescans instead.',
      });
      return;
    }
    getDb().exec('REINDEX');
    audit(req, 'maintenance.reindex', { mode: 'database' });
    res.json({
      ok: true,
      action,
      queued: false,
      mode: 'database',
      reindexed: true,
      jobIds: [],
      message: 'No media job handlers are registered; rebuilt SQLite indexes instead. Content metadata untouched.',
    });
    return;
  }

  throw badRequest('Unknown maintenance action. Actions: optimize, vacuum, clear-cache, regenerate-art, reindex.', {
    allowed: ['optimize', 'vacuum', 'clear-cache', 'regenerate-art', 'reindex'],
  });
});

// ---------------------------------------------------------------------------
// Instance metadata export / import (never media bytes)
// ---------------------------------------------------------------------------

interface CollectionExportRow {
  id: number;
  name: string;
  description: string;
  kind: string;
  rules: string;
  pinned: number;
  sort_order: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

interface PlaylistExportRow {
  id: number;
  name: string;
  description: string;
  kind: string;
  is_public: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

interface MetaRow {
  key: string;
  value: string;
}

function loadCollectionItems(collectionId: number): { mediaId: number; sortOrder: number; addedAt: string }[] {
  return (
    getDb()
      .prepare('SELECT media_id, sort_order, added_at FROM collection_items WHERE collection_id = ? ORDER BY sort_order ASC')
      .all(collectionId) as { media_id: number; sort_order: number; added_at: string }[]
  ).map((row) => ({ mediaId: row.media_id, sortOrder: row.sort_order, addedAt: row.added_at }));
}

function loadPlaylistItems(playlistId: number): { mediaId: number; sortOrder: number; addedAt: string }[] {
  return (
    getDb()
      .prepare('SELECT media_id, sort_order, added_at FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC')
      .all(playlistId) as { media_id: number; sort_order: number; added_at: string }[]
  ).map((row) => ({ mediaId: row.media_id, sortOrder: row.sort_order, addedAt: row.added_at }));
}

adminRouter.get('/export', (req, res) => {
  const db = getDb();
  const all = settings.all();
  const users = (db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[]).map((row) => ({
    ...toUserDTO(row),
    hasPin: Boolean(row.pin_hash),
  }));
  const libraries = db.prepare('SELECT * FROM libraries ORDER BY id').all() as Loose[];
  const mediaRows = db.prepare('SELECT * FROM media ORDER BY id').all() as Loose[];
  const mediaArt = db.prepare('SELECT * FROM media_art ORDER BY id').all() as Loose[];
  const genres = db.prepare('SELECT * FROM media_genres ORDER BY media_id').all() as Loose[];
  const tags = db.prepare('SELECT * FROM media_tags ORDER BY media_id').all() as Loose[];
  const people = db.prepare('SELECT * FROM media_people ORDER BY media_id, ord').all() as Loose[];
  const subtitles = db.prepare('SELECT * FROM subtitles ORDER BY id').all() as Loose[];
  const collections = (db.prepare('SELECT * FROM collections ORDER BY id').all() as CollectionExportRow[]).map((row) => ({
    name: row.name,
    description: row.description,
    kind: row.kind,
    rules: parseJSON(row.rules),
    pinned: Boolean(row.pinned),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: loadCollectionItems(row.id),
  }));
  const playlists = (db.prepare('SELECT * FROM playlists ORDER BY id').all() as PlaylistExportRow[]).map((row) => ({
    name: row.name,
    description: row.description,
    kind: row.kind,
    isPublic: Boolean(row.is_public),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: loadPlaylistItems(row.id),
  }));
  const requests = db.prepare('SELECT * FROM requests ORDER BY id').all() as Loose[];
  const reports = db.prepare('SELECT * FROM reports ORDER BY id').all() as Loose[];
  const schemaVersion = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as MetaRow | undefined)?.value ?? null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    exportedAt: nowISO(),
    version: config.version,
    schemaVersion,
    settings: { ...all, tmdbApiKey: '', tvdbApiKey: '', omdbApiKey: '' },
    settingsMeta: { tmdbConfigured: Boolean(all.tmdbApiKey), tmdbKeyRedacted: true },
    secretsRedacted: ['tmdbApiKey', 'tvdbApiKey', 'omdbApiKey'],
    users,
    libraries,
    media: mediaRows,
    mediaArt,
    genres,
    tags,
    people,
    subtitles,
    collections,
    playlists,
    requests,
    reports,
    counts: {
      users: users.length,
      libraries: libraries.length,
      media: mediaRows.length,
      art: mediaArt.length,
      collections: collections.length,
      playlists: playlists.length,
    },
  };
  audit(req, 'export.instance', { counts: payload.counts });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aislop-metadata-${stamp}.json"`);
  res.json(payload);
});

interface ImportCounts {
  settings: number;
  libraries: number;
  collections: number;
  playlists: number;
}

interface ImportSkip {
  kind: string;
  reason: string;
}

/**
 * Mirrors src/routes/libraries.ts path validation (absolute, exists, directory, never the
 * app data/cache/temp roots) with the temp root added. Imported paths are untrusted metadata.
 */
function validateImportLibraryPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('path is required');
  if (raw.includes('\0')) throw badRequest('Path contains a null byte. Respectfully, no.');
  if (!path.isAbsolute(raw.trim())) throw badRequest('Library path must be absolute');
  const resolved = path.resolve(raw.trim());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw badRequest(`Path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw badRequest('Library path must be a directory');
  const dataRoot = path.resolve(config.dataDir);
  const cacheRoot = path.resolve(config.cacheDir);
  const tempRoot = path.resolve(config.tempDir);
  const inCache = resolved === cacheRoot || resolved.startsWith(cacheRoot + path.sep);
  const inTemp = resolved === tempRoot || resolved.startsWith(tempRoot + path.sep);
  if (resolved === dataRoot || inCache || inTemp) {
    throw badRequest('Refusing to use the app data/cache/temp directory as a library. Skill issue avoided.');
  }
  return resolved;
}

/** Same bounds as the library route's per-library settings validator. */
function validateImportLibrarySettings(value: unknown): Loose {
  if (value === undefined) return {};
  const record = requireObject(value, 'library settings');
  const result: Loose = {};
  for (const [key, entry] of Object.entries(record).slice(0, 40)) {
    if (!/^[A-Za-z_][\w.-]{0,40}$/.test(key)) throw badRequest(`Invalid settings key: ${key}`);
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
      result[key] = typeof entry === 'string' ? entry.slice(0, 500) : entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === 'string' || typeof item === 'number')) {
      result[key] = entry.slice(0, 50);
    } else {
      throw badRequest(`Invalid settings value for ${key}`);
    }
  }
  if (JSON.stringify(result).length > 20_000) throw badRequest('settings payload too large');
  return result;
}

interface ImportedLibrary {
  name: string;
  kind: string;
  path: string;
  schedule: string;
  settings: Loose;
}

function parseImportLibrary(item: Loose): ImportedLibrary {
  if (typeof item.name !== 'string') throw badRequest('name must be a string');
  const name = item.name.trim();
  if (name.length < 1 || name.length > 120) throw badRequest('name must be 1-120 characters');
  if (typeof item.kind !== 'string' || !(LIBRARY_KINDS as readonly string[]).includes(item.kind)) {
    throw badRequest(`kind must be one of: ${LIBRARY_KINDS.join(', ')}`);
  }
  const libraryPath = validateImportLibraryPath(item.path);
  const schedule = item.scanSchedule === undefined ? 'daily' : item.scanSchedule;
  if (typeof schedule !== 'string' || !(SCAN_SCHEDULES as readonly string[]).includes(schedule)) {
    throw badRequest(`scanSchedule must be one of: ${SCAN_SCHEDULES.join(', ')}`);
  }
  return {
    name,
    kind: item.kind,
    path: libraryPath,
    schedule,
    settings: validateImportLibrarySettings(item.settings),
  };
}

adminRouter.post('/import', (req, res) => {
  const body = requireObject(req.body, 'import');
  const who = actor(req);
  const imported: ImportCounts = { settings: 0, libraries: 0, collections: 0, playlists: 0 };
  const skipped: ImportSkip[] = [];

  if ('settings' in body && body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      skipped.push({ kind: 'settings', reason: 'expected an object' });
    } else {
      const raw = body.settings as Loose;
      const filtered: Loose = {};
      for (const [key, value] of Object.entries(raw)) {
        if (SECRET_SETTING_KEYS.has(key) && (value === '' || value === '***redacted***' || value === null)) continue;
        filtered[key] = value;
      }
      try {
        if (Object.keys(filtered).length > 0) {
          const validated = validateSettingsPatch(filtered);
          const patch: Loose = {};
          for (const [key, value] of validated) patch[key] = value;
          settings.setMany(patch as Partial<SiteSettings>);
          imported.settings = validated.size;
          bus.publish('settings.changed', {
            changed: [...validated.keys()],
            settings: broadcastSettings(),
            hasTmdbKey: Boolean(settings.get('tmdbApiKey')),
            hasTvdbKey: Boolean(settings.get('tvdbApiKey')),
            hasOmdbKey: Boolean(settings.get('omdbApiKey')),
            by: who,
          });
        }
      } catch (error) {
        skipped.push({ kind: 'settings', reason: error instanceof Error ? error.message : 'invalid settings' });
      }
    }
  }

  if ('libraries' in body && body.libraries !== undefined) {
    if (!Array.isArray(body.libraries)) {
      skipped.push({ kind: 'libraries', reason: 'expected an array' });
    } else {
      for (const raw of body.libraries.slice(0, 1000)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          skipped.push({ kind: 'library', reason: 'not an object' });
          continue;
        }
        const item = raw as Loose;
        let parsed: ImportedLibrary;
        try {
          parsed = parseImportLibrary(item);
        } catch (error) {
          skipped.push({ kind: 'library', reason: error instanceof Error ? error.message : 'invalid library' });
          continue;
        }
        if (getDb().prepare('SELECT id FROM libraries WHERE path = ?').get(parsed.path)) {
          skipped.push({ kind: 'library', reason: `path already exists: ${parsed.path}` });
          continue;
        }
        const now = nowISO();
        getDb()
          .prepare(
            `INSERT INTO libraries(name, kind, path, scan_schedule, settings, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(parsed.name, parsed.kind, parsed.path, parsed.schedule, JSON.stringify(parsed.settings), now, now);
        imported.libraries += 1;
      }
    }
  }

  if ('collections' in body && body.collections !== undefined) {
    if (!Array.isArray(body.collections)) {
      skipped.push({ kind: 'collections', reason: 'expected an array' });
    } else {
      for (const raw of body.collections.slice(0, 1000)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          skipped.push({ kind: 'collection', reason: 'not an object' });
          continue;
        }
        const item = raw as Loose;
        const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '';
        const kind = item.kind === 'smart' ? 'smart' : item.kind === 'manual' ? 'manual' : '';
        const description = typeof item.description === 'string' ? item.description.slice(0, 500) : '';
        if (!name || !kind) {
          skipped.push({ kind: 'collection', reason: 'invalid name or kind' });
          continue;
        }
        if (getDb().prepare('SELECT id FROM collections WHERE name = ?').get(name)) {
          skipped.push({ kind: 'collection', reason: `name already exists: ${name}` });
          continue;
        }
        const rules = item.rules && typeof item.rules === 'object' ? item.rules : {};
        const now = nowISO();
        getDb()
          .prepare(
            `INSERT INTO collections(name, description, kind, rules, pinned, sort_order, created_by, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            name,
            description,
            kind,
            JSON.stringify(rules),
            item.pinned === true ? 1 : 0,
            typeof item.sortOrder === 'number' ? Math.floor(item.sortOrder) : 0,
            who.id,
            now,
            now,
          );
        imported.collections += 1;
        if (Array.isArray(item.items) && item.items.length > 0) {
          skipped.push({ kind: 'collection.items', reason: `media ids are instance-local; re-add items for "${name}"` });
        }
      }
    }
  }

  if ('playlists' in body && body.playlists !== undefined) {
    if (!Array.isArray(body.playlists)) {
      skipped.push({ kind: 'playlists', reason: 'expected an array' });
    } else {
      for (const raw of body.playlists.slice(0, 1000)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          skipped.push({ kind: 'playlist', reason: 'not an object' });
          continue;
        }
        const item = raw as Loose;
        const name = typeof item.name === 'string' ? item.name.trim().slice(0, 120) : '';
        const kind = typeof item.kind === 'string' && (PLAYLIST_KINDS as readonly string[]).includes(item.kind) ? item.kind : 'mixed';
        if (!name) {
          skipped.push({ kind: 'playlist', reason: 'invalid name' });
          continue;
        }
        if (getDb().prepare('SELECT id FROM playlists WHERE name = ?').get(name)) {
          skipped.push({ kind: 'playlist', reason: `name already exists: ${name}` });
          continue;
        }
        const description = typeof item.description === 'string' ? item.description.slice(0, 500) : '';
        const now = nowISO();
        getDb()
          .prepare(
            `INSERT INTO playlists(name, description, kind, is_public, created_by, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, description, kind, item.isPublic === false ? 0 : 1, who.id, now, now);
        imported.playlists += 1;
        if (Array.isArray(item.items) && item.items.length > 0) {
          skipped.push({ kind: 'playlist.items', reason: `media ids are instance-local; re-add items for "${name}"` });
        }
      }
    }
  }

  audit(req, 'import.instance', { imported, skipped: skipped.length });
  res.json({ ok: true, imported, skipped });
});




