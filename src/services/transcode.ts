import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { settings } from '../db.ts';
import { logger } from '../lib/logger.ts';
import { HttpError, badRequest, notFound } from '../lib/http.ts';
import type { MediaRow } from '../types.ts';
import type { PlaybackOptions } from './playback.ts';
import { ensureSubtitleVttPath, ffmpegAvailable, runCommand } from './subtitles.ts';
import { normalizeCodec, remuxEligible, REMUX_AUDIO } from './codecs.ts';
import { detectHwAccel, markHwAccelFailed, selectEncoder, selectSoftwareEncoder } from './hwaccel.ts';
import type { SelectedEncoder } from './hwaccel.ts';

export type SessionState = 'starting' | 'running' | 'stopped' | 'error';
export type SessionMode = 'transcode' | 'remux';

export interface TranscodeSession {
  id: string;
  key: string;
  playSessionId: string | null;
  mediaId: number;
  userId: number;
  dir: string;
  audioIndex: number | null;
  subtitleId: number | null;
  burn: boolean;
  start: number;
  height: number;
  preset: string;
  mode: SessionMode;
  generation: number;
  hw: SelectedEncoder;
  decodeHw: boolean;
  hwRetried: boolean;
  destroyed: boolean;
  state: SessionState;
  proc: ChildProcess | null;
  createdAt: number;
  lastAccess: number;
  lastRequestedIndex: number;
  pendingStart: number | null;
  throttled: boolean;
  lastError: string | null;
  stderrTail: string[];
  exit: { code: number | null; signal: string | null; at: number } | null;
  readyPromise: Promise<void> | null;
}

const sessions = new Map<string, TranscodeSession>();
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const PLAYABLE_EXT: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  aac: 'audio/aac',
  vtt: 'text/vtt',
};
let availabilityPromise: Promise<boolean> | null = null;

/** Memoized async probe so a missing ffmpeg becomes a clean 503 instead of a mystery 500. */
export function transcodeAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    availabilityPromise = ffmpegAvailable().then((available) => {
      if (!available) logger.warn('transcode', 'ffmpeg unavailable — direct play only', { ffmpeg: config.ffmpegPath });
      return available;
    });
  }
  return availabilityPromise;
}

export function idleTimeoutMs(): number {
  const override = Number(process.env.TRANSCODE_IDLE_SECONDS);
  if (Number.isFinite(override) && override > 0) return Math.min(override * 1000, 60 * 60_000);
  return 90_000;
}

export function transcodeHeight(): number {
  const configured = Number(settings.get('maxTranscodeHeight')) || config.maxTranscodeHeight;
  return Math.min(Math.max(Math.round(configured), 144), 2160);
}

export function transcodeActiveCount(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.state === 'starting' || session.state === 'running') count += 1;
  }
  return count;
}

async function ensureTranscodeReady(): Promise<void> {
  if (!settings.get('transcodeEnabled')) {
    throw new HttpError(503, 'Transcoding is switched off in settings. Direct play or bust.', 'transcode_disabled', { reason: 'disabled' });
  }
  if (!(await transcodeAvailable())) {
    throw new HttpError(503, 'ffmpeg is not installed, so transcoding cannot start. Direct play still works, chief.', 'transcode_unavailable', { reason: 'ffmpeg_missing' });
  }
}

function sessionKey(media: MediaRow, options: PlaybackOptions, height: number, mode: SessionMode): string {
  const preset = settings.get('transcodePreset') || config.transcodePreset;
  // Start deliberately excluded: a seek restarts the same session instead of burning a new
  // concurrency slot. One viewer = one transcoder, like Plex/Jellyfin sessions.
  const hw = settings.get('hwAccel');
  return [media.id, options.playSessionId ?? 'anon', options.audio ?? 'auto', options.subtitle ? options.subtitle.id : 'none', options.burn ? 'burn' : 'noburn', height, preset, mode, hw].join('|');
}

function findReusable(key: string, userId: number, mediaId: number): TranscodeSession | undefined {
  for (const session of sessions.values()) {
    if (session.key !== key || session.userId !== userId || session.mediaId !== mediaId) continue;
    if (session.state === 'error') continue;
    if (!fs.existsSync(session.dir)) continue;
    return session;
  }
  return undefined;
}

function targetHeight(row: MediaRow, maxHeight: number): number {
  const source = row.height && row.height > 0 ? row.height : maxHeight;
  const height = Math.min(source, maxHeight);
  const even = height - (height % 2);
  return Math.max(144, even);
}

interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
}

interface ProbeCacheEntry {
  mtimeMs: number;
  size: number;
  streams: ProbeStream[];
}

const streamProbeCache = new Map<string, ProbeCacheEntry>();
const streamProbeJobs = new Map<string, Promise<ProbeStream[]>>();

/** Async, cached, single-flight stream probe. Concurrent session starts share one ffprobe. */
async function probeStreams(filePath: string): Promise<ProbeStream[]> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const cached = streamProbeCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.streams;
  const key = `${filePath}|${Math.floor(stat.mtimeMs)}|${stat.size}`;
  const pending = streamProbeJobs.get(key);
  if (pending) return pending;
  const job = (async (): Promise<ProbeStream[]> => {
    const result = await runCommand(
      config.ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name', '-of', 'json', filePath],
      { lane: 'probe', timeoutMs: 20_000 },
    );
    if (result.code !== 0) return cached ? cached.streams : [];
    let streams: ProbeStream[] = [];
    try {
      const parsed = JSON.parse(result.stdout || '{}') as { streams?: ProbeStream[] };
      streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    } catch {
      streams = [];
    }
    streamProbeCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, streams });
    if (streamProbeCache.size > 200) {
      const oldest = streamProbeCache.keys().next().value;
      if (oldest) streamProbeCache.delete(oldest);
    }
    return streams;
  })().finally(() => streamProbeJobs.delete(key));
  streamProbeJobs.set(key, job);
  return job;
}

/** Map the client's audio index to an ffmpeg map spec, validating it really is an audio stream. */
function resolveAudioMap(streams: ProbeStream[], requested: number | null): { map: string; index: number } | null {
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (audio.length === 0) return null;
  if (requested !== null) {
    const exact = audio.find((stream) => stream.index === requested);
    if (exact) return { map: `0:${exact.index}`, index: exact.index };
    if (requested >= 0 && requested < audio.length) {
      const ordinal = audio[requested];
      if (ordinal) return { map: `0:a:${requested}`, index: ordinal.index };
    }
    throw badRequest('That audio track does not exist in this file, so the transcode would be silent and sad.', { audio: requested });
  }
  const first = audio[0];
  return { map: `0:${first.index}`, index: first.index };
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function segmentSeconds(): number {
  return clamp(Math.round(config.hlsSegmentSeconds), 1, 30);
}

function targetWidth(row: MediaRow, height: number): number {
  const sourceWidth = row.width && row.width > 0 ? row.width : 0;
  const sourceHeight = row.height && row.height > 0 ? row.height : 0;
  if (sourceWidth > 0 && sourceHeight > 0) return Math.max(2, Math.round((sourceWidth * (height / sourceHeight)) / 2) * 2);
  return Math.max(2, Math.round((height * 16) / 9 / 2) * 2);
}

function bitrateCeiling(row: MediaRow): number {
  if (!row.bitrate || row.bitrate <= 0) return 0;
  return Math.min(Math.max(Math.round(row.bitrate * 1.1), 800_000), 20_000_000);
}

const SOFTWARE_PRESET_TO_NVENC: Record<string, string> = {
  ultrafast: 'p1', superfast: 'p2', veryfast: 'p3', faster: 'p4', fast: 'p5', medium: 'p6', slow: 'p7', slower: 'p7', veryslow: 'p7',
};

/** Decode on the GPU only when the matching filter chain is known-good; burn-in stays on CPU. */
function hardwareDecodeArgs(session: TranscodeSession): string[] {
  if (!session.decodeHw || !session.hw.hardware) return [];
  if (session.hw.decode === 'vaapi' && session.hw.device) {
    return ['-hwaccel', 'vaapi', '-hwaccel_device', session.hw.device, '-hwaccel_output_format', 'vaapi'];
  }
  if (session.hw.decode === 'cuda') return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'];
  if (session.hw.decode === 'qsv') {
    return ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'];
  }
  return [];
}

function videoFilter(session: TranscodeSession, burnPath: string | null, width: number): string {
  const filters: string[] = [];
  const decodeHw = session.decodeHw && session.hw.hardware;
  if (decodeHw && session.hw.decode === 'vaapi') filters.push(`scale_vaapi=w=${width}:h=${session.height}`);
  else if (decodeHw && session.hw.decode === 'cuda') filters.push(`scale_cuda=w=${width}:h=${session.height}`);
  else if (decodeHw && session.hw.decode === 'qsv') filters.push(`vpp_qsv=w=${width}:h=${session.height}`);
  else filters.push(`scale=${width}:${session.height}`);
  if (burnPath) filters.push(`subtitles=filename='${escapeFilterPath(burnPath)}'`);
  if (!decodeHw && (session.hw.kind === 'vaapi' || session.hw.kind === 'vulkan' || session.hw.kind === 'rkmpp')) {
    filters.push('format=nv12', 'hwupload');
  } else if (!decodeHw && (session.hw.kind === 'v4l2m2m')) {
    filters.push('format=yuv420p');
  } else if (!decodeHw && session.hw.kind === 'nvenc') {
    filters.push('format=nv12');
  }
  return filters.join(',');
}

function videoEncodeArgs(session: TranscodeSession, row: MediaRow, width: number): string[] {
  const sourceCeiling = bitrateCeiling(row);
  // V4L2/RKMPP/Vulkan encoders have no useful quality mode; give them an explicit bitrate.
  const fixedBitrateKind = session.hw.kind === 'v4l2m2m' || session.hw.kind === 'rkmpp' || session.hw.kind === 'vulkan';
  const ceiling = sourceCeiling || (fixedBitrateKind ? Math.min(12_000_000, Math.max(1_500_000, Math.round(width * session.height * 2))) : 0);
  const args: string[] = [];
  const hw = session.hw;
  const fps = row.fps && row.fps > 1 && row.fps < 120 ? row.fps : 24;
  if (hw.kind === 'software') {
    args.push('-c:v', 'libx264', '-preset', session.preset, '-crf', '23', '-pix_fmt', 'yuv420p');
  } else if (hw.kind === 'nvenc') {
    args.push('-c:v', hw.encoder, '-preset', SOFTWARE_PRESET_TO_NVENC[session.preset] || 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0');
  } else if (hw.kind === 'qsv') {
    args.push('-c:v', hw.encoder, '-preset', session.preset, '-global_quality', '23', '-look_ahead', '0');
  } else if (hw.kind === 'vaapi') {
    if (ceiling > 0) args.push('-c:v', hw.encoder, '-rc_mode', 'VBR');
    else args.push('-c:v', hw.encoder, '-rc_mode', 'CQP', '-qp', '23');
  } else if (hw.kind === 'amf') {
    if (ceiling > 0) args.push('-c:v', hw.encoder, '-quality', 'balanced', '-rc', 'vbr_peak');
    else args.push('-c:v', hw.encoder, '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23');
  } else if (hw.kind === 'v4l2m2m') {
    args.push('-c:v', hw.encoder);
  } else if (hw.kind === 'rkmpp') {
    args.push('-c:v', hw.encoder, '-rc_mode', 'VBR');
  } else if (hw.kind === 'vulkan') {
    args.push('-c:v', hw.encoder);
  } else {
    args.push('-c:v', hw.encoder, '-allow_sw', '1');
  }
  if (hw.kind !== 'software' && ceiling > 0) args.push('-b:v', String(ceiling), '-maxrate', String(ceiling), '-bufsize', String(ceiling * 2));
  else if (hw.kind === 'software' && ceiling > 0) args.push('-maxrate', String(ceiling), '-bufsize', String(ceiling * 2));
  if (session.mode === 'transcode') {
    args.push('-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds()})`, '-g', String(Math.max(12, Math.round(fps * segmentSeconds()))));
  }
  return args;
}

function hlsArgs(session: TranscodeSession): string[] {
  if (session.mode === 'remux') {
    return [
      '-f', 'hls',
      '-hls_time', String(segmentSeconds()),
      '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', `init_${session.generation}.mp4`,
      '-hls_segment_filename', path.join(session.dir, `g${session.generation}_seg_%05d.m4s`),
      '-max_muxing_queue_size', '1024',
      path.join(session.dir, 'media.m3u8'),
    ];
  }
  return [
    '-f', 'hls',
    '-hls_time', String(segmentSeconds()),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(session.dir, `g${session.generation}_seg_%05d.ts`),
    '-max_muxing_queue_size', '1024',
    path.join(session.dir, 'media.m3u8'),
  ];
}

function buildArgs(session: TranscodeSession, row: MediaRow, filePath: string, burnPath: string | null, streams: ProbeStream[]): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
  if (session.hw.kind === 'qsv' && !(session.decodeHw && session.hw.hardware)) {
    args.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
  }
  if (session.hw.kind === 'rkmpp') args.push('-init_hw_device', 'rkmpp=hw', '-filter_hw_device', 'hw');
  if (session.hw.kind === 'vulkan') args.push('-init_hw_device', 'vulkan=hw', '-filter_hw_device', 'hw');
  if (session.hw.kind === 'vaapi' && session.hw.device && !(session.decodeHw && session.hw.hardware)) {
    args.push('-vaapi_device', session.hw.device);
  }
  args.push(...hardwareDecodeArgs(session));
  // Input seek is accurate when re-encoding and orders of magnitude cheaper than decoding
  // from zero. Burn-in subtitles are shifted to the seek offset up front, so no output seek.
  if (session.start > 0) args.push('-ss', String(session.start));
  args.push('-i', filePath);

  const hasVideo = streams.some((stream) => stream.codec_type === 'video') && row.kind !== 'track';
  const audioMap = resolveAudioMap(streams, session.audioIndex);
  const width = targetWidth(row, session.height);

  if (hasVideo) {
    args.push('-map', '0:v:0');
    if (session.mode === 'remux') {
      args.push('-c:v', 'copy');
    } else {
      args.push('-vf', videoFilter(session, burnPath, width));
      args.push(...videoEncodeArgs(session, row, width));
    }
  } else {
    args.push('-vn');
  }

  if (audioMap) {
    args.push('-map', audioMap.map);
    const codec = normalizeCodec(streams.find((stream) => stream.index === audioMap.index)?.codec_name);
    if (session.mode === 'remux' && REMUX_AUDIO[codec]) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', hasVideo ? '160k' : '192k', '-ac', '2');
    }
  } else {
    args.push('-an');
  }
  args.push('-sn', '-map_metadata', '-1');
  args.push(...hlsArgs(session));
  return args;
}

/** Burn-in needs the original cue timeline; with input seek, shift cues back to zero. */
function shiftVtt(text: string, offsetSeconds: number): string {
  if (offsetSeconds <= 0) return text;
  const shiftTime = (stamp: string): string => {
    const parts = stamp.replace(',', '.').split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return stamp;
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    const shifted = Math.max(0, seconds - offsetSeconds);
    const hours = Math.floor(shifted / 3600);
    const minutes = Math.floor((shifted % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${(shifted % 60).toFixed(3).padStart(6, '0')}`;
  };
  return text.split(/\r?\n/).map((line) => (line.includes('-->') ? line.replace(/\d{1,2}:\d{2}:\d{2}[.,]\d{3}/g, shiftTime) : line)).join('\n');
}

async function burnSubtitlePath(row: MediaRow, subtitle: NonNullable<PlaybackOptions['subtitle']>, start: number): Promise<string> {
  const vtt = await ensureSubtitleVttPath(row, subtitle);
  if (start <= 0) return vtt;
  const shiftedPath = path.join(config.cacheDir, 'subtitles', `burn_${subtitle.id}_${Math.floor(start)}.vtt`);
  try {
    const stat = fs.statSync(shiftedPath);
    if (stat.mtimeMs >= fs.statSync(vtt).mtimeMs) return shiftedPath;
  } catch {
    /* regenerate below */
  }
  const text = await fs.promises.readFile(vtt, 'utf8');
  await fs.promises.mkdir(path.dirname(shiftedPath), { recursive: true });
  await fs.promises.writeFile(shiftedPath, shiftVtt(text, start), 'utf8');
  return shiftedPath;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function playlistReady(dir: string): boolean {
  const playlist = path.join(dir, 'media.m3u8');
  if (!fs.existsSync(playlist)) return false;
  try {
    return fs.readdirSync(dir).some((name) => /(^|_)seg_\d+\.(ts|m4s)$/.test(name));
  } catch {
    return false;
  }
}

function encodedSegmentCount(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => /(^|_)seg_\d+\.(ts|m4s)$/.test(name)).length;
  } catch {
    return 0;
  }
}

/** Feed the throttle from segment requests so the encoder cannot fill the disk behind a paused client. */
export function noteSegmentRequest(session: TranscodeSession, filename: string): void {
  session.lastAccess = Date.now();
  const match = /_seg_(\d+)\./.exec(filename);
  if (match) session.lastRequestedIndex = Math.max(session.lastRequestedIndex, Number(match[1]));
}

/**
 * Plex/Jellyfin both throttle slow clients by pausing the transcoder once it is far enough
 * ahead. SIGSTOP is the cheapest equivalent: zero CPU, zero disk growth, instant resume.
 */
function throttleSessions(): void {
  const limitSeconds = Math.max(0, Number(settings.get('transcodeThrottleSeconds')) || 0);
  for (const session of sessions.values()) {
    const proc = session.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) continue;
    if (session.state !== 'running') continue;
    const aheadSeconds = Math.max(0, encodedSegmentCount(session.dir) - 1 - session.lastRequestedIndex) * segmentSeconds();
    if (limitSeconds === 0) {
      if (session.throttled) resumeThrottled(session);
      continue;
    }
    if (!session.throttled && aheadSeconds >= limitSeconds) {
      try {
        proc.kill('SIGSTOP');
        session.throttled = true;
      } catch {
        /* process exited between stat and signal */
      }
    } else if (session.throttled && aheadSeconds <= Math.max(2, limitSeconds * 0.5)) {
      resumeThrottled(session);
    }
  }
}

function resumeThrottled(session: TranscodeSession): void {
  try {
    session.proc?.kill('SIGCONT');
  } catch {
    /* already gone */
  }
  session.throttled = false;
}

function killProcess(session: TranscodeSession, signal: NodeJS.Signals = 'SIGTERM'): void {
  const proc = session.proc;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill(signal);
  } catch {
    /* already gone */
  }
  if (signal === 'SIGTERM') {
    const hardKill = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 2_000);
    hardKill.unref();
  }
}

function destroySession(session: TranscodeSession): void {
  session.destroyed = true;
  sessions.delete(session.id);
  killProcess(session, 'SIGTERM');
  try {
    fs.rmSync(session.dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  logger.debug('transcode', `Session ${session.id.slice(0, 8)} torn down`, { mediaId: session.mediaId });
}

export function stopSession(sessionId: string, opts: { userId?: number; requireOwner?: boolean } = {}): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (opts.requireOwner && opts.userId !== undefined && session.userId !== opts.userId) return false;
  destroySession(session);
  return true;
}

/** Page unload / route change: release every transcode owned by this tab. */
export function releasePlaybackSession(mediaId: number, userId: number, playSessionId: string): number {
  let removed = 0;
  for (const session of [...sessions.values()]) {
    if (session.mediaId !== mediaId || session.userId !== userId || session.playSessionId !== playSessionId) continue;
    destroySession(session);
    removed += 1;
  }
  if (removed > 0) logger.debug('transcode', `Released ${removed} session(s) for playback ${playSessionId.slice(0, 8)}`);
  return removed;
}

export function cleanupIdleSessions(now = Date.now()): number {
  const idle = idleTimeoutMs();
  let removed = 0;
  for (const session of [...sessions.values()]) {
    if (now - session.lastAccess < idle) continue;
    destroySession(session);
    removed += 1;
  }
  if (removed > 0) logger.debug('transcode', `Idle sweep removed ${removed} session(s)`);
  return removed;
}

export function shutdownTranscodes(): void {
  for (const session of [...sessions.values()]) {
    killProcess(session, 'SIGKILL');
    try {
      fs.rmSync(session.dir, { recursive: true, force: true });
    } catch {
      /* shutdown best-effort */
    }
  }
  sessions.clear();
}

const cleanupEvery = Math.max(1_000, Math.min(10_000, Math.floor(idleTimeoutMs() / 2)));
setInterval(() => {
  try {
    cleanupIdleSessions();
  } catch (error) {
    logger.warn('transcode', 'Idle session sweep failed', { message: error instanceof Error ? error.message : String(error) });
  }
}, cleanupEvery).unref();
// Throttling must react in real time: hardware encoders can burn through minutes of video
// between idle sweeps. One second is cheap (a readdir per live session).
setInterval(() => {
  try {
    throttleSessions();
  } catch (error) {
    logger.warn('transcode', 'Transcode throttle pass failed', { message: error instanceof Error ? error.message : String(error) });
  }
}, 1_000).unref();
process.once('SIGINT', shutdownTranscodes);
process.once('SIGTERM', shutdownTranscodes);
process.on('exit', shutdownTranscodes);

function writeSessionManifest(session: TranscodeSession, row: MediaRow): void {
  const manifest = {
    id: session.id,
    mediaId: row.id,
    audioIndex: session.audioIndex,
    subtitleId: session.subtitleId,
    burn: session.burn,
    start: session.start,
    height: session.height,
    preset: session.preset,
    mode: session.mode,
    encoder: session.hw.encoder,
    hardware: session.hw.hardware,
    createdAt: new Date(session.createdAt).toISOString(),
  };
  try {
    fs.writeFileSync(path.join(session.dir, 'session.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (error) {
    logger.debug('transcode', 'Could not write session manifest', { message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Create (or reuse) an HLS session. Concurrency is enforced here so a refreshed playlist cannot
 * sneak past the cap, and every early failure tears its own directory/process down.
 */
async function spawnSession(session: TranscodeSession, row: MediaRow, options: PlaybackOptions): Promise<void> {
  const burnPath = options.burn && options.subtitle ? await burnSubtitlePath(row, options.subtitle, session.start) : null;
  const streams = await probeStreams(row.path);
  if (session.destroyed) throw new Error('transcode session was released');
  const args = buildArgs(session, row, row.path, burnPath, streams);
  const env = session.hw.kind === 'vaapi' && session.hw.driver ? { ...process.env, LIBVA_DRIVER_NAME: session.hw.driver } : undefined;
  const proc = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: session.dir, env });
  session.proc = proc;
  session.exit = null;
  session.stderrTail = [];
  session.state = 'starting';
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (session.proc !== proc) return;
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      session.stderrTail.push(trimmed.slice(0, 300));
      if (session.stderrTail.length > 40) session.stderrTail.shift();
    }
  });
  proc.on('error', (error) => {
    if (session.proc !== proc) return;
    session.state = 'error';
    session.lastError = error.message;
    logger.error('transcode', 'ffmpeg failed to spawn', { message: error.message });
  });
  proc.on('exit', (code, signal) => {
    if (session.proc !== proc) return;
    session.exit = { code, signal, at: Date.now() };
    if (session.state === 'starting') session.state = playlistReady(session.dir) ? 'running' : 'error';
    else if (session.state === 'running') session.state = 'stopped';
    if (code !== 0 && code !== null) {
      session.lastError = session.stderrTail[session.stderrTail.length - 1] || `ffmpeg exited with ${code}`;
      logger.warn('transcode', `ffmpeg exited ${code} for media ${row.id}`, { stderr: session.stderrTail.slice(-3) });
    }
  });
  await waitForPlaylist(session, row.id);
}

/**
 * Hardware init can fail on a machine where `ffmpeg -encoders` lies (missing driver, locked
 * render node, broken firmware). Retry the same seek on software once, then give up honestly.
 */
async function startWithFallback(session: TranscodeSession, row: MediaRow, options: PlaybackOptions): Promise<void> {
  let lastError: unknown;
  if (session.destroyed) throw new Error('transcode session was released');
  try {
    await spawnSession(session, row, options);
    return;
  } catch (error) {
    if (session.destroyed) throw error;
    lastError = error;
    if (session.hw.hardware && session.decodeHw) {
      // Many files use codecs the GPU decoder does not support (MPEG-4 Part 2, older VC-1).
      // Keep the hardware encoder, retry with software decode once.
      logger.info('transcode', 'Hardware decode failed; retrying with hardware encode only', {
        encoder: session.hw.encoder,
        reason: session.stderrTail.slice(-1)[0],
      });
      session.decodeHw = false;
      killProcess(session, 'SIGKILL');
      prepareSessionDir(session.dir);
      try {
        await spawnSession(session, row, options);
        return;
      } catch (error) {
        lastError = error;
        /* fall through to software encode */
      }
    }
    if (session.hw.hardware && !session.hwRetried) {
      const reason = session.stderrTail.slice(-2).join(' | ') || session.lastError || 'hardware start failed';
      markHwAccelFailed(session.hw, reason);
      session.hw = selectSoftwareEncoder();
      session.decodeHw = false;
      session.hwRetried = true;
      killProcess(session, 'SIGKILL');
      prepareSessionDir(session.dir);
      await spawnSession(session, row, options);
      return;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'transcode start failed'));
  }
}

function prepareSessionDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Create or reuse an HLS session. A seek keeps the same session identity and restarts ffmpeg
 * at the new offset, so scrubbing cannot exhaust the concurrency cap with zombie sessions.
 */
export async function ensureSession(row: MediaRow, options: PlaybackOptions, userId: number): Promise<TranscodeSession> {
  await ensureTranscodeReady();
  if (!row.path || !path.isAbsolute(row.path)) throw new HttpError(422, 'This media row has no sane file path.', 'invalid_media_path');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(row.path);
  } catch {
    throw new HttpError(410, 'The file for this item is missing from disk.', 'media_file_missing');
  }
  if (!stat.isFile()) throw new HttpError(422, 'Media path is not a regular file.', 'invalid_media_path');

  const height = targetHeight(row, transcodeHeight());
  const preset = settings.get('transcodePreset') || config.transcodePreset;
  const mode: SessionMode = remuxEligible(row, options) ? 'remux' : 'transcode';
  const key = sessionKey(row, options, height, mode);
  const reusable = findReusable(key, userId, row.id);
  if (reusable) {
    reusable.lastAccess = Date.now();
    if (Math.abs(reusable.start - options.start) >= 1) {
      await restartSession(reusable, row, options);
      return reusable;
    }
    if (reusable.readyPromise) await reusable.readyPromise;
    return reusable;
  }
  // Same viewer switching audio/subtitles disposes their previous session immediately.
  if (options.playSessionId) {
    for (const other of [...sessions.values()]) {
      if (other.userId === userId && other.mediaId === row.id && other.playSessionId === options.playSessionId && other.key !== key) {
        destroySession(other);
      }
    }
  }
  let active = transcodeActiveCount();
  if (active >= config.transcodeConcurrency) {
    // A viewer switching audio/subtitles creates a new session key. Reclaim that viewer's old
    // session before telling them the server is full, like a sane transcode manager.
    for (const other of [...sessions.values()]) {
      if (other.userId === userId && other.mediaId === row.id && other.key !== key) destroySession(other);
    }
    active = transcodeActiveCount();
  }
  if (active >= config.transcodeConcurrency) {
    throw new HttpError(429, 'Every transcoder is busy transcoding slop. Try again in a second.', 'transcode_busy', {
      active,
      limit: config.transcodeConcurrency,
      retryAfterSeconds: 5,
    });
  }

  const hwReport = await detectHwAccel();
  const hw = selectEncoder(hwReport, settings.get('hwAccel'), settings.get('hwAccelDevice'));
  const id = randomUUID();
  const dir = path.join(config.transcodeDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const session: TranscodeSession = {
    id,
    key,
    playSessionId: options.playSessionId,
    mediaId: row.id,
    userId,
    dir,
    audioIndex: options.audio,
    subtitleId: options.subtitle ? options.subtitle.id : null,
    burn: options.burn,
    start: options.start,
    height,
    preset,
    mode,
    generation: 1,
    hw,
    decodeHw: hw.hardware && hw.decode !== null && settings.get('hwAccelDecode') && !options.burn && row.kind !== 'track',
    hwRetried: false,
    destroyed: false,
    state: 'starting',
    proc: null,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    lastRequestedIndex: 0,
    pendingStart: null,
    throttled: false,
    lastError: null,
    stderrTail: [],
    exit: null,
    readyPromise: null,
  };
  const gate = Promise.withResolvers<void>();
  gate.promise.catch(() => {
    /* surfaced to whoever awaits readyPromise; this just marks it handled */
  });
  session.readyPromise = gate.promise;
  sessions.set(id, session);
  writeSessionManifest(session, row);

  try {
    await startWithFallback(session, row, options);
    gate.resolve();
    return session;
  } catch (error) {
    gate.reject(error instanceof Error ? error : new Error(String(error)));
    destroySession(session);
    throw error;
  }
}

const restartingSessions = new Map<string, Promise<void>>();

/** Seek inside one session: kill the encoder, drop old segments, respawn at the target offset. */
async function restartSession(session: TranscodeSession, row: MediaRow, options: PlaybackOptions): Promise<void> {
  session.pendingStart = options.start;
  const existing = restartingSessions.get(session.id);
  if (existing) await existing;
  if (session.pendingStart === null) return;
  const run = async (): Promise<void> => {
    while (session.pendingStart !== null && !session.destroyed) {
      const target = session.pendingStart;
      if (Math.abs(session.start - target) < 1) {
        session.pendingStart = null;
        return;
      }
      session.lastAccess = Date.now();
      session.start = target;
      session.generation += 1;
      session.lastRequestedIndex = 0;
      session.throttled = false;
      session.state = 'starting';
      session.exit = null;
      killProcess(session, 'SIGKILL');
      prepareSessionDir(session.dir);
      writeSessionManifest(session, row);
      const gate = Promise.withResolvers<void>();
      gate.promise.catch(() => {
        /* handled by the caller awaiting readyPromise */
      });
      session.readyPromise = gate.promise;
      try {
        await startWithFallback(session, row, { ...options, start: target });
        gate.resolve();
        logger.info('transcode', `Session ${session.id.slice(0, 8)} seeked to ${target}s`, { mediaId: row.id });
      } catch (error) {
        session.state = 'error';
        session.pendingStart = null;
        gate.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      if (session.pendingStart === target) session.pendingStart = null;
    }
  };
  const job = run().finally(() => restartingSessions.delete(session.id));
  restartingSessions.set(session.id, job);
  return job;
}

async function waitForPlaylist(session: TranscodeSession, mediaId: number): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (session.destroyed) throw new Error('transcode session was released');
    if (playlistReady(session.dir)) {
      if (session.state === 'starting') session.state = session.exit ? 'stopped' : 'running';
      session.lastAccess = Date.now();
      logger.info('transcode', `Session ready for media ${mediaId}`, {
        session: session.id.slice(0, 8),
        height: session.height,
        mode: session.mode,
        encoder: session.hw.encoder,
      });
      return;
    }
    if (session.state === 'error' && session.exit) break;
    await sleep(100);
  }
  const stderr = session.stderrTail.slice(-5).join(' | ');
  throw new HttpError(500, 'The transcoder faceplanted before producing a single segment. Skill issue on the file, probably.', 'transcode_failed', {
    stderr: stderr || undefined,
    signal: session.exit?.signal ?? null,
  });
}


export function masterPlaylist(session: TranscodeSession, row: MediaRow): string {
  const variant = `/api/stream/${session.mediaId}/hls/${session.id}/media.m3u8`;
  const lines = ['#EXTM3U', session.mode === 'remux' ? '#EXT-X-VERSION:7' : '#EXT-X-VERSION:3'];
  if (row.kind === 'track') {
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"');
  } else {
    const sourceWidth = row.width && row.width > 0 ? row.width : 1920;
    const sourceHeight = row.height && row.height > 0 ? row.height : session.height;
    const width = Math.max(2, Math.round((sourceWidth * (session.height / sourceHeight)) / 2) * 2);
    const estimated = row.bitrate && row.bitrate > 0 ? row.bitrate : Math.round(sourceWidth * sourceHeight * 1.6);
    const bandwidth = Math.min(Math.max(estimated, 400_000), 20_000_000);
    const videoCodec = session.mode === 'remux' ? normalizeCodec(row.video_codec) : 'h264';
    const videoTag = videoCodec === 'av1' ? 'av01.0.08M.08' : videoCodec === 'vp9' ? 'vp09.00.10.08' : 'avc1.640028';
    const audioTag = session.mode === 'remux' && normalizeCodec(row.audio_codec) === 'opus' ? 'opus' : 'mp4a.40.2';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${session.height},CODECS="${videoTag},${audioTag}"`);
  }
  lines.push(variant);
  const content = `${lines.join('\n')}\n`;
  try {
    fs.writeFileSync(path.join(session.dir, 'master.m3u8'), content, 'utf8');
  } catch {
    /* regenerable */
  }
  return content;
}

export function getSessionForMedia(sessionId: string, mediaId: number): TranscodeSession {
  if (!SESSION_RE.test(sessionId)) throw notFound('That session id does not look like a session id.');
  const session = sessions.get(sessionId);
  if (!session) throw new HttpError(404, 'That transcode session expired or never existed. Rewind the vibes and restart it.', 'session_not_found');
  if (session.mediaId !== mediaId) throw new HttpError(404, 'That session does not belong to this media.', 'session_not_found');
  session.lastAccess = Date.now();
  return session;
}

export interface SessionFile {
  filePath: string;
  mime: string;
  bytes: number;
}

/** Filename allowlist + directory containment. No traversal, no arbitrary files, no apologies. */
export function sessionFile(session: TranscodeSession, filename: string): SessionFile {
  if (!filename || filename.length > 128 || !SEGMENT_RE.test(filename) || filename.includes('..')) {
    throw notFound('That filename is not in the guest list.');
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  const mime = PLAYABLE_EXT[extension];
  if (!mime) throw notFound('That file type is not served from transcode sessions.');
  const dir = path.resolve(session.dir);
  const filePath = path.resolve(dir, filename);
  if (path.dirname(filePath) !== dir) throw notFound('That path tries to leave the session directory. Cute.');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new HttpError(404, 'That segment is not on disk yet. Patience, or maybe the transcoder noped out.', 'segment_not_ready');
  }
  if (!stat.isFile()) throw notFound('Not a segment.');
  return { filePath, mime, bytes: stat.size };
}

export function sessionSummary(session: TranscodeSession) {
  return {
    id: session.id,
    mediaId: session.mediaId,
    state: session.state,
    mode: session.mode,
    audioIndex: session.audioIndex,
    subtitleId: session.subtitleId,
    burn: session.burn,
    start: session.start,
    height: session.height,
    preset: session.preset,
    encoder: session.hw.encoder,
    hardware: session.hw.hardware,
    hwAccel: session.hw.kind,
    throttled: session.throttled,
    createdAt: new Date(session.createdAt).toISOString(),
    lastAccess: new Date(session.lastAccess).toISOString(),
  };
}


/**
 * Crash leftovers: directories from a previous process cannot have a live ffmpeg behind them.
 * Sweep old ones at boot so /data/cache/transcode does not become an archaeological site.
 */
function sweepOrphanedSessions(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.transcodeDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - Math.max(idleTimeoutMs(), 60_000);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_RE.test(entry.name)) continue;
    const dir = path.join(config.transcodeDir, entry.name);
    try {
      const stat = fs.statSync(dir);
      if (stat.mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  if (removed > 0) logger.info('transcode', `Swept ${removed} orphaned transcode session(s) at boot`);
}

sweepOrphanedSessions();
