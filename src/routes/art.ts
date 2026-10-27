import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.ts';
import { getDb } from '../db.ts';
import { isManager, requireManager } from '../lib/auth.ts';
import { getMediaDTO, getMediaRow } from '../lib/dto.ts';
import { badRequest, notFound } from '../lib/http.ts';
import { bus } from '../lib/logger.ts';
import type { ArtKind, MediaRow } from '../types.ts';
import {
  ART_KINDS,
  deleteArt,
  ensureDerivedArtForMedia,
  imageMime,
  isArtKind,
  placeholderSvg,
  saveUploadedArt,
} from '../services/artwork.ts';

function rowFor(mediaId: number, manager: boolean): MediaRow {
  const row = getMediaRow(mediaId);
  if (!row) throw notFound(`Media ${mediaId} not found. No art for ghosts.`);
  if (row.hidden === 1 && !manager) throw notFound(`Media ${mediaId} not found. No art for ghosts.`);
  return row;
}

function kindParam(raw: string): ArtKind {
  if (!isArtKind(raw)) throw badRequest(`Unknown art kind "${raw}". Use one of: ${ART_KINDS.join(', ')}`);
  return raw;
}

function artRow(mediaId: number, kind: ArtKind): { path: string; source: string; width: number | null; height: number | null } | undefined {
  return getDb().prepare('SELECT path, source, width, height FROM media_art WHERE media_id = ? AND kind = ?').get(mediaId, kind) as
    | { path: string; source: string; width: number | null; height: number | null }
    | undefined;
}

function safeCachedPath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(config.imageDir) + path.sep)) return null;
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function sendSvg(res: express.Response, svg: string): void {
  const body = Buffer.from(svg, 'utf8');
  const etag = `"svg-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
  if (res.req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

export const artRouter = Router();

artRouter.get('/:mediaId', (req, res) => {
  const mediaId = Number(req.params.mediaId);
  if (!Number.isInteger(mediaId) || mediaId <= 0) throw badRequest('Invalid media id');
  const row = rowFor(mediaId, isManager(req.user));
  const dto = getMediaDTO(mediaId, req.user?.id);
  const rows = getDb().prepare('SELECT kind, width, height, source FROM media_art WHERE media_id = ? ORDER BY kind').all(mediaId) as {
    kind: ArtKind;
    width: number | null;
    height: number | null;
    source: string;
  }[];
  res.json({
    mediaId,
    title: row.title,
    kind: row.kind,
    art: dto?.art ?? {},
    items: rows.map((art) => ({ kind: art.kind, width: art.width, height: art.height, source: art.source, url: `/api/art/${mediaId}/${art.kind}` })),
  });
});

artRouter.get('/:mediaId/:kind', async (req, res) => {
  const mediaId = Number(req.params.mediaId);
  if (!Number.isInteger(mediaId) || mediaId <= 0) throw badRequest('Invalid media id');
  const kind = kindParam(String(req.params.kind));
  const manager = isManager(req.user);
  const row = rowFor(mediaId, manager);
  let art = artRow(mediaId, kind);

  if (!art && (row.kind === 'show' || row.kind === 'season' || row.kind === 'album' || row.kind === 'artist')) {
    await ensureDerivedArtForMedia(mediaId);
    art = artRow(mediaId, kind);
  }
  if (!art) {
    sendSvg(res, placeholderSvg(row, kind));
    return;
  }
  const filePath = safeCachedPath(art.path);
  if (!filePath) {
    sendSvg(res, placeholderSvg(row, kind));
    return;
  }
  const stat = fs.statSync(filePath);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', imageMime(filePath));
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.sendFile(filePath, { dotfiles: 'deny' }, (error) => {
    if (error && !res.headersSent) {
      res.status(500).json({ error: { code: 'art_read_failed', message: 'Art file sulked.' } });
    }
  });
});

const rawImage = express.raw({ type: 'image/*', limit: '20mb' });

artRouter.post('/:mediaId/:kind', requireManager, rawImage, (req, res) => {
  const mediaId = Number(req.params.mediaId);
  if (!Number.isInteger(mediaId) || mediaId <= 0) throw badRequest('Invalid media id');
  const kind = kindParam(String(req.params.kind));
  rowFor(mediaId, true);
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Send a raw image body with Content-Type: image/*');
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
  if (!allowed.includes(mime)) throw badRequest(`Unsupported image type "${mime}". Raster only; SVG uploads are a foot-gun.`);
  try {
    const saved = saveUploadedArt(mediaId, kind, body, mime);
    bus.publish('media.changed', { mediaId, kind, art: 'uploaded' });
    res.status(201).json({ ok: true, kind, bytes: saved.bytes, art: getMediaDTO(mediaId, req.user?.id)?.art ?? {} });
  } catch (error) {
    throw badRequest((error as Error).message);
  }
});

artRouter.delete('/:mediaId/:kind', requireManager, (req, res) => {
  const mediaId = Number(req.params.mediaId);
  if (!Number.isInteger(mediaId) || mediaId <= 0) throw badRequest('Invalid media id');
  const kind = kindParam(String(req.params.kind));
  rowFor(mediaId, true);
  const removed = deleteArt(mediaId, kind);
  bus.publish('media.changed', { mediaId, kind, art: 'deleted' });
  res.json({ ok: true, removed, kind, art: getMediaDTO(mediaId, req.user?.id)?.art ?? {} });
});
