import { randomUUID } from 'node:crypto';
import { getDb, nowISO, openDatabase } from '../db.ts';
import { bus, logger } from '../lib/logger.ts';
import type { JobDTO, JobRow, JobStatus, JobType } from '../types.ts';

export interface JobContext {
  jobId: string;
  type: JobType;
  payload: Record<string, unknown>;
  update: (progress: number, message?: string) => void;
  cancelled: () => boolean;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

type CancelFlag = { cancelled: boolean };

const RUNNING_PER_TYPE = 1;
const GLOBAL_LIMIT = 3;

class JobQueue {
  private handlers = new Map<JobType, JobHandler>();
  private running = new Set<string>();
  private flags = new Map<string, CancelFlag>();
  private pumping = false;

  constructor() {
    // Modules can register handlers before server bootstrap finishes; opening is idempotent.
    openDatabase();
    // Any job left running from a previous process is dead. Be honest about it.
    const stale = getDb()
      .prepare("UPDATE jobs SET status = 'error', error = 'Server restarted mid-job', finished_at = ? WHERE status IN ('running','queued')")
      .run(nowISO());
    if (stale.changes > 0) logger.warn('jobs', `Marked ${stale.changes} stale jobs as failed after restart`);
  }

  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  create(type: JobType, payload: Record<string, unknown> = {}, createdBy?: number): JobDTO {
    const id = randomUUID();
    const row: JobRow = {
      id,
      type,
      payload: JSON.stringify(payload),
      status: 'queued',
      progress: 0,
      message: 'Queued. Vibes pending.',
      result: null,
      error: null,
      created_by: createdBy ?? null,
      created_at: nowISO(),
      started_at: null,
      finished_at: null,
    };
    getDb()
      .prepare(
        `INSERT INTO jobs(id, type, payload, status, progress, message, created_by, created_at)
         VALUES(@id, @type, @payload, @status, @progress, @message, @created_by, @created_at)`,
      )
      .run(row);
    logger.info('jobs', `Queued ${type} job`, { jobId: id });
    bus.publish('job.update', this.dto(row));
    setImmediate(() => this.pump());
    return this.dto(row);
  }

  get(id: string): JobDTO | undefined {
    const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? this.dto(row) : undefined;
  }

  list(options: { status?: JobStatus; type?: JobType; limit?: number; offset?: number } = {}): { items: JobDTO[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.status) { where.push('status = ?'); params.push(options.status); }
    if (options.type) { where.push('type = ?'); params.push(options.type); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM jobs ${clause}`).get(...params) as { n: number }).n;
    const rows = getDb()
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, options.limit ?? 50, options.offset ?? 0) as JobRow[];
    return { items: rows.map((row) => this.dto(row)), total };
  }

  active(): JobDTO[] {
    const rows = getDb().prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC").all() as JobRow[];
    return rows.map((row) => this.dto(row));
  }

  cancel(id: string): boolean {
    const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!row) return false;
    if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') return false;
    const flag = this.flags.get(id);
    if (flag) flag.cancelled = true;
    getDb().prepare("UPDATE jobs SET status = 'cancelled', message = 'Cancelled. The slop stopped.', finished_at = ? WHERE id = ?").run(nowISO(), id);
    this.running.delete(id);
    this.flags.delete(id);
    bus.publish('job.update', this.get(id));
    logger.info('jobs', `Cancelled job ${id}`);
    setImmediate(() => this.pump());
    return true;
  }

  clearFinished(): number {
    const info = getDb()
      .prepare("DELETE FROM jobs WHERE status IN ('done','error','cancelled') AND created_at < ?")
      .run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
    return info.changes;
  }

  private dto(row: JobRow): JobDTO {
    let payload: Record<string, unknown> = {};
    let result: unknown = null;
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
    return {
      id: row.id,
      type: row.type,
      payload,
      status: row.status,
      progress: row.progress,
      message: row.message,
      result,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdBy: row.created_by ? String(row.created_by) : null,
    };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < GLOBAL_LIMIT) {
        const runningTypes = new Set<string>();
        for (const id of this.running) {
          const row = getDb().prepare('SELECT type FROM jobs WHERE id = ?').get(id) as { type: JobType } | undefined;
          if (row) runningTypes.add(row.type);
        }
        const queued = getDb()
          .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20")
          .all() as JobRow[];
        let started = false;
        for (const row of queued) {
          if (this.handlers.has(row.type) && !runningTypes.has(row.type) && this.countRunningType(row.type) < RUNNING_PER_TYPE) {
            this.start(row);
            started = true;
            break;
          }
        }
        if (!started) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private countRunningType(type: string): number {
    const count = (getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND type = ?").get(type) as { n: number }).n;
    return count;
  }

  private start(row: JobRow): void {
    const handler = this.handlers.get(row.type);
    if (!handler) {
      this.fail(row.id, `No handler registered for job type: ${row.type}`);
      return;
    }
    const startedAt = nowISO();
    getDb().prepare("UPDATE jobs SET status = 'running', started_at = ?, message = 'Running' WHERE id = ?").run(startedAt, row.id);
    this.running.add(row.id);
    const flag: CancelFlag = { cancelled: false };
    this.flags.set(row.id, flag);
    bus.publish('job.update', this.get(row.id));
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    const ctx: JobContext = {
      jobId: row.id,
      type: row.type,
      payload,
      update: (progress, message) => {
        if (flag.cancelled) return;
        const clamped = Math.max(0, Math.min(1, progress));
        getDb().prepare('UPDATE jobs SET progress = ?, message = ? WHERE id = ?').run(clamped, (message || '').slice(0, 500), row.id);
        const current = this.get(row.id);
        if (current) bus.publish('job.update', current);
      },
      cancelled: () => {
        if (flag.cancelled) return true;
        const current = getDb().prepare('SELECT status FROM jobs WHERE id = ?').get(row.id) as { status: string } | undefined;
        return current?.status === 'cancelled';
      },
      log: (message, meta) => logger.info('jobs', `[${row.type}] ${message}`, { jobId: row.id, ...meta }),
    };
    handler(ctx)
      .then((result) => {
        if (flag.cancelled) return;
        getDb()
          .prepare("UPDATE jobs SET status = 'done', progress = 1, message = 'Done. Slop secured.', result = ?, finished_at = ? WHERE id = ?")
          .run(result === undefined ? null : JSON.stringify(result).slice(0, 20_000), nowISO(), row.id);
        logger.info('jobs', `Finished ${row.type} job`, { jobId: row.id });
        bus.publish('job.update', this.get(row.id));
      })
      .catch((error: unknown) => {
        if (flag.cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        this.fail(row.id, message);
      })
      .finally(() => {
        this.running.delete(row.id);
        this.flags.delete(row.id);
        this.pump();
      });
  }

  private fail(id: string, message: string): void {
    getDb()
      .prepare("UPDATE jobs SET status = 'error', error = ?, message = 'Failed. L.', finished_at = ? WHERE id = ?")
      .run(message.slice(0, 4000), nowISO(), id);
    logger.error('jobs', `Job failed: ${message}`, { jobId: id });
    this.running.delete(id);
    this.flags.delete(id);
    bus.publish('job.update', this.get(id));
  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
