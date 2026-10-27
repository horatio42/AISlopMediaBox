import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Log in first, chief.') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'Not your lane, chief.') => new HttpError(403, message, 'forbidden');
export const notFound = (message = 'Nothing here but vibes.') => new HttpError(404, message, 'not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function clientIp(req: Request): string {
  if (config.trustProxy) return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip || '';
  return req.ip || '';
}

export function wantsJson(req: Request): boolean {
  return req.path.startsWith('/api') || req.path.startsWith('/stream') || (req.headers.accept || '').includes('application/json');
}

/** In-memory sliding-window rate limiter, keyed per bucket + IP. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private lastSweep = Date.now();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(key: string): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      for (const [k, times] of this.hits) {
        const live = times.filter((t) => now - t < this.windowMs);
        if (live.length === 0) this.hits.delete(k);
        else this.hits.set(k, live);
      }
      this.lastSweep = now;
    }
    const times = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (times.length >= this.limit) {
      const oldest = times[0];
      this.hits.set(key, times);
      return { ok: false, retryAfter: Math.ceil((this.windowMs - (now - oldest)) / 1000) };
    }
    times.push(now);
    this.hits.set(key, times);
    return { ok: true, retryAfter: 0 };
  }

  middleware(bucket: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const result = this.check(`${bucket}:${clientIp(req)}`);
      if (!result.ok) {
        res.setHeader('Retry-After', String(result.retryAfter));
        next(new HttpError(429, `Slow down. Touch grass for ${result.retryAfter}s.`, 'rate_limited'));
        return;
      }
      next();
    };
  }
}

export function pageParams(req: Request, defaults = { page: 1, pageSize: 48, maxPageSize: 200 }) {
  const rawPage = Number(req.query.page);
  const rawSize = Number(req.query.pageSize);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : defaults.page;
  const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(Math.floor(rawSize), defaults.maxPageSize) : defaults.pageSize;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function queryInt(req: Request, key: string): number | undefined {
  const raw = queryString(req, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

export function queryBool(req: Request, key: string): boolean | undefined {
  const raw = queryString(req, key);
  if (raw === undefined) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function sendPage<T>(res: Response, items: T[], total: number, page: number, pageSize: number): void {
  res.json({ items, total, page, pageSize });
}
