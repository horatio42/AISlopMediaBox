import { Router } from 'express';
import { config } from '../config.ts';
import { getDb, settings } from '../db.ts';
import { bus, serverInfo, startTime } from '../lib/logger.ts';
import { requireAdmin, requireAuth } from '../lib/auth.ts';
import { detectHwAccel, selectEncoder } from '../services/hwaccel.ts';

export const systemRouter = Router();

systemRouter.get('/branding', (_req, res) => {
  const all = settings.all();
  res.json({
    serverName: all.serverName,
    tagline: all.tagline,
    accent: all.accent,
    memes: all.memes,
    allowSignups: all.allowSignups,
    requireInvite: all.requireInvite,
    allowRequests: all.allowRequests,
    allowParties: all.allowParties,
    maintenanceMode: all.maintenanceMode,
    version: config.version,
    demoMode: config.demoMode,
  });
});

systemRouter.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM media WHERE hidden = 0 GROUP BY kind`,
    )
    .all() as { kind: string; n: number }[];
  const totals = db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(size_bytes), 0) AS bytes FROM media').get() as { items: number; bytes: number };
  const libraries = db.prepare('SELECT COUNT(*) AS n FROM libraries').get() as { n: number };
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  res.json({
    counts: Object.fromEntries(counts.map((row) => [row.kind, row.n])),
    items: totals.items,
    bytes: totals.bytes,
    libraries: libraries.n,
    users: users.n,
    server: serverInfo(),
  });
});

/** Admin-only capability report: what ffmpeg can actually run on this host right now. */
systemRouter.get('/hwaccel', requireAuth, requireAdmin, async (req, res) => {
  const force = String(req.query.refresh || '') === '1';
  const report = await detectHwAccel(force);
  const active = selectEncoder(report, settings.get('hwAccel'), settings.get('hwAccelDevice'));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...report, preference: settings.get('hwAccel'), device: settings.get('hwAccelDevice'), active });
});

systemRouter.get('/activity', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.mode, s.started_at, s.last_seen_at, s.position, u.username, u.display_name, m.title, m.kind
       FROM streams s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN media m ON m.id = s.media_id
       ORDER BY s.last_seen_at DESC LIMIT ?`,
    )
    .all(limit);
  res.json({ items: rows, sseClients: bus.size, startedAt: new Date(startTime).toISOString() });
});
