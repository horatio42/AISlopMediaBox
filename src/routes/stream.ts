import { Router } from 'express';
import fs from 'node:fs';
import type { Request, Response } from 'express';
import { HttpError, badRequest, unauthorized } from '../lib/http.ts';
import { isManager } from '../lib/auth.ts';
import {
  buildStreamInfo,
  ensureDuration,
  getPlayableRow,
  getResumePoint,
  heartbeat,
  parsePlaybackOptions,
  resolveMediaFile,
  sendPlaybackFile,
  subtitleInfo,
} from '../services/playback.ts';
import type { HeartbeatInput, PlaybackOptions, PlaybackFile } from '../services/playback.ts';
import { ensureSession, getSessionForMedia, masterPlaylist, noteSegmentRequest, releasePlaybackSession, sessionFile, sessionSummary, stopSession } from '../services/transcode.ts';
import { ensureSubtitleVttPath, getSubtitle, listSubtitles } from '../services/subtitles.ts';
import type { MediaRow, SubtitleRow } from '../types.ts';

export const streamRouter = Router();

function parseMediaId(raw: string | string[]): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{1,12}$/.test(value)) throw badRequest('Media id must be a positive integer.', { id: raw });
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('Media id must be a positive integer.', { id: value });
  return id;
}

function currentUserId(req: Request): number {
  if (!req.user) throw unauthorized();
  return req.user.id;
}

function loadMedia(req: Request): MediaRow {
  return getPlayableRow(parseMediaId(req.params.id));
}

function optionsFor(req: Request, subtitles: SubtitleRow[]): PlaybackOptions {
  return parsePlaybackOptions(req.query as Record<string, unknown>, (subId) => subtitles.filter((row) => row.id === subId));
}

streamRouter.get('/:id/info', async (req, res) => {
  const media = loadMedia(req);
  const subtitles = await listSubtitles(media);
  const info = await buildStreamInfo(media, optionsFor(req, subtitles), subtitles);
  res.setHeader('Cache-Control', 'no-store');
  res.json(info);
});

streamRouter.get('/:id/progress', async (req, res) => {
  const media = loadMedia(req);
  const resume = getResumePoint(currentUserId(req), media.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    progress: resume,
    resume,
    positionSeconds: resume ? resume.positionSeconds : 0,
    durationSeconds: resume ? resume.durationSeconds : await ensureDuration(media),
    finished: resume ? resume.finished : false,
    updatedAt: resume ? resume.updatedAt : null,
  });
});

function heartbeatInput(req: Request): HeartbeatInput {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const position = body.positionSeconds ?? body.position;
  const duration = body.durationSeconds ?? body.duration;
  if (position !== undefined && (typeof position !== 'number' || !Number.isFinite(position) || position < 0)) {
    throw badRequest('positionSeconds must be a non-negative number.');
  }
  if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) {
    throw badRequest('durationSeconds must be a non-negative number.');
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') throw badRequest('sessionId must be a string.');
  if (body.mode !== undefined && body.mode !== 'direct' && body.mode !== 'transcode' && body.mode !== 'remux') {
    throw badRequest('mode must be direct, transcode, or remux.');
  }
  if (body.bytesSent !== undefined && (typeof body.bytesSent !== 'number' || !Number.isFinite(body.bytesSent) || body.bytesSent < 0)) {
    throw badRequest('bytesSent must be a non-negative number.');
  }
  const agent = req.get('user-agent') || '';
  return {
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    positionSeconds: typeof position === 'number' ? position : undefined,
    durationSeconds: typeof duration === 'number' ? duration : undefined,
    finished: body.finished === true,
    ended: body.ended === true,
    mode: typeof body.mode === 'string' ? body.mode : undefined,
    client: typeof body.client === 'string' ? body.client.slice(0, 200) : agent.slice(0, 200) || undefined,
    bytesSent: typeof body.bytesSent === 'number' ? body.bytesSent : undefined,
  };
}

streamRouter.post('/:id/progress', async (req, res) => {
  const media = loadMedia(req);
  const result = await heartbeat(media, currentUserId(req), heartbeatInput(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});

streamRouter.get('/:id/subtitles', async (req, res) => {
  const media = loadMedia(req);
  const subtitles = await listSubtitles(media);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: subtitles.map((row) => subtitleInfo(media.id, row)) });
});

streamRouter.get('/:id/subtitles/:file', async (req, res) => {
  const media = loadMedia(req);
  const filename = req.params.file;
  const match = /^(\d{1,12})\.vtt$/.exec(filename);
  if (!match) throw badRequest('Subtitle URL must look like /subtitles/<id>.vtt.', { file: filename });
  const subtitle = getSubtitle(media, Number(match[1]));
  const vttPath = await ensureSubtitleVttPath(media, subtitle);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(vttPath);
  } catch {
    throw new HttpError(500, 'Subtitle cache entry vanished between conversion and serving.', 'subtitle_conversion_failed');
  }
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }
  res.status(200).send(await fs.promises.readFile(vttPath));
});

const serveDirect = (req: Request, res: Response): void => {
  const media = loadMedia(req);
  const file: PlaybackFile = resolveMediaFile(media);
  sendPlaybackFile(req, res, file);
};

streamRouter.get('/:id', serveDirect);

streamRouter.get('/:id/hls/master.m3u8', async (req, res) => {
  const media = loadMedia(req);
  const subtitles = await listSubtitles(media);
  const options = optionsFor(req, subtitles);
  try {
    const session = await ensureSession(media, options, currentUserId(req));
    const playlist = masterPlaylist(session, media);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Transcode-Session', session.id);
    res.setHeader('X-Transcode-State', session.state);
    res.setHeader('X-Transcode-Mode', session.mode);
    res.setHeader('X-Transcode-Encoder', session.hw.encoder);
    res.setHeader('X-Transcode-Summary', JSON.stringify(sessionSummary(session)));
    res.status(200).send(playlist);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      const details = (error.details || {}) as { retryAfterSeconds?: number };
      res.setHeader('Retry-After', String(details.retryAfterSeconds ?? 5));
    }
    throw error;
  }
});

streamRouter.get('/:id/hls/:sessionId/:file', (req, res) => {
  const media = loadMedia(req);
  const session = getSessionForMedia(req.params.sessionId, media.id);
  const found = sessionFile(session, req.params.file);
  noteSegmentRequest(session, req.params.file);
  const isPlaylist = found.mime === 'application/vnd.apple.mpegurl';
  res.setHeader('Content-Type', found.mime);
  res.setHeader('Content-Length', String(found.bytes));
  res.setHeader('Cache-Control', isPlaylist ? 'no-store' : 'private, max-age=3600');
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }
  res.status(200).send(fs.readFileSync(found.filePath));
});

streamRouter.post('/:id/hls/release', (req, res) => {
  const media = loadMedia(req);
  const psid = typeof req.body?.psid === 'string' ? req.body.psid : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(psid)) throw badRequest('psid must be a playback session id.', { psid });
  const released = releasePlaybackSession(media.id, currentUserId(req), psid);
  res.json({ ok: true, released });
});

streamRouter.delete('/:id/hls/:sessionId', (req, res) => {
  const media = loadMedia(req);
  const session = getSessionForMedia(req.params.sessionId, media.id);
  if (session.userId !== currentUserId(req) && !isManager(req.user)) {
    throw new HttpError(403, 'Only the session owner or a manager can stop this transcode.', 'forbidden');
  }
  const stopped = stopSession(session.id);
  res.json({ ok: true, stopped });
});
