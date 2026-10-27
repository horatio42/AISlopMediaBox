import type { Request, Response } from 'express';
import { getDb, nowISO } from '../db.ts';
import { config } from '../config.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? ORDER.info;

export function log(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`;
  if (level === 'error') console.error(line, meta ?? '');
  else if (level === 'warn') console.warn(line, meta ?? '');
  else console.log(line);
  try {
    getDb()
      .prepare('INSERT INTO logs(level, scope, message, meta, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(level, scope, message.slice(0, 4000), meta ? JSON.stringify(meta).slice(0, 4000) : null, nowISO());
  } catch {
    /* logging must never crash the app (e.g. db closed during shutdown) */
  }
}

export const logger = {
  debug: (scope: string, message: string, meta?: Record<string, unknown>) => log('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: Record<string, unknown>) => log('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: Record<string, unknown>) => log('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: Record<string, unknown>) => log('error', scope, message, meta),
};

/** SSE hub. Every connected browser gets named events; no polling anywhere. */
type Client = { id: number; res: Response; userId?: number; role?: string };

class EventBus {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => this.broadcastRaw(': keepalive\n\n'), 25_000);
    this.heartbeat.unref();
  }

  subscribe(req: Request, res: Response): () => void {
    if (!req.user) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Events are for logged-in sloppers only.' } });
      return () => {};
    }
    if (this.clients.size >= 100) {
      res.status(503).json({ error: { code: 'too_many_streams', message: 'Too many live connections. Close some tabs.' } });
      return () => {};
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected to the slop pipe\n\n');
    const id = this.nextId++;
    const client: Client = { id, res, userId: req.user?.id, role: req.user?.role };
    this.clients.set(id, client);
    const cleanup = () => {
      this.clients.delete(id);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return cleanup;
  }

  private broadcastRaw(chunk: string): void {
    for (const client of this.clients.values()) {
      try {
        client.res.write(chunk);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  publish(type: string, data: unknown, options: { userId?: number; adminsOnly?: boolean } = {}): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    // Job payloads can contain filesystem paths and errors; they are admin-only.
    if (type === 'job.update') options = { ...options, adminsOnly: true };
    // Playback events carry another user's activity; never fan them out to everyone.
    let privateUserId = options.userId;
    if ((type === 'stream.started' || type === 'stream.ended') && privateUserId === undefined && data && typeof data === 'object' && 'userId' in data) {
      const candidate = data.userId;
      if (typeof candidate === 'number') privateUserId = candidate;
    }
    for (const client of this.clients.values()) {
      if (options.adminsOnly && client.role !== 'admin') continue;
      if (privateUserId !== undefined && client.userId !== privateUserId && client.role !== 'admin') continue;
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  shutdown(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}

export const bus = new EventBus();

export function serverInfo() {
  return {
    name: 'AISlopMediaBox',
    version: config.version,
    env: config.env,
    startedAt: startTime,
    node: process.version,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    sseClients: bus.size,
  };
}

export const startTime = Date.now();
