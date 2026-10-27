import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db.ts';
import { requireManager } from '../lib/auth.ts';
import { HttpError, badRequest, conflict, notFound, pageParams, queryString } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';
import type { IngestItemRow, IngestSourceRow, IngestStatus } from '../types.ts';
import {
  applyManualMatch,
  createSource,
  deleteSource,
  enqueueIngest,
  getItemDTO,
  getItemRow,
  getSourceDTO,
  ignoreItem,
  ingestStats,
  itemToDTO,
  organizeParsedItem,
  retryItem,
  searchItemCandidates,
  sourceToDTO,
  updateSource,
} from '../services/ingest.ts';
import { providerStatuses } from '../services/providers.ts';

const STATUSES: IngestStatus[] = ['pending', 'review', 'organized', 'error', 'ignored'];

function codedToHttp(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (!(error instanceof Error)) return error;
  const code = (error as Error & { code?: string }).code;
  const jobId = (error as Error & { jobId?: string }).jobId;
  if (code === 'ingest_in_progress') {
    return new HttpError(409, 'An ingest job is already queued or running.', 'ingest_in_progress', { jobId });
  }
  if (code === 'not_found') return notFound(error.message);
  if (code === 'conflict' || code === 'already_organized' || code === 'item_ignored' || code === 'organize_in_progress') {
    return conflict(error.message);
  }
  if (code === 'bad_request' || code === 'bad_provider') return badRequest(error.message);
  if (code === 'no_match') return new HttpError(422, error.message, 'no_match');
  if (code === 'organize_failed') return new HttpError(422, error.message, 'organize_failed');
  return error;
}

function handle(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error: unknown) => next(codedToHttp(error)));
  };
}

function objectBody(body: unknown, label: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest(`${label} must be a plain object`);
  return body as Record<string, unknown>;
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  return id;
}

function optionalString(value: unknown, field: string, max = 5000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${field} is too long`);
  return trimmed || undefined;
}

function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw badRequest(`${field} must be an integer between ${min} and ${max}`);
  return number;
}

export const ingestRouter = Router();

ingestRouter.use(requireManager);

ingestRouter.get('/providers', (_req, res) => {
  res.json({ providers: providerStatuses() });
});

ingestRouter.get('/stats', (_req, res) => {
  res.json(ingestStats());
});

ingestRouter.get('/sources', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM ingest_sources ORDER BY id').all() as IngestSourceRow[];
  res.json({ items: rows.map(sourceToDTO) });
});

ingestRouter.post('/sources', handle((req, res) => {
  const body = objectBody(req.body, 'source');
  const source = createSource(body);
  res.status(201).json({ ok: true, item: source });
}));

ingestRouter.get('/sources/:id', (req, res) => {
  res.json({ item: getSourceDTO(idParam(req)) });
});

ingestRouter.patch('/sources/:id', handle((req, res) => {
  const body = objectBody(req.body, 'source patch');
  if (Object.keys(body).length === 0) throw badRequest('Source patch is empty');
  const item = updateSource(idParam(req), body);
  res.json({ ok: true, item });
}));

ingestRouter.delete('/sources/:id', handle((req, res) => {
  const result = deleteSource(idParam(req));
  res.json({ ...result, files: 'untouched, obviously' });
}));

ingestRouter.post('/sources/:id/scan', handle((req, res) => {
  const sourceId = idParam(req);
  const job = enqueueIngest(sourceId, req.user?.id);
  res.json({ ok: true, jobId: job.id, sourceId });
}));

ingestRouter.post('/scan-all', handle((req, res) => {
  const job = enqueueIngest(undefined, req.user?.id);
  res.json({ ok: true, jobId: job.id });
}));

function sourceMap(): Map<number, IngestSourceRow> {
  const rows = getDb().prepare('SELECT * FROM ingest_sources').all() as IngestSourceRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

ingestRouter.get('/items', (req, res) => {
  const statusRaw = queryString(req, 'status');
  if (statusRaw && !(STATUSES as string[]).includes(statusRaw)) {
    throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const sourceIdRaw = queryString(req, 'sourceId');
  let sourceId: number | null = null;
  if (sourceIdRaw !== undefined) {
    const parsed = Number(sourceIdRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest('sourceId must be a positive integer');
    sourceId = parsed;
  }
  const q = queryString(req, 'q')?.slice(0, 200);
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 25, maxPageSize: 200 });
  const filters: string[] = [];
  const params: unknown[] = [];
  if (sourceId !== null) {
    filters.push('source_id = ?');
    params.push(sourceId);
  }
  if (q) {
    filters.push('(name LIKE ? OR path LIKE ? OR parsed_title LIKE ? OR title LIKE ?)');
    const like = `%${q.replace(/[%_]/g, ' ')}%`;
    params.push(like, like, like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const statusWhere = statusRaw ? `${where ? `${where} AND` : 'WHERE'} status = ?` : where;
  const statusParams = statusRaw ? [...params, statusRaw] : params;
  const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM ingest_items ${statusWhere}`).get(...statusParams) as { n: number }).n;
  const rows = getDb()
    .prepare(`SELECT * FROM ingest_items ${statusWhere} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...statusParams, pageSize, offset) as IngestItemRow[];
  const counts: Record<string, number> = { pending: 0, review: 0, organized: 0, error: 0, ignored: 0, total: 0 };
  for (const row of getDb().prepare(`SELECT status, COUNT(*) AS n FROM ingest_items ${where} GROUP BY status`).all(...params) as { status: string; n: number }[]) {
    counts[row.status] = row.n;
    counts.total += row.n;
  }
  const sources = sourceMap();
  const items = rows.map((row) => itemToDTO(row, sources.get(row.source_id), false));
  res.json({ items, total, page, pageSize, counts });
});

ingestRouter.get('/items/:id', handle((req, res) => {
  const id = idParam(req);
  const row = getItemRow(id);
  if (!row) throw notFound(`Ingest item ${id} does not exist`);
  res.json({ item: getItemDTO(id, true), providers: providerStatuses() });
}));

ingestRouter.post('/items/:id/search', handle(async (req, res) => {
  const id = idParam(req);
  const body = objectBody(req.body ?? {}, 'search body');
  const query = optionalString(body.query, 'query', 300);
  const result = await searchItemCandidates(id, query);
  res.json({ ok: true, ...result });
}));

ingestRouter.post('/items/:id/match', handle(async (req, res) => {
  const id = idParam(req);
  const body = objectBody(req.body, 'match body');
  const provider = optionalString(body.provider, 'provider', 40);
  const providerId = optionalString(body.providerId, 'providerId', 100);
  const title = optionalString(body.title, 'title', 300);
  const overview = optionalString(body.overview, 'overview', 5000);
  const year = optionalInt(body.year, 'year', 1800, 2200);
  const season = optionalInt(body.season, 'season', 0, 999);
  const episode = optionalInt(body.episode, 'episode', 0, 9999);
  const episodeTitle = optionalString(body.episodeTitle, 'episodeTitle', 300);
  if (!provider && !title) throw badRequest('Pass { provider, providerId } or a manual { title, year? }');
  const result = await applyManualMatch(id, { provider, providerId, title, year, season, episode, episodeTitle, overview });
  res.json({
    ok: true,
    item: result.item,
    destPath: result.destPath,
    mediaId: result.mediaId,
    libraryId: result.libraryId,
    message: result.message,
  });
}));

ingestRouter.post('/items/:id/organize', handle(async (req, res) => {
  const result = await organizeParsedItem(idParam(req));
  res.json({ ok: true, item: result.item, destPath: result.destPath, mediaId: result.mediaId, libraryId: result.libraryId, message: result.message });
}));

ingestRouter.post('/items/:id/ignore', (req, res) => {
  const item = ignoreItem(idParam(req));
  res.json({ ok: true, item });
});

ingestRouter.post('/items/:id/retry', handle(async (req, res) => {
  const result = await retryItem(idParam(req));
  res.json({ ok: true, item: result.item, outcome: result.outcome });
}));

// Keep error objects out of logs while surfacing coded failures to the client.
ingestRouter.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
  const mapped = codedToHttp(error);
  if (!(mapped instanceof HttpError)) logger.warn('ingest', `Unhandled ingest route error: ${error instanceof Error ? error.message : String(error)}`);
  next(mapped);
});
