import { Router } from 'express';
import type { Request } from 'express';
import { getDb } from '../db.ts';
import { badRequest, conflict, forbidden, notFound, pageParams, queryInt, queryString } from '../lib/http.ts';
import { isManager } from '../lib/auth.ts';
import { logger } from '../lib/logger.ts';
import { jobQueue } from '../services/jobs.ts';
import type { JobDTO, JobStatus, JobType } from '../types.ts';

export const jobsRouter = Router();

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'done', 'error', 'cancelled'];
const TYPES: readonly JobType[] = ['scan', 'match', 'art', 'probe', 'cleanup'];
/** Keys a non-manager may see in their own job payload. Everything else is curator-only. */
const SAFE_PAYLOAD_KEYS = new Set(['libraryId', 'libraryIds', 'scope', 'mediaId', 'kind', 'force', 'reason']);

function manager(req: Request): boolean {
  return isManager(req.user);
}

/**
 * Ownership: curators see everything, users see their own jobs, and a scanner job
 * without an owner can be polled by whoever holds its unguessable id. Global scan
 * listing is still curator-only.
 */
function canAccess(req: Request, job: JobDTO): boolean {
  if (manager(req)) return true;
  if (job.createdBy && Number(job.createdBy) === req.user?.id) return true;
  return job.createdBy === null && job.type === 'scan';
}

function visibleJob(req: Request, job: JobDTO): JobDTO {
  if (manager(req)) return job;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(job.payload)) {
    if (SAFE_PAYLOAD_KEYS.has(key)) payload[key] = value;
  }
  return {
    ...job,
    payload,
    result: null,
    error: job.error ? 'Job failed. Admins can see the detailed error in the job log.' : null,
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

function jobId(req: Request): string {
  const raw = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  if (!id || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw badRequest('That job id does not look like a job id. Skill issue.', { field: 'id' });
  }
  return id;
}

function loadJobForUser(req: Request): JobDTO {
  const id = jobId(req);
  const job = jobQueue.get(id);
  if (!job) throw notFound('No job with that id. It finished, vanished, or never existed.');
  if (!canAccess(req, job)) throw forbidden('Not your job, chief. Curators only.');
  return job;
}

jobsRouter.get('/', (req, res) => {
  if (!manager(req)) {
    throw forbidden('The job board is curator-only. Poll your own job by id instead.');
  }
  const status = queryString(req, 'status');
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of: ${STATUSES.join(', ')}.`, { allowed: STATUSES });
  }
  const type = queryString(req, 'type');
  if (type && !(TYPES as readonly string[]).includes(type)) {
    throw badRequest(`type must be one of: ${TYPES.join(', ')}.`, { allowed: TYPES });
  }
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 50, maxPageSize: 200 });
  const listed = jobQueue.list({
    status: status as JobStatus | undefined,
    type: type as JobType | undefined,
    limit: pageSize,
    offset,
  });
  res.json({ items: listed.items, total: listed.total, page, pageSize, counts: jobStatusCounts() });
});

jobsRouter.get('/active', (req, res) => {
  const active = jobQueue.active();
  const items = manager(req)
    ? active
    : active.filter((job) => canAccess(req, job)).map((job) => visibleJob(req, job));
  res.json({ items });
});

jobsRouter.get('/:id', (req, res) => {
  res.json(visibleJob(req, loadJobForUser(req)));
});

jobsRouter.post('/:id/cancel', (req, res) => {
  const job = loadJobForUser(req);
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    throw conflict(`Job is already ${job.status}. You cannot cancel the past.`);
  }
  const ok = jobQueue.cancel(job.id);
  if (!ok) throw conflict('Job could not be cancelled. It probably just finished being dramatic.');
  const current = jobQueue.get(job.id);
  logger.info('jobs', 'Cancelled by request', { jobId: job.id, userId: req.user?.id, admin: manager(req) });
  res.json({ ok: true, job: current ? visibleJob(req, current) : null });
});

jobsRouter.delete('/history', (req, res) => {
  if (req.user?.role !== 'admin') throw forbidden('Only admins can sweep the job history. Curators keep the receipts.');
  const raw = queryInt(req, 'olderThanDays') ?? 3;
  if (raw < 0 || raw > 3650) throw badRequest('olderThanDays must be between 0 and 3650.', { field: 'olderThanDays' });
  const cutoff = new Date(Date.now() - raw * 24 * 60 * 60 * 1000).toISOString();
  const deleted = getDb()
    .prepare("DELETE FROM jobs WHERE status IN ('done','error','cancelled') AND created_at < ?")
    .run(cutoff).changes;
  logger.info('jobs', 'Cleared job history', { userId: req.user.id, olderThanDays: raw, deleted });
  res.json({ ok: true, deleted, olderThanDays: raw });
});
