import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { getDb, nowISO } from '../db.ts';
import { HttpError, notFound } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';
import type { MediaRow, SubtitleRow } from '../types.ts';

export const SUBTITLE_CACHE_DIR = path.join(config.cacheDir, 'subtitles');

const TEXT_SUBTITLE_CODECS: Record<string, string> = {
  subrip: 'srt',
  ass: 'ass',
  ssa: 'ssa',
  mov_text: 'srt',
  webvtt: 'vtt',
  text: 'srt',
  subtitles: 'srt',
};
const BITMAP_SUBTITLE_CODECS: Record<string, true> = {
  dvd_subtitle: true,
  hdmv_pgs_subtitle: true,
  dvb_subtitle: true,
  xsub: true,
  arib_caption: true,
};
const SUBTITLE_EXTENSIONS: Record<string, true> = { srt: true, vtt: true, ass: true, ssa: true };
const LANGUAGE_FLAGS: Record<string, true> = { forced: true, sdh: true, cc: true, hi: true, sub: true, subs: true, subtitles: true, default: true };

fs.mkdirSync(SUBTITLE_CACHE_DIR, { recursive: true });

interface SubtitleProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

interface ProbeCacheEntry {
  mtimeMs: number;
  size: number;
  streams: SubtitleProbeStream[];
}

const probeCache = new Map<string, ProbeCacheEntry>();
const probeJobs = new Map<string, Promise<SubtitleProbeStream[]>>();

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** `convert` is the small subtitle-conversion lane; `probe` is the wider ffprobe lane. */
  lane?: 'probe' | 'convert';
  env?: NodeJS.ProcessEnv;
}

interface LaneState {
  active: number;
  waiters: Array<() => void>;
}

const laneLimits: Record<string, number> = {
  probe: Math.max(1, Number(process.env.PROBE_CONCURRENCY) || 4),
  convert: Math.max(1, Number(process.env.SUBTITLE_CONVERT_CONCURRENCY) || 2),
};
const lanes = new Map<string, LaneState>();

function laneState(name: string): LaneState {
  let lane = lanes.get(name);
  if (!lane) {
    lane = { active: 0, waiters: [] };
    lanes.set(name, lane);
  }
  return lane;
}

async function acquireSlot(name: string): Promise<void> {
  const lane = laneState(name);
  const limit = laneLimits[name] ?? 2;
  if (lane.active < limit) {
    lane.active += 1;
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  lane.waiters.push(() => resolve());
  await promise;
}

function releaseSlot(name: string): void {
  const lane = laneState(name);
  const next = lane.waiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter so a fresh caller cannot barge in past the limit.
    next();
    return;
  }
  lane.active = Math.max(0, lane.active - 1);
}

const activeChildren = new Set<ChildProcess>();

export function shutdownProcesses(): void {
  for (const child of [...activeChildren]) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  activeChildren.clear();
}

process.once('SIGINT', shutdownProcesses);
process.once('SIGTERM', shutdownProcesses);
process.on('exit', shutdownProcesses);

function spawnCollect(command: string, args: string[], timeoutMs: number, maxBytes: number, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  activeChildren.add(child);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    activeChildren.delete(child);
    resolve({ code, signal, stdout, stderr, timedOut });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref();
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < maxBytes) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    stderr += `${stderr ? ' | ' : ''}${error.message}`;
    finish(null, null);
  });
  child.on('close', (code, signal) => finish(code, signal));
  return promise;
}

/**
 * Run an external process without ever blocking the event loop. Every call takes a slot in a
 * bounded lane, so a pile of subtitle conversions cannot fork-bomb the box.
 */
export async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const lane = options.lane || 'probe';
  await acquireSlot(lane);
  try {
    return await spawnCollect(command, args, options.timeoutMs ?? 20_000, options.maxBytes ?? 8 * 1024 * 1024, options.env);
  } finally {
    releaseSlot(lane);
  }
}

/** Cached, shared availability probe. Concurrent callers await the same promise. */
let ffmpegProbe: Promise<boolean> | null = null;

export function ffmpegAvailable(): Promise<boolean> {
  if (!ffmpegProbe) {
    ffmpegProbe = runCommand(config.ffmpegPath, ['-version'], { lane: 'probe', timeoutMs: 4_000, maxBytes: 64 * 1024 })
      .then((result) => result.code === 0)
      .catch(() => false);
  }
  return ffmpegProbe;
}

async function probeSubtitleStreams(row: MediaRow): Promise<SubtitleProbeStream[]> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(row.path);
  } catch {
    return [];
  }
  const cached = probeCache.get(row.path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.streams;
  const key = `${row.path}|${Math.floor(stat.mtimeMs)}|${stat.size}`;
  const pending = probeJobs.get(key);
  if (pending) return pending;
  const job = (async (): Promise<SubtitleProbeStream[]> => {
    const result = await runCommand(
      config.ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired', '-of', 'json', row.path],
      { lane: 'probe', timeoutMs: 20_000 },
    );
    if (result.code !== 0) return cached ? cached.streams : [];
    let streams: SubtitleProbeStream[] = [];
    try {
      const parsed = JSON.parse(result.stdout || '{}') as { streams?: SubtitleProbeStream[] };
      streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    } catch {
      streams = [];
    }
    probeCache.set(row.path, { mtimeMs: stat.mtimeMs, size: stat.size, streams });
    if (probeCache.size > 300) {
      const oldest = probeCache.keys().next().value;
      if (oldest) probeCache.delete(oldest);
    }
    return streams;
  })().finally(() => probeJobs.delete(key));
  probeJobs.set(key, job);
  return job;
}

/** Human label for a language code, without dragging in a translation library. */
export function languageName(code: string): string {
  const normalized = (code || 'und').toLowerCase();
  if (normalized === 'und' || normalized === 'unknown') return 'Unknown';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized);
    if (name && name.toLowerCase() !== normalized) return name;
  } catch {
    /* fall through */
  }
  const fallback: Record<string, string> = {
    en: 'English',
    eng: 'English',
    es: 'Spanish',
    spa: 'Spanish',
    fr: 'French',
    fre: 'French',
    fra: 'French',
    de: 'German',
    ger: 'German',
    deu: 'German',
    it: 'Italian',
    ita: 'Italian',
    pt: 'Portuguese',
    por: 'Portuguese',
    ja: 'Japanese',
    jpn: 'Japanese',
    ko: 'Korean',
    kor: 'Korean',
    zh: 'Chinese',
    chi: 'Chinese',
    zho: 'Chinese',
    ru: 'Russian',
    rus: 'Russian',
    ar: 'Arabic',
    ara: 'Arabic',
    hi: 'Hindi',
    hin: 'Hindi',
    nl: 'Dutch',
    nld: 'Dutch',
    pl: 'Polish',
    pol: 'Polish',
    tr: 'Turkish',
    tur: 'Turkish',
    sv: 'Swedish',
    swe: 'Swedish',
    und: 'Unknown',
  };
  return fallback[normalized] || normalized.toUpperCase();
}

function labelFor(language: string, forced: boolean, title?: string | null): string {
  const und = (language || 'und').toLowerCase() === 'und';
  const base = title && title.trim() ? title.trim() : und ? 'Subtitles' : languageName(language);
  const suffix = forced && !/\bforced\b/i.test(base) ? ' (forced)' : '';
  return `${base}${suffix}`.slice(0, 120);
}

function rowExists(mediaId: number, conditions: string, params: Record<string, unknown>): boolean {
  const found = getDb().prepare(`SELECT id FROM subtitles WHERE media_id = @media AND ${conditions} LIMIT 1`).get({ media: mediaId, ...params });
  return Boolean(found);
}

function insertSubtitle(row: {
  mediaId: number;
  language: string;
  label: string;
  format: string;
  isExternal: boolean;
  filePath: string | null;
  streamIndex: number | null;
  forced: boolean;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO subtitles(media_id, language, label, format, is_external, path, stream_index, forced, created_at)
         VALUES(@media, @language, @label, @format, @external, @path, @stream, @forced, @now)`,
      )
      .run({
        media: row.mediaId,
        language: row.language,
        label: row.label,
        format: row.format,
        external: row.isExternal ? 1 : 0,
        path: row.filePath,
        stream: row.streamIndex,
        forced: row.forced ? 1 : 0,
        now: nowISO(),
      });
  } catch (error) {
    logger.debug('subtitles', 'Subtitle row insert skipped', { message: error instanceof Error ? error.message : String(error) });
  }
}

interface SidecarParse {
  language: string;
  forced: boolean;
  sdh: boolean;
  format: string;
}

function parseSidecarName(filename: string, mediaBase: string): SidecarParse | null {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!SUBTITLE_EXTENSIONS[extension]) return null;
  if (!filename.toLowerCase().startsWith(`${mediaBase.toLowerCase()}.`)) return null;
  const middle = filename.slice(mediaBase.length + 1, filename.length - extension.length - 1);
  const tokens = middle ? middle.split('.') : [];
  let language = 'und';
  let forced = false;
  let sdh = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'forced') forced = true;
    else if (lower === 'sdh' || lower === 'cc' || lower === 'hi') sdh = true;
    else if (/^[a-z]{2,3}([-_][a-z]{2,4})?$/.test(lower) && !LANGUAGE_FLAGS[lower]) language = lower.replace('_', '-');
  }
  return { language, forced, sdh, format: extension };
}

function discoverSidecars(row: MediaRow, mediaBase: string): void {
  const dir = path.dirname(row.path);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).slice(0, 4000);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().startsWith(`${mediaBase.toLowerCase()}.`)) continue;
    const parsed = parseSidecarName(entry, mediaBase);
    if (!parsed) continue;
    const filePath = path.join(dir, entry);
    if (rowExists(row.id, 'path = @path', { path: filePath })) continue;
    const label = `${labelFor(parsed.language, parsed.forced)}${parsed.sdh ? ' (SDH)' : ''}`;
    insertSubtitle({
      mediaId: row.id,
      language: parsed.language,
      label,
      format: parsed.format,
      isExternal: true,
      filePath,
      streamIndex: null,
      forced: parsed.forced,
    });
  }
}

/**
 * Return every subtitle for a media row, discovering embedded streams and sidecar files first.
 * Idempotent: scanner rows and our discoveries merge without duplicates.
 */
export async function listSubtitles(row: MediaRow): Promise<SubtitleRow[]> {
  const mediaBase = path.basename(row.path, path.extname(row.path));
  if (row.kind !== 'track') {
    const streams = await probeSubtitleStreams(row);
    for (const stream of streams) {
      if (stream.codec_type !== 'subtitle') continue;
      const codec = (stream.codec_name || '').toLowerCase();
      if (BITMAP_SUBTITLE_CODECS[codec] || !TEXT_SUBTITLE_CODECS[codec]) continue;
      if (rowExists(row.id, 'stream_index = @stream AND path IS NULL', { stream: stream.index })) continue;
      const language = (stream.tags?.language || 'und').toLowerCase();
      const forced = Boolean(stream.disposition?.forced);
      const title = stream.tags?.title || null;
      insertSubtitle({
        mediaId: row.id,
        language,
        label: labelFor(language, forced, title),
        format: TEXT_SUBTITLE_CODECS[codec],
        isExternal: false,
        filePath: null,
        streamIndex: stream.index,
        forced,
      });
    }
  }
  discoverSidecars(row, mediaBase);
  const rows = getDb()
    .prepare('SELECT * FROM subtitles WHERE media_id = ? ORDER BY is_external DESC, language, id')
    .all(row.id) as SubtitleRow[];
  const seen = new Set<string>();
  const unique: SubtitleRow[] = [];
  for (const entry of rows) {
    const key = entry.is_external === 1 ? `ext:${entry.path || ''}` : `emb:${entry.stream_index ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

export function getSubtitle(media: MediaRow, subtitleId: number): SubtitleRow {
  const row = getDb().prepare('SELECT * FROM subtitles WHERE id = ? AND media_id = ?').get(subtitleId, media.id) as SubtitleRow | undefined;
  if (!row) throw notFound('No such subtitle for this media. The dialogue remains a mystery.');
  return row;
}

/** Decode UTF-8/UTF-16 and fall back to Windows-1252 for the ancient subtitle archives. */
export function decodeSubtitleBytes(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.length === 0) return { text: '', encoding: 'utf-8' };
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'windows-1252' };
  }
}

function vttTime(hours: string, minutes: string, seconds: string, millis: string): string {
  const ms = `${millis}000`.slice(0, 3);
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}.${ms}`;
}

/** Tolerant SRT → WebVTT. No dependency, no drama, handles comma millis and BOMs. */
export function srtToVtt(source: string): string {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
  const cues: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    if (lines.length === 0) continue;
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index === -1) continue;
    const timing = lines[index].trim();
    const match = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(timing);
    if (!match) continue;
    const start = vttTime(match[1], match[2], match[3], match[4]);
    const end = vttTime(match[5], match[6], match[7], match[8]);
    const payload = lines.slice(index + 1).join('\n').trim();
    if (!payload) continue;
    cues.push(`${start} --> ${end}\n${payload.replace(/-->/g, '→')}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length > 0 ? '\n' : ''}`;
}

export function normalizeVtt(source: string): string {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
  if (/^\s*WEBVTT/.test(text)) return text.endsWith('\n') ? text : `${text}\n`;
  if (text.includes('-->')) return srtToVtt(text);
  return `WEBVTT\n\n${text}\n`;
}

/** External subtitle paths must live inside the library that owns the media. No field trips. */
function assertSidecarAllowed(media: MediaRow, subtitlePath: string): void {
  if (!subtitlePath || subtitlePath.includes('\0') || !path.isAbsolute(subtitlePath)) {
    throw new HttpError(422, 'Subtitle path is not a sane absolute path.', 'invalid_subtitle_path');
  }
  const extension = path.extname(subtitlePath).slice(1).toLowerCase();
  if (!SUBTITLE_EXTENSIONS[extension]) throw new HttpError(415, 'That sidecar format is not supported.', 'unsupported_subtitle_format');
  const library = getDb().prepare('SELECT path FROM libraries WHERE id = ?').get(media.library_id) as { path: string } | undefined;
  if (!library?.path) throw new HttpError(422, 'This media has no library root to validate subtitles against.', 'invalid_subtitle_path');
  const root = path.resolve(library.path);
  const candidate = path.resolve(subtitlePath);
  let realRoot = root;
  let realCandidate = candidate;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    /* library root may be offline; fall back to lexical containment */
  }
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new HttpError(404, 'That subtitle file is missing from disk.', 'subtitle_file_missing');
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new HttpError(403, 'Subtitle path escapes its library root. Denied, and mildly insulted.', 'subtitle_path_forbidden');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realCandidate);
  } catch {
    throw new HttpError(404, 'That subtitle file is missing from disk.', 'subtitle_file_missing');
  }
  if (!stat.isFile()) throw new HttpError(422, 'Subtitle path is not a regular file.', 'invalid_subtitle_path');
}

interface ConversionResult {
  target: string;
  cacheHit: boolean;
}

function cacheTarget(media: MediaRow, subtitle: SubtitleRow, sourceStat: fs.Stats): string {
  const fingerprint = [subtitle.id, subtitle.format, subtitle.path || '', subtitle.stream_index ?? '', sourceStat.mtimeMs, sourceStat.size].join('|');
  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 16);
  return path.join(SUBTITLE_CACHE_DIR, `${media.id}-${subtitle.id}-${hash}.vtt`);
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, content, 'utf8');
  await fs.promises.rename(temp, target);
}

async function runFfmpegToVtt(inputPath: string, streamSelector: string | null, target: string): Promise<{ ok: boolean; stderr: string }> {
  const temp = `${target}.${process.pid}.ffmpeg.vtt`;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', inputPath];
  if (streamSelector) args.push('-map', streamSelector);
  args.push('-f', 'webvtt', temp);
  const result = await runCommand(config.ffmpegPath, args, { lane: 'convert', timeoutMs: 60_000 });
  if (result.code !== 0 || !fs.existsSync(temp)) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* nothing to clean */
    }
    return { ok: false, stderr: (result.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  }
  try {
    const raw = await fs.promises.readFile(temp);
    const decoded = decodeSubtitleBytes(raw);
    if (!decoded.text.trim() || !/^\s*WEBVTT/.test(decoded.text)) {
      throw new Error('ffmpeg produced no WebVTT header');
    }
    await writeAtomic(target, normalizeVtt(decoded.text));
    return { ok: true, stderr: '' };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
}

const conversionJobs = new Map<string, Promise<string>>();

async function convertToVtt(
  media: MediaRow,
  subtitle: SubtitleRow,
  target: string,
  format: string,
  externalPath: string | null,
  isExternal: boolean,
): Promise<string> {
  if (isExternal && externalPath && (format === 'vtt' || path.extname(externalPath).toLowerCase() === '.vtt')) {
    const decoded = decodeSubtitleBytes(await fs.promises.readFile(externalPath));
    await writeAtomic(target, normalizeVtt(decoded.text));
    return target;
  }
  if (isExternal && externalPath && (format === 'srt' || path.extname(externalPath).toLowerCase() === '.srt')) {
    const decoded = decodeSubtitleBytes(await fs.promises.readFile(externalPath));
    await writeAtomic(target, srtToVtt(decoded.text));
    return target;
  }

  if (!(await ffmpegAvailable())) {
    throw new HttpError(503, 'Converting this subtitle needs ffmpeg, which is not installed. External SRT/VTT still work.', 'subtitle_conversion_unavailable', {
      format,
      embedded: !isExternal,
    });
  }

  // Non-UTF-8 ASS/SSA: hand ffmpeg a UTF-8 copy so the dialogue survives.
  let inputPath = externalPath || media.path;
  let tempDecoded: string | null = null;
  if (
    isExternal &&
    externalPath &&
    (format === 'ass' || format === 'ssa' || path.extname(externalPath).toLowerCase() === '.ass' || path.extname(externalPath).toLowerCase() === '.ssa')
  ) {
    const decoded = decodeSubtitleBytes(await fs.promises.readFile(externalPath));
    if (decoded.encoding !== 'utf-8') {
      tempDecoded = `${target}.${process.pid}.src`;
      await fs.promises.writeFile(tempDecoded, decoded.text, 'utf8');
      inputPath = tempDecoded;
    }
  }

  const selector = !isExternal && subtitle.stream_index !== null ? `0:${subtitle.stream_index}` : isExternal ? null : '0:s:0';
  let result: { ok: boolean; stderr: string };
  try {
    result = await runFfmpegToVtt(inputPath, selector, target);
  } finally {
    if (tempDecoded) {
      try {
        fs.unlinkSync(tempDecoded);
      } catch {
        /* best-effort */
      }
    }
  }
  if (!result.ok) {
    throw new HttpError(500, 'Subtitle conversion faceplanted. ffmpeg looked at the file and gave up.', 'subtitle_conversion_failed', {
      stderr: result.stderr || undefined,
    });
  }
  return target;
}

/**
 * Convert one subtitle (embedded or external, SRT/ASS/VTT) to a cached WebVTT file.
 * Fully async, bounded, and de-duplicated: concurrent requests for the same cue file share one job.
 */
export async function ensureSubtitleVttPath(media: MediaRow, subtitle: SubtitleRow): Promise<string> {
  let sourceStat: fs.Stats;
  if (subtitle.is_external === 1) {
    if (!subtitle.path) throw new HttpError(422, 'External subtitle row has no file path. Scanner had one job.', 'invalid_subtitle_path');
    assertSidecarAllowed(media, subtitle.path);
    sourceStat = await fs.promises.stat(subtitle.path);
  } else {
    try {
      sourceStat = await fs.promises.stat(media.path);
    } catch {
      throw new HttpError(410, 'The media file for this embedded subtitle is missing.', 'media_file_missing');
    }
  }
  const target = cacheTarget(media, subtitle, sourceStat);
  try {
    const cached = await fs.promises.stat(target);
    if (cached.isFile() && cached.size > 0) return target;
  } catch {
    /* not cached yet */
  }

  const pending = conversionJobs.get(target);
  if (pending) return pending;

  const format = (subtitle.format || '').toLowerCase();
  const externalPath = subtitle.path;
  const isExternal = subtitle.is_external === 1;
  const job = convertToVtt(media, subtitle, target, format, externalPath, isExternal).finally(() => conversionJobs.delete(target));
  conversionJobs.set(target, job);
  return job;
}
