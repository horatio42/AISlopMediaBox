import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { getDb, nowISO } from '../db.ts';
import { requireManager } from '../lib/auth.ts';
import { mediaRowsToDTO } from '../lib/dto.ts';
import { HttpError, badRequest, conflict, notFound, pageParams, queryString, sendPage } from '../lib/http.ts';
import type { LibraryDTO, LibraryKind, LibraryRow, MediaKind, MediaRow } from '../types.ts';
import { enqueueScan, scanCounts, isScanning, findActiveScanJob } from '../services/scanner.ts';
import { purgeArtForLibrary } from '../services/artwork.ts';
import { classifyExtension } from '../services/metadata.ts';

const LIBRARY_KINDS: LibraryKind[] = ['movies', 'shows', 'music', 'photos', 'mixed'];
const SCAN_SCHEDULES = ['manual', 'hourly', 'daily', 'weekly'];
const TOP_LEVEL_KINDS: MediaKind[] = ['movie', 'show', 'artist', 'album', 'photo', 'video'];

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeSettings(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('settings must be a plain object');
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
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

function libraryStats(row: LibraryRow): { itemCount: number; totalBytes: number } {
  const db = getDb();
  const itemCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM media WHERE library_id = ? AND hidden = 0 AND kind IN (${TOP_LEVEL_KINDS.map(() => '?').join(',')})`)
      .get(row.id, ...TOP_LEVEL_KINDS) as { n: number }
  ).n;
  const totalBytes = (
    db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media WHERE library_id = ? AND hidden = 0').get(row.id) as { bytes: number }
  ).bytes;
  return { itemCount, totalBytes };
}

function libraryToDTO(row: LibraryRow): LibraryDTO {
  let exists = false;
  try {
    exists = fs.statSync(row.path).isDirectory();
  } catch {
    exists = false;
  }
  const stats = libraryStats(row);
  return {
    ...row,
    settings: parseSettings(row.settings),
    itemCount: stats.itemCount,
    totalBytes: stats.totalBytes,
    lastScanAt: row.last_scan_at,
    exists,
  };
}

function getLibrary(id: number): LibraryRow {
  const row = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(id) as LibraryRow | undefined;
  if (!row) throw notFound(`Library ${id} does not exist. Degrees of separation: one empty shelf.`);
  return row;
}

function validatePath(raw: unknown): string {
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
  if (resolved === dataRoot || resolved.startsWith(cacheRoot + path.sep) || resolved === cacheRoot) {
    throw badRequest('Refusing to use the app data/cache directory as a library. Skill issue avoided.');
  }
  return resolved;
}

function validateName(raw: unknown, fallback?: string): string {
  const value = raw === undefined ? fallback : raw;
  if (typeof value !== 'string') throw badRequest('name must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) throw badRequest('name must be 1-120 characters');
  return trimmed;
}

export const librariesRouter = Router();

librariesRouter.get('/', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM libraries ORDER BY name COLLATE NOCASE').all() as LibraryRow[];
  res.json({ items: rows.map(libraryToDTO) });
});

/** Recursive media count for the admin path picker (bounded, symlink-free). */
function countMediaFiles(root: string, depth = 0, budget = { remaining: 5000 }): number {
  if (depth > 4 || budget.remaining <= 0) return 0;
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    budget.remaining -= 1;
    if (entry.isDirectory()) {
      total += countMediaFiles(path.join(root, entry.name), depth + 1, budget);
    } else if (entry.isFile()) {
      const cls = classifyExtension(entry.name);
      if (cls === 'video' || cls === 'audio' || cls === 'image') total += 1;
    }
  }
  return total;
}

librariesRouter.get('/folders', requireManager, (req, res) => {
  const raw = queryString(req, 'path') || config.mediaDir;
  if (!path.isAbsolute(raw)) throw badRequest('Folders browser path must be absolute');
  const target = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw notFound(`No such directory: ${target}`);
  }
  if (!stat.isDirectory()) throw badRequest('Not a directory');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    throw new HttpError(403, `Cannot read ${target}: ${(error as Error).message}`, 'forbidden');
  }
  const items = entries
    .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
    .slice(0, 500)
    .map((entry) => {
      const childPath = path.join(target, entry.name);
      let subdirs = 0;
      try {
        subdirs = fs.readdirSync(childPath, { withFileTypes: true }).filter((child) => child.isDirectory() && !child.name.startsWith('.')).length;
      } catch {
        /* unreadable child stays visible with zero counts */
      }
      return { name: entry.name, path: childPath, isDirectory: true, mediaFiles: countMediaFiles(childPath), subdirs };
    });
  res.json({ path: target, parent: path.dirname(target) === target ? null : path.dirname(target), items, entries: items });
});

librariesRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid library id');
  res.json({ item: libraryToDTO(getLibrary(id)) });
});

librariesRouter.get('/:id/items', (req, res) => {
  const library = getLibrary(Number(req.params.id));
  const { page, pageSize, offset } = pageParams(req);
  const requestedKind = queryString(req, 'kind');
  const kinds = requestedKind
    ? TOP_LEVEL_KINDS.filter((kind) => kind === requestedKind)
    : TOP_LEVEL_KINDS;
  if (requestedKind && kinds.length === 0) throw badRequest(`Unsupported kind: ${requestedKind}`);
  const sortMap: Record<string, string> = {
    title: 'sort_title COLLATE NOCASE ASC',
    added: 'added_at DESC',
    year: 'year DESC NULLS LAST, sort_title COLLATE NOCASE ASC',
    rating: 'rating DESC NULLS LAST, sort_title COLLATE NOCASE ASC',
    runtime: 'runtime_seconds DESC NULLS LAST',
    random: 'RANDOM()',
  };
  const sort = sortMap[queryString(req, 'sort') || 'title'] || sortMap.title;
  const placeholders = kinds.map(() => '?').join(',');
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM media WHERE library_id = ? AND hidden = 0 AND kind IN (${placeholders})`)
      .get(library.id, ...kinds) as { n: number }
  ).n;
  const rows = getDb()
    .prepare(`SELECT * FROM media WHERE library_id = ? AND hidden = 0 AND kind IN (${placeholders}) ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .all(library.id, ...kinds, pageSize, offset) as MediaRow[];
  sendPage(res, mediaRowsToDTO(rows, req.user?.id), total, page, pageSize);
});

librariesRouter.get('/:id/stats', (req, res) => {
  const library = getLibrary(Number(req.params.id));
  const { counts, totalBytes } = scanCounts(library.id);
  const recent = getDb()
    .prepare('SELECT * FROM media WHERE library_id = ? AND hidden = 0 ORDER BY added_at DESC LIMIT 12')
    .all(library.id) as MediaRow[];
  const visible = getDb()
    .prepare('SELECT COUNT(*) AS n FROM media WHERE library_id = ? AND hidden = 0')
    .get(library.id) as { n: number };
  const hidden = getDb()
    .prepare('SELECT COUNT(*) AS n FROM media WHERE library_id = ? AND hidden = 1')
    .get(library.id) as { n: number };
  res.json({
    library: libraryToDTO(library),
    counts,
    totalBytes,
    totalItems: visible.n,
    hiddenItems: hidden.n,
    lastScanAt: library.last_scan_at,
    recent: mediaRowsToDTO(recent, req.user?.id),
  });
});

librariesRouter.post('/', requireManager, (req, res) => {
  const body = req.body as Record<string, unknown>;
  const name = validateName(body.name);
  const kind = body.kind as LibraryKind;
  if (!LIBRARY_KINDS.includes(kind)) throw badRequest(`kind must be one of ${LIBRARY_KINDS.join(', ')}`);
  const libraryPath = validatePath(body.path);
  const duplicate = getDb().prepare('SELECT id FROM libraries WHERE path = ?').get(libraryPath) as { id: number } | undefined;
  if (duplicate) throw conflict(`That path is already library #${duplicate.id}`);
  const scanSchedule = body.scanSchedule === undefined ? 'daily' : String(body.scanSchedule);
  if (!SCAN_SCHEDULES.includes(scanSchedule)) throw badRequest(`scanSchedule must be one of ${SCAN_SCHEDULES.join(', ')}`);
  const librarySettings = safeSettings(body.settings);
  const timestamp = nowISO();
  const info = getDb()
    .prepare(
      `INSERT INTO libraries(name, kind, path, scan_schedule, settings, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, kind, libraryPath, scanSchedule, JSON.stringify(librarySettings), timestamp, timestamp);
  const row = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(Number(info.lastInsertRowid)) as LibraryRow;
  res.status(201).json(libraryToDTO(row));
});

librariesRouter.patch('/:id', requireManager, (req, res) => {
  const library = getLibrary(Number(req.params.id));
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = validateName(body.name);
  if (body.kind !== undefined) {
    if (!LIBRARY_KINDS.includes(body.kind as LibraryKind)) throw badRequest(`kind must be one of ${LIBRARY_KINDS.join(', ')}`);
    patch.kind = body.kind;
  }
  if (body.path !== undefined) {
    const nextPath = validatePath(body.path);
    const duplicate = getDb().prepare('SELECT id FROM libraries WHERE path = ? AND id != ?').get(nextPath, library.id) as { id: number } | undefined;
    if (duplicate) throw conflict(`That path is already library #${duplicate.id}`);
    patch.path = nextPath;
  }
  if (body.scanSchedule !== undefined) {
    const schedule = String(body.scanSchedule);
    if (!SCAN_SCHEDULES.includes(schedule)) throw badRequest(`scanSchedule must be one of ${SCAN_SCHEDULES.join(', ')}`);
    patch.scan_schedule = schedule;
  }
  if (body.settings !== undefined) patch.settings = JSON.stringify(safeSettings(body.settings));
  patch.updated_at = nowISO();
  const columns = Object.keys(patch);
  if (columns.length === 1) throw badRequest('Nothing to update');
  getDb()
    .prepare(`UPDATE libraries SET ${columns.map((column) => `${column} = @${column}`).join(', ')} WHERE id = @id`)
    .run({ ...patch, id: library.id });
  const updated = getLibrary(library.id);
  res.json(libraryToDTO(updated));
});

librariesRouter.delete('/:id', requireManager, (req, res) => {
  const library = getLibrary(Number(req.params.id));
  if (isScanning(library.id)) throw conflict('Cannot delete a library mid-scan. Let the slop settle first.');
  const removed = purgeArtForLibrary(library.id);
  getDb().prepare('DELETE FROM libraries WHERE id = ?').run(library.id);
  res.json({ ok: true, libraryId: library.id, removedMedia: removed, sourceFiles: 'untouched, obviously' });
});

librariesRouter.post('/scan-all', requireManager, (req, res) => {
  const libraries = getDb().prepare('SELECT * FROM libraries ORDER BY id').all() as LibraryRow[];
  const jobIds: string[] = [];
  const skipped: { libraryId: number; libraryName: string; reason: string }[] = [];
  for (const library of libraries) {
    try {
      const stat = fs.statSync(library.path);
      if (!stat.isDirectory()) throw new Error('path is not a directory');
    } catch (error) {
      skipped.push({ libraryId: library.id, libraryName: library.name, reason: (error as Error).message });
      continue;
    }
    const active = findActiveScanJob(library.id);
    if (active) {
      skipped.push({ libraryId: library.id, libraryName: library.name, reason: 'already scanning' });
      continue;
    }
    const job = enqueueScan(library.id, req.user?.id, 'scan-all');
    jobIds.push(job.id);
  }
  res.status(202).json({ ok: true, jobIds, skipped });
});

librariesRouter.post('/:id/scan', requireManager, (req, res) => {
  const library = getLibrary(Number(req.params.id));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(library.path);
  } catch {
    throw badRequest(`Library path is missing: ${library.path}. The files pulled a disappearing act.`);
  }
  if (!stat.isDirectory()) throw badRequest('Library path is not a directory');
  if (isScanning(library.id)) {
    const active = findActiveScanJob(library.id);
    throw new HttpError(409, 'A scan is already running for this library. Patience, chief.', 'scan_in_progress', { jobId: active?.id });
  }
  try {
    const job = enqueueScan(library.id, req.user?.id, 'manual');
    res.status(202).json({ ok: true, jobId: job.id });
  } catch (error) {
    const failure = error as Error & { code?: string; jobId?: string };
    if (failure.code === 'scan_in_progress') {
      throw new HttpError(409, failure.message, 'scan_in_progress', { jobId: failure.jobId });
    }
    throw error;
  }
});
