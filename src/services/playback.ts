import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.ts';
import { getDb, nowISO, settings } from '../db.ts';
import { bus, logger } from '../lib/logger.ts';
import { HttpError, badRequest, notFound } from '../lib/http.ts';
import { listSubtitles, runCommand } from './subtitles.ts';
import { normalizeCodec, remuxEligible } from './codecs.ts';
import { detectHwAccel, selectEncoder } from './hwaccel.ts';
import { transcodeActiveCount, transcodeAvailable, transcodeHeight } from './transcode.ts';
import type { AudioTrack, MediaRow, ProgressRow, StreamMode, SubtitleRow } from '../types.ts';

const PLAYABLE_KINDS: Record<string, true> = { movie: true, episode: true, video: true, track: true };
const PLAYABLE_VIDEO: Record<string, true> = { movie: true, episode: true, video: true };
const PLAYABLE_AUDIO: Record<string, true> = { track: true };

/** Browsers are picky little gremlins. Only these combinations get the direct-play badge. */
const BROWSER_VIDEO: Record<string, string[]> = {
  mp4: ['h264', 'av1', 'vp9'],
  m4v: ['h264', 'av1'],
  mov: ['h264'],
  webm: ['vp8', 'vp9', 'av1'],
};
const BROWSER_AUDIO: Record<string, string[]> = {
  mp4: ['aac', 'mp3', 'opus'],
  m4v: ['aac', 'mp3', 'opus'],
  mov: ['aac', 'mp3'],
  webm: ['opus', 'vorbis'],
};
/** Standalone audio files: the browser can always fetch the bytes itself. */
const AUDIO_CONTAINERS = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'oga', 'wav']);

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

export interface PlaybackFile {
  row: MediaRow;
  filePath: string;
  size: number;
  mtimeMs: number;
  etag: string;
}

export interface SelectedAudio {
  index: number | null;
  track: AudioTrack | null;
}

export interface PlaybackOptions {
  forceTranscode: boolean;
  audio: number | null;
  subtitle: SubtitleRow | null;
  burn: boolean;
  start: number;
  /** Stable per-viewer/per-tab id so two tabs of the same item do not fight over one ffmpeg. */
  playSessionId: string | null;
}

export interface PlaybackDecision {
  directPlay: boolean;
  mode: StreamMode;
  reasons: string[];
  container: string;
  videoCodec: string;
  audioCodec: string;
  audio: SelectedAudio;
  burn: boolean;
}

export { normalizeCodec } from './codecs.ts';

export function containerOf(row: MediaRow): string {
  const fromFile = path.extname(row.path).replace('.', '').toLowerCase();
  const container = (row.container || fromFile || '').toLowerCase();
  return container === 'm4v' ? 'm4v' : container;
}

export function extensionOf(row: MediaRow): string {
  return path.extname(row.path).replace('.', '').toLowerCase();
}

export function mimeTypeFor(row: MediaRow): string {
  const ext = extensionOf(row);
  return MIME[ext] || (Boolean(PLAYABLE_AUDIO[row.kind]) ? 'audio/mpeg' : 'application/octet-stream');
}

export function isAudioMedia(row: MediaRow): boolean {
  return Boolean(PLAYABLE_AUDIO[row.kind]);
}

export function parseAudioTracks(row: MediaRow): AudioTrack[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.audio_tracks || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tracks: AudioTrack[] = [];
  parsed.forEach((entry, ordinal) => {
    if (!entry || typeof entry !== 'object') return;
    const raw = entry as Record<string, unknown>;
    const index = Number(raw.index);
    const codec = typeof raw.codec === 'string' ? raw.codec : '';
    if (!Number.isFinite(index) || index < 0 || !codec) return;
    tracks.push({
      index,
      codec,
      channels: Number.isFinite(Number(raw.channels)) ? Number(raw.channels) : null,
      language: typeof raw.language === 'string' && raw.language ? raw.language : 'und',
      title: typeof raw.title === 'string' && raw.title ? raw.title : null,
      default: Boolean(raw.default) || (ordinal === 0 && raw.default === undefined),
    });
  });
  return tracks;
}

export function selectAudio(row: MediaRow, requested: number | null): SelectedAudio {
  const tracks = parseAudioTracks(row);
  if (requested !== null) {
    const match = tracks.find((track) => track.index === requested) || null;
    if (match) return { index: match.index, track: match };
    // Scanner may not have stored tracks yet. Accept the raw ffprobe stream index, but say we're guessing.
    if (tracks.length === 0) return { index: requested, track: null };
    throw badRequest('That audio track is not on this file. Pick one from audioTracks.', { audio: requested });
  }
  const fallback = tracks.find((track) => track.default) || tracks[0] || null;
  return { index: fallback ? fallback.index : null, track: fallback };
}

/** Conservative direct-play call: if any part is uncertain, transcode. Trust issues are a feature. */
export function decidePlayback(row: MediaRow, options: PlaybackOptions): PlaybackDecision {
  const container = containerOf(row);
  const audio = selectAudio(row, options.audio);
  const videoCodec = normalizeCodec(row.video_codec);
  const audioCodec = normalizeCodec(audio.track?.codec || row.audio_codec);
  const reasons: string[] = [];
  let direct = true;

  const audioOnly = isAudioMedia(row);
  if (!PLAYABLE_VIDEO[row.kind] && !audioOnly) {
    reasons.push('This kind of item does not stream. It just vibes.');
    direct = false;
  }

  if (options.forceTranscode) {
    direct = false;
    reasons.push('Force-transcode was requested. Trust issues: activated.');
  }
  if (options.burn) {
    direct = false;
    reasons.push('Subtitle burn-in needs the transcoder. Eye strain avoided by force.');
  }
  if (options.subtitle && (options.subtitle.is_external === 0 || options.subtitle.stream_index !== null) && options.burn) {
    // covered above, kept explicit for the burn path
  }

  if (direct && !audioOnly) {
    if (!BROWSER_VIDEO[container]) {
      direct = false;
      reasons.push(`${container || 'unknown'} container is not browser-native. Certified transcode moment.`);
    }
  }
  if (direct && !audioOnly) {
    const allowedVideo = BROWSER_VIDEO[container] || [];
    if (!videoCodec || !allowedVideo.includes(videoCodec)) {
      direct = false;
      reasons.push(`Video codec ${videoCodec || 'unknown'} is not a safe direct-play bet in ${container}.`);
    } else if (!audioCodec || !(BROWSER_AUDIO[container] || []).includes(audioCodec)) {
      direct = false;
      reasons.push(`Audio codec ${audioCodec || 'unknown'} is not safe in ${container}; browser might sulk.`);
    }
  }
  if (direct && audioOnly) {
    const ext = extensionOf(row);
    if (!AUDIO_CONTAINERS.has(ext)) {
      direct = false;
      reasons.push(`${ext || 'unknown'} audio is not directly playable here.`);
    }
  }

  if (direct) reasons.push(audioOnly ? 'Direct play. Bytes go brrr.' : 'Direct play. Container and codecs are browser-certified.');

  let mode: PlaybackDecision['mode'] = direct ? 'direct' : 'transcode';
  if (!direct && remuxEligible(row, options)) {
    mode = 'remux';
    reasons.push('Remux path: video is copied without re-encoding; only audio is converted when needed.');
  }

  return {
    directPlay: direct,
    mode,
    reasons,
    container,
    videoCodec,
    audioCodec,
    audio,
    burn: options.burn,
  };
}

export function getPlayableRow(id: number): MediaRow {
  const row = getDb().prepare('SELECT * FROM media WHERE id = ? AND hidden = 0').get(id) as MediaRow | undefined;
  if (!row) throw notFound('No such media. It never existed, or it got ratioed.');
  if (!PLAYABLE_KINDS[row.kind]) {
    throw badRequest('That item is a container, not a playable file. Play an episode or track instead.', { kind: row.kind });
  }
  return row;
}

/** Only ever serves a path that came out of the media table, and only if it is a regular file. */
export function resolveMediaFile(row: MediaRow): PlaybackFile {
  const raw = row.path;
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) {
    throw new HttpError(422, 'This media row has no sane file path. Blame the scanner.', 'invalid_media_path');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(raw);
  } catch {
    throw new HttpError(410, 'The file for this item is missing from disk. Gone, reduced to atoms.', 'media_file_missing');
  }
  if (!stat.isFile()) throw new HttpError(422, 'Media path is not a regular file.', 'invalid_media_path');
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  return { row, filePath: raw, size: stat.size, mtimeMs: stat.mtimeMs, etag };
}

const durationCache = new Map<number, number>();
const durationJobs = new Map<number, Promise<number>>();

/**
 * Duration from ffprobe, cached in memory and backfilled into the row when the scanner skipped it.
 * Async + single-flight: concurrent requests share one probe and the event loop stays free.
 */
export async function ensureDuration(row: MediaRow): Promise<number> {
  if (row.runtime_seconds && row.runtime_seconds > 0) return row.runtime_seconds;
  const cached = durationCache.get(row.id);
  if (cached && cached > 0) return cached;
  const pending = durationJobs.get(row.id);
  if (pending) return pending;
  const job = (async (): Promise<number> => {
    const result = await runCommand(
      config.ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', row.path],
      { lane: 'probe', timeoutMs: 15_000, maxBytes: 1024 * 1024 },
    );
    const duration = Number((result.stdout || '').trim());
    if (result.code !== 0 || !Number.isFinite(duration) || duration <= 0) return row.runtime_seconds || 0;
    const rounded = Math.round(duration);
    durationCache.set(row.id, rounded);
    try {
      getDb().prepare('UPDATE media SET runtime_seconds = ? WHERE id = ? AND (runtime_seconds IS NULL OR runtime_seconds = 0)').run(rounded, row.id);
    } catch {
      /* metadata backfill is best-effort */
    }
    return rounded;
  })().finally(() => durationJobs.delete(row.id));
  durationJobs.set(row.id, job);
  return job;
}

export interface SubtitleInfo {
  id: number;
  language: string;
  label: string;
  format: string;
  forced: number;
  isExternal: boolean;
  streamIndex: number | null;
  url: string;
}

export interface StreamInfo {
  id: number;
  kind: string;
  title: string;
  directPlay: boolean;
  mode: StreamMode;
  reasons: string[];
  container: string;
  videoCodec: string;
  audioCodec: string;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  fps: number | null;
  duration: number;
  sizeBytes: number | null;
  audioTracks: Array<AudioTrack & { selected: boolean }>;
  selectedAudio: number | null;
  subtitles: SubtitleInfo[];
  selectedSubtitle: number | null;
  burn: boolean;
  start: number;
  directUrl: string;
  hlsUrl: string | null;
  transcode: {
    available: boolean;
    enabled: boolean;
    active: number;
    limit: number;
    height: number;
    preset: string;
    segmentSeconds: number;
    mode: string;
    throttleSeconds: number;
    hardware: { kind: string; encoder: string; device: string | null; active: boolean };
    hwaccel: { preference: string; device: string; available: Array<{ kind: string; encoder: string; device: string | null; label: string }> };
  };
  session: { id: string | null; state: string | null };
}

function buildHlsUrl(mediaId: number, options: PlaybackOptions): string {
  const params = new URLSearchParams();
  if (options.audio !== null) params.set('audio', String(options.audio));
  if (options.subtitle) params.set('subtitle', String(options.subtitle.id));
  if (options.burn) params.set('burn', '1');
  if (options.forceTranscode) params.set('force', '1');
  if (options.playSessionId) params.set('psid', options.playSessionId);
  if (options.start > 0) params.set('start', String(Math.floor(options.start)));
  const query = params.toString();
  return `/api/stream/${mediaId}/hls/master.m3u8${query ? `?${query}` : ''}`;
}

export async function buildStreamInfo(row: MediaRow, options: PlaybackOptions, knownSubtitles?: SubtitleRow[]): Promise<StreamInfo> {
  const decision = decidePlayback(row, options);
  const [duration, available, hwReport] = await Promise.all([ensureDuration(row), transcodeAvailable(), detectHwAccel()]);
  const hwPreference = settings.get('hwAccel');
  const hwDevice = settings.get('hwAccelDevice');
  const activeEncoder = selectEncoder(hwReport, hwPreference, hwDevice);
  const tracks = parseAudioTracks(row);
  const subtitles = (knownSubtitles ?? (await listSubtitles(row))).map((sub) => subtitleInfo(row.id, sub));
  const enabled = settings.get('transcodeEnabled');
  const canTranscode = available && enabled;
  const reasons = [...decision.reasons];
  if (!decision.directPlay && !canTranscode) {
    reasons.push(
      available
        ? 'Transcoding is disabled in settings. Direct play only, chief.'
        : 'ffmpeg is missing, so transcoding is off the menu. Direct play still works.',
    );
  }
  if (options.subtitle && options.burn && !canTranscode) reasons.push('Burn-in requested, but the transcoder is unavailable.');
  if (options.subtitle && !options.burn) reasons.push('External subtitles play alongside direct playback; embedded ones may need burn-in.');
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    directPlay: decision.directPlay,
    mode: decision.mode,
    reasons,
    container: decision.container,
    videoCodec: decision.videoCodec,
    audioCodec: decision.audioCodec,
    width: row.width,
    height: row.height,
    bitrate: row.bitrate,
    fps: row.fps,
    duration,
    sizeBytes: row.size_bytes,
    audioTracks: tracks.map((track) => ({ ...track, selected: decision.audio.index !== null && track.index === decision.audio.index })),
    selectedAudio: decision.audio.index,
    subtitles,
    selectedSubtitle: options.subtitle ? options.subtitle.id : null,
    burn: options.burn,
    start: options.start,
    directUrl: `/api/stream/${row.id}`,
    hlsUrl: canTranscode ? buildHlsUrl(row.id, options) : null,
    transcode: {
      available,
      enabled,
      active: transcodeActiveCount(),
      limit: config.transcodeConcurrency,
      height: transcodeHeight(),
      preset: settings.get('transcodePreset') || config.transcodePreset,
      segmentSeconds: config.hlsSegmentSeconds,
      mode: decision.mode,
      throttleSeconds: settings.get('transcodeThrottleSeconds'),
      hardware: {
        kind: activeEncoder.kind,
        encoder: activeEncoder.encoder,
        device: activeEncoder.device,
        active: activeEncoder.hardware,
      },
      hwaccel: {
        preference: hwPreference,
        device: hwDevice,
        available: hwReport.encoders.map((entry) => ({ kind: entry.kind, encoder: entry.encoder, device: entry.device, label: entry.label })),
      },
    },
    session: { id: null, state: null },
  };
}

export function subtitleInfo(mediaId: number, sub: SubtitleRow): SubtitleInfo {
  return {
    id: sub.id,
    language: sub.language,
    label: sub.label,
    format: sub.format,
    forced: sub.forced,
    isExternal: sub.is_external === 1,
    streamIndex: sub.stream_index,
    url: `/api/stream/${mediaId}/subtitles/${sub.id}.vtt`,
  };
}

export function parsePlaybackOptions(query: Record<string, unknown>, subtitlesFor: (id: number) => SubtitleRow[]): PlaybackOptions {
  const forceTranscode = boolValue(query.forceTranscode) || boolValue(query.force);
  const burn = boolValue(query.burn);
  const audioRaw = intValue(query.audio);
  if (query.audio !== undefined && audioRaw === null) throw badRequest('audio must be a numeric stream index.');
  if (audioRaw !== null && (audioRaw < 0 || audioRaw > 64)) throw badRequest('audio must be a stream index between 0 and 64.');
  const startRaw = query.start === undefined ? 0 : Number(query.start);
  if (!Number.isFinite(startRaw) || startRaw < 0) throw badRequest('start must be a non-negative number of seconds.');
  const start = Math.floor(startRaw);
  if (start > 60 * 60 * 12) throw badRequest('start is a bit ambitious. Keep it under 12 hours.');
  const subtitleRaw = intValue(query.subtitle);
  if (query.subtitle !== undefined && subtitleRaw === null) throw badRequest('subtitle must be a numeric subtitle id.');
  let subtitle: SubtitleRow | null = null;
  if (subtitleRaw !== null) {
    const found = subtitlesFor(subtitleRaw).find((entry) => entry.id === subtitleRaw);
    if (!found) throw badRequest('No such subtitle on this media.', { subtitle: subtitleRaw });
    subtitle = found;
  }
  if (burn && !subtitle) throw badRequest('burn=1 needs a subtitle id to burn. Otherwise you are just wasting CPU.');
  const psidRaw = Array.isArray(query.psid) ? query.psid[0] : query.psid;
  if (psidRaw !== undefined && (typeof psidRaw !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(psidRaw))) {
    throw badRequest('psid must be an 8-64 char playback session id.', { psid: psidRaw });
  }
  return { forceTranscode, audio: audioRaw, subtitle, burn, start, playSessionId: typeof psidRaw === 'string' ? psidRaw : null };
}

function boolValue(value: unknown): boolean {
  if (Array.isArray(value)) return boolValue(value[0]);
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function intValue(value: unknown): number | null {
  if (Array.isArray(value)) return intValue(value[0]);
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

/**
 * Serve a DB-resolved media file with Range support. Suffix ranges (`bytes=-4096`) included.
 * No filename in headers, no paths in errors: the client gets bytes, not a map of the server.
 */
export function sendPlaybackFile(req: Request, res: Response, file: PlaybackFile): void {
  const mime = mimeTypeFor(file.row);
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', file.etag);
  res.setHeader('Last-Modified', new Date(file.mtimeMs).toUTCString());
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', 'inline');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && etagMatches(ifNoneMatch, file.etag)) {
    res.status(304).end();
    return;
  }
  if (!ifNoneMatch) {
    const ims = req.headers['if-modified-since'];
    if (ims) {
      const since = Date.parse(ims);
      if (Number.isFinite(since) && Math.floor(file.mtimeMs / 1000) * 1000 <= since) {
        res.status(304).end();
        return;
      }
    }
  }

  const range = parseRange(req.headers.range, file.size);
  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${file.size}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(416).json({ error: { code: 'range_not_satisfiable', message: 'Your Range header is off the map.', details: { size: file.size } } });
    return;
  }

  const head = req.method === 'HEAD';
  if (!range) {
    res.setHeader('Content-Length', String(file.size));
    res.status(200);
    if (head) {
      res.end();
      return;
    }
    streamBytes(req, res, file.filePath, 0, Math.max(0, file.size - 1));
    return;
  }

  const { start, end } = range;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.status(206);
  if (head) {
    res.end();
    return;
  }
  streamBytes(req, res, file.filePath, start, end);
}

function etagMatches(header: string, etag: string): boolean {
  return header
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === '*' || part === etag || part === etag.replace(/^W\//, '') || `W/${part}` === etag);
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header || size <= 0) return null;
  const value = header.trim();
  if (!value.startsWith('bytes=')) return null;
  const spec = value.slice('bytes='.length).trim();
  if (!spec || spec.includes(',')) return null; // multi-range: serve the whole file, keep it boring
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return 'invalid';
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return 'invalid';
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || start >= size) return 'invalid';
  const end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function streamBytes(req: Request, res: Response, filePath: string, start: number, end: number): void {
  const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
  };
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  stream.on('error', (error) => {
    logger.warn('playback', 'Stream read failed mid-flight', { message: error.message });
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(500).json({ error: { code: 'stream_failed', message: 'The bytes tripped over a cable.' } });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

export interface ResumePoint {
  positionSeconds: number;
  durationSeconds: number;
  finished: boolean;
  episodeId: number | null;
  updatedAt: string;
}

export interface HeartbeatInput {
  sessionId?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  finished?: boolean;
  ended?: boolean;
  mode?: string;
  client?: string;
  bytesSent?: number;
}

export interface HeartbeatResult {
  ok: true;
  sessionId: string;
  mode: StreamMode;
  started: boolean;
  ended: boolean;
  resume: ResumePoint;
}

const MAX_DURATION_SECONDS = 60 * 60 * 12;
const FINISH_FRACTION = 0.9;
const FINISH_TAIL_SECONDS = 30;
const STREAM_STALE_MS = 5 * 60_000;

function clampNumber(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

function rowToResume(row: ProgressRow): ResumePoint {
  return {
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    finished: row.finished === 1,
    episodeId: row.episode_id,
    updatedAt: row.updated_at,
  };
}

export function getResumePoint(userId: number, mediaId: number): ResumePoint | null {
  const row = getDb().prepare('SELECT * FROM progress WHERE user_id = ? AND media_id = ?').get(userId, mediaId) as ProgressRow | undefined;
  return row ? rowToResume(row) : null;
}

function upsertProgress(userId: number, mediaId: number, episodeId: number | null, position: number, duration: number, finished: boolean, incrementPlay: boolean): ResumePoint {
  const now = nowISO();
  getDb()
    .prepare(
      `INSERT INTO progress(user_id, media_id, episode_id, position_seconds, duration_seconds, finished, play_count, updated_at)
       VALUES(@user, @media, @episode, @position, @duration, @finished, 1, @now)
       ON CONFLICT(user_id, media_id) DO UPDATE SET
         position_seconds = excluded.position_seconds,
         duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE progress.duration_seconds END,
         finished = excluded.finished,
         episode_id = COALESCE(excluded.episode_id, progress.episode_id),
         play_count = progress.play_count + @increment,
         updated_at = excluded.updated_at`,
    )
    .run({
      user: userId,
      media: mediaId,
      episode: episodeId,
      position,
      duration,
      finished: finished ? 1 : 0,
      now,
      increment: incrementPlay ? 1 : 0,
    });
  const row = getDb().prepare('SELECT * FROM progress WHERE user_id = ? AND media_id = ?').get(userId, mediaId) as ProgressRow;
  return rowToResume(row);
}

function markWatched(userId: number, mediaId: number): void {
  getDb()
    .prepare(
      `INSERT INTO item_state(user_id, media_id, favorite, watched, rating, updated_at)
       VALUES(?, ?, 0, 1, NULL, ?)
       ON CONFLICT(user_id, media_id) DO UPDATE SET watched = 1, updated_at = excluded.updated_at`,
    )
    .run(userId, mediaId, nowISO());
}

function findStream(sessionId: string, userId: number, mediaId: number) {
  return getDb()
    .prepare('SELECT * FROM streams WHERE id = ? AND user_id = ? AND media_id = ?')
    .get(sessionId, userId, mediaId) as { id: string; mode: string; position: number; bytes_sent: number } | undefined;
}

function findRecentStream(userId: number, mediaId: number) {
  const cutoff = new Date(Date.now() - STREAM_STALE_MS).toISOString();
  return getDb()
    .prepare('SELECT * FROM streams WHERE user_id = ? AND media_id = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 1')
    .get(userId, mediaId, cutoff) as { id: string; mode: string; position: number; bytes_sent: number } | undefined;
}

export async function heartbeat(media: MediaRow, userId: number, input: HeartbeatInput): Promise<HeartbeatResult> {
  const durationFallback = input.durationSeconds && input.durationSeconds > 0 ? 0 : await ensureDuration(media);
  const duration = clampNumber(input.durationSeconds, 0, MAX_DURATION_SECONDS) || clampNumber(durationFallback, 0, MAX_DURATION_SECONDS) || 0;
  let position = clampNumber(input.positionSeconds, 0, MAX_DURATION_SECONDS) || 0;
  if (duration > 0) position = Math.min(position, duration);
  const finished = input.finished === true || (duration > 0 && (position >= duration * FINISH_FRACTION || (duration > 120 && position >= duration - FINISH_TAIL_SECONDS)));

  const modeRaw = typeof input.mode === 'string' ? input.mode : '';
  const mode: StreamMode = modeRaw === 'transcode' || modeRaw === 'remux' ? modeRaw : media.kind === 'track' ? 'direct' : 'direct';

  let sessionId = typeof input.sessionId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(input.sessionId) ? input.sessionId : null;
  let existing = sessionId ? findStream(sessionId, userId, media.id) : undefined;
  if (!existing) {
    const active = findRecentStream(userId, media.id);
    sessionId = active ? active.id : null;
    existing = active;
  }
  const started = !existing;
  if (!sessionId) sessionId = randomUUID();
  const now = nowISO();

  if (started) {
    getDb()
      .prepare('INSERT INTO streams(id, user_id, media_id, mode, client, position, started_at, last_seen_at, bytes_sent) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(sessionId, userId, media.id, mode, typeof input.client === 'string' ? input.client.slice(0, 200) : null, position, now, now, Math.max(0, Math.floor(clampNumber(input.bytesSent, 0, 1e15) || 0)));
    bus.publish('stream.started', { streamId: sessionId, sessionId, userId, mediaId: media.id, mode, position });
  } else {
    const bytes = Math.max(existing?.bytes_sent || 0, Math.floor(clampNumber(input.bytesSent, 0, 1e15) || 0));
    getDb().prepare('UPDATE streams SET mode = ?, position = ?, last_seen_at = ?, bytes_sent = ? WHERE id = ?').run(mode, position, now, bytes, sessionId);
  }

  const episodeId = media.kind === 'episode' ? media.id : null;
  const resume = upsertProgress(userId, media.id, episodeId, position, duration, finished, started);
  if (finished) {
    markWatched(userId, media.id);
    if (media.kind === 'episode') syncSeriesAfterEpisode(media, userId, duration);
  }

  const ended = input.ended === true;
  if (ended) {
    getDb().prepare('DELETE FROM streams WHERE id = ?').run(sessionId);
    bus.publish('stream.ended', { streamId: sessionId, sessionId, userId, mediaId: media.id, mode, position, duration, finished });
  }
  return { ok: true, sessionId, mode, started, ended, resume };
}

/** When an episode finishes, keep the show row honest: next-up, or fully watched on the finale. */
function syncSeriesAfterEpisode(episode: MediaRow, userId: number, duration: number): void {
  const db = getDb();
  let seriesId: number | null = null;
  if (episode.parent_id) {
    const parent = db.prepare('SELECT id, kind, parent_id FROM media WHERE id = ?').get(episode.parent_id) as { id: number; kind: string; parent_id: number | null } | undefined;
    if (parent?.kind === 'show') seriesId = parent.id;
    else if (parent?.kind === 'season' && parent.parent_id) seriesId = parent.parent_id;
  }
  if (!seriesId) return;
  const season = episode.season_number ?? 0;
  const number = episode.episode_number ?? 0;
  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM media e
       WHERE e.kind = 'episode' AND e.hidden = 0 AND (e.parent_id = @series
         OR e.parent_id IN (SELECT id FROM media WHERE parent_id = @series AND kind = 'season'))
         AND (COALESCE(e.season_number, 0) > @season
           OR (COALESCE(e.season_number, 0) = @season AND COALESCE(e.episode_number, 0) > @number))`,
    )
    .get({ series: seriesId, season, number }) as { n: number };
  const isFinale = remaining.n === 0;
  const now = nowISO();
  db.prepare(
    `INSERT INTO progress(user_id, media_id, episode_id, position_seconds, duration_seconds, finished, play_count, updated_at)
     VALUES(@user, @series, @episode, 0, @duration, @finished, 1, @now)
     ON CONFLICT(user_id, media_id) DO UPDATE SET
       episode_id = excluded.episode_id,
       position_seconds = 0,
       duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE progress.duration_seconds END,
       finished = excluded.finished,
       updated_at = excluded.updated_at`,
  ).run({ user: userId, series: seriesId, episode: episode.id, duration, finished: isFinale ? 1 : 0, now });
  if (isFinale) markWatched(userId, seriesId);
}

export function cleanupStaleStreams(): number {
  const cutoff = new Date(Date.now() - STREAM_STALE_MS).toISOString();
  const result = getDb().prepare('DELETE FROM streams WHERE last_seen_at < ?').run(cutoff);
  return result.changes;
}

setInterval(() => {
  try {
    cleanupStaleStreams();
  } catch {
    /* db may be closed during shutdown */
  }
}, 60_000).unref();


