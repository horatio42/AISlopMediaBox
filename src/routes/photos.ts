import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, settings } from '../db.ts';
import { mediaRowsToDTO } from '../lib/dto.ts';
import { badRequest, notFound, pageParams, queryInt, queryString, sendPage } from '../lib/http.ts';
import type { MediaDTO, MediaRow } from '../types.ts';

export const photosRouter = Router();

/** Respect the site's memes toggle for user-facing copy without changing API shapes. */
function copy(funny: string, dry: string): string {
  return settings.get('memes') ? funny : dry;
}

/** A media row joined with its library root so folder paths can be made relative. */
interface PhotoRow extends MediaRow {
  library_path: string;
  library_name: string;
}

/** Extra photo metadata (MediaDTO has no EXIF/capture fields by design). */
interface PhotoExtra {
  captureDate: string;
  folder: string;
  encodedFolderPath: string;
  filename: string;
}
export type PhotoDTO = MediaDTO & PhotoExtra;

const PHOTO_SORTS: Record<string, string> = {
  added: 'm.added_at',
  captured: `COALESCE(NULLIF(m.release_date, ''), m.added_at)`,
  date: `COALESCE(NULLIF(m.release_date, ''), m.added_at)`,
  title: 'm.sort_title COLLATE NOCASE',
  name: 'm.sort_title COLLATE NOCASE',
  size: 'COALESCE(m.size_bytes, 0)',
  random: 'RANDOM()',
};

const NATURAL_DESC: Record<string, true> = { added: true, captured: true, date: true, size: true };

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const PHOTO_SELECT = `SELECT m.*, l.path AS library_path, l.name AS library_name
  FROM media m JOIN libraries l ON l.id = m.library_id`;

function numericId(raw: string | string[] | undefined, label: string): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) throw badRequest(`That ${label} id is not even a number. Skill issue.`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`That ${label} id is out of range.`);
  return id;
}

function sortSpec(req: Request, map: Record<string, string>, fallback: string, defaultDir: 'ASC' | 'DESC') {
  const sort = queryString(req, 'sort') || fallback;
  const column = map[sort];
  if (!column) throw badRequest(`Unknown sort "${sort}". Try: ${Object.keys(map).join(', ')}.`);
  if (sort === 'random') return { sort, order: column };
  const requested = (queryString(req, 'order') || '').toLowerCase();
  if (requested && requested !== 'asc' && requested !== 'desc') throw badRequest('order must be asc or desc.');
  const dir = requested === 'asc' ? 'ASC' : requested === 'desc' ? 'DESC' : NATURAL_DESC[sort] ? 'DESC' : defaultDir;
  return { sort, order: `${column} ${dir}` };
}

function countOf(sql: string, ...params: (string | number)[]): number {
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Photos carry no EXIF column, so "capture" falls back to added_at. */
function captureDate(row: MediaRow): string {
  const release = row.release_date;
  if (release && Number.isFinite(Date.parse(release))) return release;
  return row.added_at;
}

function captureMonth(row: MediaRow): string {
  const date = captureDate(row);
  const match = /^(\d{4})-(\d{2})/.exec(date);
  return match ? `${match[1]}-${match[2]}` : row.added_at.slice(0, 7);
}

function normalizeRelative(input: string): string {
  const segments = input.replace(/\\/g, '/').split('/');
  const safe: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw badRequest('Folder paths are relative, not escape rooms.');
    safe.push(segment);
  }
  return safe.join('/');
}

/** Folder path relative to the owning library root; '' is the library root. */
function relativeFolder(row: PhotoRow): string {
  const root = row.library_path.replace(/[\\/]+$/, '');
  let folder = row.folder_path;
  if (folder === null || folder === '') {
    folder = path.dirname(row.path);
    if (folder === root) return '';
    if (folder.startsWith(root + path.sep)) return normalizeRelative(folder.slice(root.length + 1));
    if (!path.isAbsolute(folder)) return normalizeRelative(folder);
    // Absolute path outside the library root: treat the containing folder name as the group.
    return normalizeRelative(path.basename(folder));
  }
  if (folder === root) return '';
  const normalized = folder.replace(/\\/g, '/');
  const rootPosix = root.replace(/\\/g, '/');
  if (normalized.startsWith(`${rootPosix}/`)) return normalizeRelative(normalized.slice(rootPosix.length + 1));
  if (!path.isAbsolute(folder)) return normalizeRelative(folder);
  return normalizeRelative(path.basename(folder));
}

function validateFolder(raw: string): string {
  // Express already decodes route params and query values exactly once.
  if (raw.startsWith('/') || raw.includes('\\')) throw badRequest('Folder paths are relative, not escape rooms.');
  return normalizeRelative(raw);
}

function dateFilterValue(raw: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw badRequest(`${label} must be an ISO date like 2026-10-26.`);
  }
  return raw.slice(0, 10);
}

function photoFilters(req: Request): {
  clause: string;
  params: (string | number)[];
  folder: string | null;
  libraryId: number | null;
} {
  const where = [`m.kind = 'photo'`, 'm.hidden = 0'];
  const params: (string | number)[] = [];
  let libraryId: number | null = null;
  if (queryString(req, 'libraryId') !== undefined) {
    const id = queryInt(req, 'libraryId');
    if (!id || id <= 0) throw badRequest('libraryId must be a positive integer.');
    libraryId = id;
    where.push('m.library_id = ?');
    params.push(id);
  }
  const from = queryString(req, 'from');
  const to = queryString(req, 'to');
  if (from) {
    where.push(`date(COALESCE(NULLIF(m.release_date, ''), m.added_at)) >= date(?)`);
    params.push(dateFilterValue(from, 'from'));
  }
  if (to) {
    where.push(`date(COALESCE(NULLIF(m.release_date, ''), m.added_at)) <= date(?)`);
    params.push(dateFilterValue(to, 'to'));
  }
  if (from && to && dateFilterValue(from, 'from') > dateFilterValue(to, 'to')) {
    throw badRequest('from is after to. Time travel costs extra.');
  }
  const q = queryString(req, 'q');
  if (q) {
    where.push(`m.title LIKE ? ESCAPE '\\'`);
    params.push(`%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  let folder: string | null = null;
  const folderRaw = req.query.folder;
  // An explicit empty value means "the library root", so do not use queryString() here.
  if (typeof folderRaw === 'string') folder = validateFolder(folderRaw);
  return { clause: where.join(' AND '), params, folder, libraryId };
}

function photoDTOs(rows: PhotoRow[], userId: number): PhotoDTO[] {
  const dtos = mediaRowsToDTO(rows, userId) as PhotoDTO[];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const dto = dtos[index];
    const folder = relativeFolder(row);
    dto.captureDate = captureDate(row);
    dto.folder = folder;
    dto.encodedFolderPath = encodeURIComponent(folder);
    dto.filename = path.basename(row.path);
    dto.libraryName = row.library_name;
  }
  return dtos;
}

function fetchPhotoRows(clause: string, params: (string | number)[], order: string, limit?: number, offset?: number): PhotoRow[] {
  const db = getDb();
  if (limit !== undefined) {
    return db.prepare(`${PHOTO_SELECT} WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset ?? 0) as PhotoRow[];
  }
  return db.prepare(`${PHOTO_SELECT} WHERE ${clause} ORDER BY ${order}`).all(...params) as PhotoRow[];
}

// MARKER_PHOTO_LIST
photosRouter.get('/', (req, res) => {
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 60, maxPageSize: 300 });
  const userId = req.user!.id;
  const { clause, params, folder } = photoFilters(req);
  const order = sortSpec(req, PHOTO_SORTS, 'captured', 'DESC');
  if (folder !== null) {
    // Relative folder paths are computed against each library root, so filter in JS for correctness.
    const all = fetchPhotoRows(clause, params, order.order);
    const filtered = all.filter((row) => relativeFolder(row) === folder);
    sendPage(res, photoDTOs(filtered.slice(offset, offset + pageSize), userId), filtered.length, page, pageSize);
    return;
  }
  const total = countOf(`SELECT COUNT(*) AS n FROM media m JOIN libraries l ON l.id = m.library_id WHERE ${clause}`, ...params);
  const rows = fetchPhotoRows(clause, params, order.order, pageSize, offset);
  sendPage(res, photoDTOs(rows, userId), total, page, pageSize);
});

photosRouter.get('/timeline', (req, res) => {
  const userId = req.user!.id;
  const rows = fetchPhotoRows(`m.kind = 'photo' AND m.hidden = 0`, [], `COALESCE(NULLIF(m.release_date, ''), m.added_at) DESC, m.id DESC`);
  interface TimelineGroup {
    key: string;
    month: number;
    year: number;
    label: string;
    count: number;
    coverRow: PhotoRow;
  }
  const groups = new Map<string, TimelineGroup>();
  for (const row of rows) {
    const key = captureMonth(row);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const [year, month] = key.split('-').map(Number);
    groups.set(key, {
      key,
      year,
      month,
      label: new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      count: 1,
      coverRow: row,
    });
  }
  const coverRows = [...groups.values()].map((group) => group.coverRow);
  const covers = photoDTOs(coverRows, userId);
  const coverById = new Map(covers.map((cover) => [cover.id, cover]));
  const timeline = [...groups.values()]
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .map((group) => ({
      key: group.key,
      month: group.month,
      year: group.year,
      label: group.label,
      count: group.count,
      cover: coverById.get(group.coverRow.id),
    }));
  res.json({ groups: timeline, total: rows.length });
});

photosRouter.get('/folders', (req, res) => {
  const userId = req.user!.id;
  const rows = fetchPhotoRows(`m.kind = 'photo' AND m.hidden = 0`, [], `COALESCE(NULLIF(m.release_date, ''), m.added_at) DESC, m.id DESC`);
  interface FolderGroup {
    path: string;
    name: string;
    encodedPath: string;
    libraryId: number;
    libraryName: string;
    count: number;
    coverRow: PhotoRow;
    latest: string;
  }
  const groups = new Map<string, FolderGroup>();
  for (const row of rows) {
    const folder = relativeFolder(row);
    const key = `${row.library_id}\u0000${folder}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      path: folder,
      name: folder ? (folder.split('/').pop() || folder) : row.library_name,
      encodedPath: encodeURIComponent(folder),
      libraryId: row.library_id,
      libraryName: row.library_name,
      count: 1,
      coverRow: row,
      latest: captureDate(row),
    });
  }
  const ordered = [...groups.values()].sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : a.name.localeCompare(b.name)));
  const covers = photoDTOs(ordered.map((group) => group.coverRow), userId);
  const coverById = new Map(covers.map((cover) => [cover.id, cover]));
  res.json({
    folders: ordered.map((group) => ({
      path: group.path,
      name: group.name,
      encodedPath: group.encodedPath,
      libraryId: group.libraryId,
      libraryName: group.libraryName,
      count: group.count,
      cover: coverById.get(group.coverRow.id),
    })),
    total: ordered.length,
  });
});

function folderItems(req: Request, res: Response, rawFolder: string | undefined): void {
  if (rawFolder === undefined) throw badRequest('Which folder, chief? Pass a folder path.');
  const folder = validateFolder(rawFolder);
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 60, maxPageSize: 300 });
  const userId = req.user!.id;
  const where = [`m.kind = 'photo'`, 'm.hidden = 0'];
  const params: (string | number)[] = [];
  const libraryId = queryInt(req, 'libraryId');
  if (queryString(req, 'libraryId') !== undefined) {
    if (!libraryId || libraryId <= 0) throw badRequest('libraryId must be a positive integer.');
    where.push('m.library_id = ?');
    params.push(libraryId);
  }
  const order = sortSpec(req, PHOTO_SORTS, 'captured', 'DESC');
  const rows = fetchPhotoRows(where.join(' AND '), params, order.order).filter((row) => relativeFolder(row) === folder);
  if (rows.length === 0) throw notFound(copy('That folder is empty or does not exist. Ghost town.', 'Photo folder not found.'));
  const items = photoDTOs(rows.slice(offset, offset + pageSize), userId);
  res.json({
    items,
    total: rows.length,
    page,
    pageSize,
    folder: {
      path: folder,
      name: folder ? (folder.split('/').pop() || folder) : rows[0].library_name,
      encodedPath: encodeURIComponent(folder),
      libraryId: rows[0].library_id,
      libraryName: rows[0].library_name,
      count: rows.length,
    },
  });
}

photosRouter.get('/folders/items', (req, res) => {
  const raw = req.query.path;
  folderItems(req, res, typeof raw === 'string' ? raw : undefined);
});
// The library root has no path segment, so expose it under a stable alias.
photosRouter.get('/folders/root/items', (req, res) => folderItems(req, res, ''));
photosRouter.get('/folders/:folderPath/items', (req, res) => {
  const raw = req.params.folderPath;
  const folder = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  folderItems(req, res, folder);
});

// MARKER_PHOTO_DETAIL
photosRouter.get('/:id', (req, res) => {
  const id = numericId(req.params.id, 'photo');
  const db = getDb();
  const row = db.prepare(`${PHOTO_SELECT} WHERE m.id = ? AND m.hidden = 0`).get(id) as PhotoRow | undefined;
  if (!row || row.kind !== 'photo') throw notFound(copy('That is not a photo. No thoughts, head empty.', 'Photo not found.'));
  const capture = captureDate(row);
  const expr = `COALESCE(NULLIF(release_date, ''), added_at)`;
  const prev = db
    .prepare(
      `SELECT id FROM media WHERE kind = 'photo' AND hidden = 0
       AND (${expr} > ? OR (${expr} = ? AND id > ?))
       ORDER BY ${expr} ASC, id ASC LIMIT 1`,
    )
    .get(capture, capture, row.id) as { id: number } | undefined;
  const next = db
    .prepare(
      `SELECT id FROM media WHERE kind = 'photo' AND hidden = 0
       AND (${expr} < ? OR (${expr} = ? AND id < ?))
       ORDER BY ${expr} DESC, id DESC LIMIT 1`,
    )
    .get(capture, capture, row.id) as { id: number } | undefined;
  const item = photoDTOs([row], req.user!.id)[0];
  res.json({
    item,
    prevId: prev?.id ?? null,
    nextId: next?.id ?? null,
    captureDate: item.captureDate,
    folder: item.folder,
    filename: item.filename,
  });
});

function contentDisposition(filename: string, download: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function servePhotoFile(req: Request, res: Response, headOnly: boolean): void {
  const id = numericId(req.params.id, 'photo');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM media WHERE id = ? AND hidden = 0`).get(id) as MediaRow | undefined;
  if (!row || row.kind !== 'photo') throw notFound(copy('Not a photo. The file endpoint serves pixels only.', 'Photo not found.'));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(row.path);
  } catch {
    throw notFound(copy('Photo row exists but the file is gone. Schrodinger’s JPEG.', 'Photo file is missing on disk.'));
  }
  if (!stat.isFile()) throw notFound(copy('That path is not a regular file. Weird, but no.', 'Photo path is not a file.'));
  const ext = path.extname(row.path).toLowerCase();
  const contentType = IMAGE_TYPES[ext] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const download = ['1', 'true', 'yes'].includes((queryString(req, 'download') || '').toLowerCase());
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition(path.basename(row.path), download));

  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
    res.status(304).end();
    return;
  }
  if (stat.size === 0) {
    res.setHeader('Content-Length', '0');
    res.status(200).end();
    return;
  }

  const rangeHeader = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let partial = false;
  if (typeof rangeHeader === 'string' && rangeHeader.length > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.split(',')[0].trim());
    if (!match || (match[1] === '' && match[2] === '')) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.status(416).end();
        return;
      }
      start = Math.max(stat.size - suffix, 0);
    } else {
      start = Number(match[1]);
      if (match[2] !== '') end = Math.min(Number(match[2]), stat.size - 1);
    }
    if (!Number.isSafeInteger(start) || start < 0 || start >= stat.size || end < start) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }
    partial = true;
  }

  const length = end - start + 1;
  res.setHeader('Content-Length', String(length));
  if (partial) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  } else {
    res.status(200);
  }
  if (headOnly || req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(row.path, { start, end });
  stream.on('error', (error) => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

photosRouter.head('/:id/file', (req, res) => servePhotoFile(req, res, true));
photosRouter.get('/:id/file', (req, res) => servePhotoFile(req, res, false));
