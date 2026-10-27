import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, isProduction, paths } from './config.ts';
import { closeDatabase, getDb, openDatabase, settings } from './db.ts';
import { attachUser, requireAuth, requireAdmin } from './lib/auth.ts';
import { HttpError, wantsJson } from './lib/http.ts';
import { bus, logger, serverInfo, startTime } from './lib/logger.ts';
import { authRouter } from './routes/auth.ts';
import { systemRouter } from './routes/system.ts';
import { eventsRouter } from './routes/events.ts';
import { librariesRouter } from './routes/libraries.ts';
import { mediaRouter } from './routes/media.ts';
import { browseRouter } from './routes/browse.ts';
import { artRouter } from './routes/art.ts';
import { streamRouter } from './routes/stream.ts';
import { progressRouter } from './routes/progress.ts';
import { collectionsRouter } from './routes/collections.ts';
import { playlistsRouter } from './routes/playlists.ts';
import { requestsRouter } from './routes/requests.ts';
import { partiesRouter } from './routes/parties.ts';
import { usersRouter } from './routes/users.ts';
import { adminRouter } from './routes/admin.ts';
import { jobsRouter } from './routes/jobs.ts';
import { musicRouter } from './routes/music.ts';
import { photosRouter } from './routes/photos.ts';
import { ingestRouter } from './routes/ingest.ts';

openDatabase();

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Hard privacy posture: no third-party origins, no inline scripts, no framing.
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    next();
  });

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (!wantsJson(req)) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (res.statusCode >= 500) logger.error('http', `${req.method} ${req.originalUrl} -> ${res.statusCode}`, { ms: Math.round(ms) });
      else if (res.statusCode >= 400) logger.warn('http', `${req.method} ${req.originalUrl} -> ${res.statusCode}`, { ms: Math.round(ms) });
      else logger.debug('http', `${req.method} ${req.originalUrl} -> ${res.statusCode}`, { ms: Math.round(ms) });
    });
    next();
  });

  app.use(attachUser);

  // API responses are private by default; art/stream routes opt into caching explicitly.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Maintenance mode: keep auth, health, branding and the admin API alive so the admin can turn it off.
  app.use((req, res, next) => {
    if (!settings.get('maintenanceMode')) return next();
    if (!req.path.startsWith('/api')) return next();
    if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth') || req.path === '/api/health' || req.path === '/api/branding') return next();
    if (req.user?.role === 'admin') return next();
    res.status(503).json({ error: { code: 'maintenance', message: 'Server is in maintenance mode. Touch grass and come back.' } });
  });

  // Origin check for cookie-authenticated mutations (belt + suspenders with SameSite=Strict).
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    try {
      const originHost = new URL(origin).host;
      const host = req.headers.host;
      if (host && originHost !== host) {
        logger.warn('security', 'Cross-origin mutation blocked', { origin, host });
        throw new HttpError(403, 'Cross-origin request blocked. Nice try.', 'csrf');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ...serverInfo(), db: Boolean(getDb().open), maintenance: settings.get('maintenanceMode') });
  });

  app.use('/api/auth', authRouter);
  app.use('/api', systemRouter);
  app.use('/api/events', requireAuth, eventsRouter);

  // Every media API below requires a session.
  app.use('/api/libraries', requireAuth, librariesRouter);
  app.use('/api/media', requireAuth, mediaRouter);
  app.use('/api/art', requireAuth, artRouter);
  app.use('/api/stream', requireAuth, streamRouter);
  app.use('/api/browse', requireAuth, browseRouter);
  app.use('/api/progress', requireAuth, progressRouter);
  app.use('/api/continue', requireAuth, progressRouter);
  app.use('/api/history', requireAuth, progressRouter);
  app.use('/api/collections', requireAuth, collectionsRouter);
  app.use('/api/playlists', requireAuth, playlistsRouter);
  app.use('/api/requests', requireAuth, requestsRouter);
  app.use('/api/parties', requireAuth, partiesRouter);
  app.use('/api/users', requireAuth, usersRouter);
  app.use('/api/music', requireAuth, musicRouter);
  app.use('/api/photos', requireAuth, photosRouter);
  app.use('/api/ingest', requireAuth, ingestRouter);
  app.use('/api/jobs', requireAuth, jobsRouter);
  app.use('/api/admin', requireAuth, requireAdmin, adminRouter);

  app.use(express.static(paths.public, { maxAge: isProduction() ? '1h' : 0, etag: true, index: false }));

  const indexHtml = path.join(paths.public, 'index.html');
  app.get('/login', (_req, res) => res.sendFile(path.join(paths.public, 'login.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(paths.public, 'admin.html')));
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) {
      res.status(404).send('404 — skill issue');
      return;
    }
    if (!fs.existsSync(indexHtml)) {
      res.status(503).send('Frontend not built yet. The slop is loading.');
      return;
    }
    res.sendFile(indexHtml);
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}. Skill issue.` } });
  });

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Body-parser and middleware errors carry their own HTTP status.
    let middlewareStatus = 0;
    let middlewareType = '';
    if (error && typeof error === 'object') {
      if ('status' in error && typeof error.status === 'number') middlewareStatus = error.status;
      if ('type' in error && typeof error.type === 'string') middlewareType = error.type;
    }
    const status = error instanceof HttpError ? error.status : middlewareStatus >= 400 && middlewareStatus < 600 ? middlewareStatus : 500;
    const code = error instanceof HttpError ? error.code : middlewareType === 'entity.parse.failed' ? 'invalid_json' : middlewareType === 'entity.too.large' ? 'payload_too_large' : 'internal_error';
    const message = error instanceof HttpError
      ? error.message
      : middlewareType === 'entity.parse.failed'
        ? 'That JSON is not JSON-ing. Check the syntax.'
        : middlewareType === 'entity.too.large'
          ? 'Payload too large. Even slop has limits.'
          : 'The slop broke. Check server logs, chief.';
    if (!(error instanceof HttpError) && status >= 500) {
      logger.error('http', `Unhandled error on ${req.method} ${req.originalUrl}`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, details: error instanceof HttpError ? error.details : undefined } });
  });

  return app;
}

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  logger.info('server', `AISlopMediaBox v${config.version} listening on http://${config.host}:${config.port}`);
  logger.info('server', `Data dir: ${config.dataDir}`);
  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  AISlopMediaBox — certified slop, local-only │`);
  console.log(`  │  http://localhost:${String(config.port).padEnd(4)}                       │`);
  console.log(`  └─────────────────────────────────────────────┘\n`);
});
server.requestTimeout = 0;

// Hourly housekeeping: expired sessions and abandoned stream rows. SQLite stays tiny.
const housekeeping = setInterval(() => {
  try {
    const now = new Date().toISOString();
    const sessions = getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    const streams = getDb()
      .prepare("DELETE FROM streams WHERE last_seen_at < ?")
      .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (sessions.changes || streams.changes) {
      logger.debug('housekeeping', `Removed ${sessions.changes} expired sessions, ${streams.changes} stale streams`);
    }
  } catch (error) {
    logger.warn('housekeeping', 'Housekeeping pass failed', { message: String(error) });
  }
}, 60 * 60 * 1000);
housekeeping.unref();

if (config.env === 'production' && config.adminPassword === 'slop123') {
  logger.warn('security', 'DEFAULT ADMIN PASSWORD IN USE. Set ADMIN_PASSWORD before exposing this box to a network. This is a meme, not security.');
}
if (config.adminPassword.length < 8) {
  logger.warn('security', 'ADMIN_PASSWORD is shorter than 8 characters. Even slop deserves better.');
}
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server', `${signal} received, shutting down`);
  bus.shutdown();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => {
    closeDatabase();
    process.exit(1);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('server', 'Unhandled rejection', { reason: String(reason) }));
process.on('uncaughtException', (error) => logger.error('server', 'Uncaught exception', { message: error.message, stack: error.stack }));

export { app, server, startTime };
