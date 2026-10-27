import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../config.ts';
import { logger } from '../lib/logger.ts';
import type { AudioTrack, Chapter } from '../types.ts';

export interface ProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'attachment' | 'data' | 'unknown';
  codec: string;
  language: string;
  title: string | null;
  default: boolean;
  forced: boolean;
  channels: number | null;
  channelLayout: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  fps: number | null;
  pixelFormat: string | null;
}

export interface ProbeChapter {
  start: number;
  end: number;
  title: string;
}

export interface ProbeResult {
  path: string;
  container: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  bitrate: number | null;
  video: ProbeStream | null;
  audio: ProbeStream[];
  subtitles: ProbeStream[];
  streams: ProbeStream[];
  chapters: ProbeChapter[];
  tags: Record<string, string>;
}

export class ProbeError extends Error {
  code: string;
  constructor(message: string, code = 'probe_failed') {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  channel_layout?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string; tags?: Record<string, string> };
  chapters?: { start_time?: string; end_time?: string; tags?: Record<string, string> }[];
}

const TYPE_MAP: Record<string, ProbeStream['type']> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  attachment: 'attachment',
  data: 'data',
};

function num(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fps(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    const rate = numerator / denominator;
    return rate > 0 && rate < 1000 ? Math.round(rate * 1000) / 1000 : null;
  }
  return num(value);
}

function normalizeStream(raw: RawStream, fallbackIndex: number): ProbeStream {
  const tags = raw.tags || {};
  return {
    index: typeof raw.index === 'number' ? raw.index : fallbackIndex,
    type: TYPE_MAP[raw.codec_type || ''] || 'unknown',
    codec: raw.codec_name || 'unknown',
    language: (tags.language || 'und').toLowerCase().slice(0, 16),
    title: tags.title ? String(tags.title).slice(0, 200) : null,
    default: Boolean(raw.disposition?.default),
    forced: Boolean(raw.disposition?.forced),
    channels: raw.channels ?? null,
    channelLayout: raw.channel_layout ?? null,
    width: raw.width ?? null,
    height: raw.height ?? null,
    bitrate: num(raw.bit_rate),
    fps: fps(raw.avg_frame_rate || raw.r_frame_rate),
    pixelFormat: raw.pix_fmt ?? null,
  };
}

/** Semaphore used by the scanner so we never run 100 ffprobes at once. */
class Semaphore {
  private limit: number;
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push(resolve);
      await promise;
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

export const probeLimit = new Semaphore(config.scanConcurrency);

function execProbe(filePath: string, timeoutMs: number): Promise<RawProbe> {
  const { promise, resolve, reject } = Promise.withResolvers<RawProbe>();
  let child: ChildProcess;
  try {
    child = spawn(
      config.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    reject(new ProbeError(`ffprobe is not available: ${(error as Error).message}`, 'ffprobe_unavailable'));
    return promise;
  }
  const chunks: Buffer[] = [];
  let stderr = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    reject(new ProbeError(`ffprobe timed out after ${timeoutMs}ms`, 'probe_timeout'));
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 20 * 1024 * 1024) {
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new ProbeError('ffprobe output too large', 'probe_overflow'));
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString().slice(0, 4000);
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new ProbeError(error.code === 'ENOENT' ? 'ffprobe binary not found' : error.message, 'ffprobe_unavailable'));
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) {
      reject(new ProbeError(stderr.trim().split('\n')[0] || `ffprobe exited with code ${code}`, 'probe_failed'));
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RawProbe);
    } catch {
      reject(new ProbeError('ffprobe returned unparseable JSON', 'probe_failed'));
    }
  });
  return promise;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Skip the concurrency queue (used for single-item refresh from HTTP handlers). */
  immediate?: boolean;
}

/** Probe one media file. Never throws for a missing/broken file — callers get ProbeError. */
export async function probeFile(filePath: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProbeError(code === 'ENOENT' ? 'File is gone. It pulled a vanishing act.' : `Cannot stat file: ${code || 'unknown'}`, 'file_missing');
  }
  if (!stat.isFile()) throw new ProbeError('Not a regular file', 'not_a_file');
  if (stat.size === 0) throw new ProbeError('File is empty (0 bytes of pure nothing)', 'empty_file');

  const raw = options.immediate ? await execProbe(filePath, timeoutMs) : await probeLimit.run(() => execProbe(filePath, timeoutMs));
  const streams = (raw.streams || []).map((stream, i) => normalizeStream(stream, i));
  const video = streams.find((stream) => stream.type === 'video') || null;
  const audio = streams.filter((stream) => stream.type === 'audio');
  const subtitles = streams.filter((stream) => stream.type === 'subtitle');
  const format = raw.format || {};
  const chapters: ProbeChapter[] = (raw.chapters || []).map((chapter) => ({
    start: num(chapter.start_time) ?? 0,
    end: num(chapter.end_time) ?? 0,
    title: chapter.tags?.title ? String(chapter.tags.title).slice(0, 200) : '',
  }));
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(format.tags || {})) {
    if (typeof value === 'string') tags[key.toLowerCase()] = value.slice(0, 2000);
  }
  let duration = num(format.duration);
  if (duration === null && video) {
    const videoDuration = (raw.streams || []).find((stream) => stream.codec_type === 'video')?.tags?.DURATION;
    if (videoDuration) duration = num(videoDuration);
  }
  return {
    path: filePath,
    container: format.format_name ? String(format.format_name).split(',')[0] : null,
    durationSeconds: duration !== null && duration >= 0 ? Math.round(duration * 1000) / 1000 : null,
    sizeBytes: num(format.size) ?? stat.size,
    bitrate: num(format.bit_rate),
    video,
    audio,
    subtitles,
    streams,
    chapters,
    tags,
  };
}

export function audioTracksOf(probe: ProbeResult): AudioTrack[] {
  return probe.audio.map((stream) => ({
    index: stream.index,
    codec: stream.codec,
    channels: stream.channels,
    language: stream.language,
    title: stream.title,
    default: stream.default,
  }));
}

export function chaptersOf(probe: ProbeResult): Chapter[] {
  return probe.chapters.map((chapter) => ({ start: chapter.start, end: chapter.end, title: chapter.title }));
}

/** True when ffprobe can be spawned at all. Cached after the first check. */
let availability: boolean | null = null;
export async function ffprobeAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    try {
      const child = spawn(config.ffprobePath, ['-version'], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, 4000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
    availability = await promise;
  }
  if (!availability) logger.warn('ffprobe', 'ffprobe unavailable; scans will store files without technical metadata');
  return availability;
}

export function resetProbeAvailability(): void {
  availability = null;
}
