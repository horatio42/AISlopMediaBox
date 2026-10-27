import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'slop123';
/** Default login password for accounts created by helpers. */
export const USER_PASSWORD = 'userpass123';

export interface StartedServer {
  baseUrl: string;
  dataDir: string;
  mediaDir: string;
  port: number;
  child: ChildProcess;
  /** Captured stdout+stderr, useful when a startup assertion fails. */
  logs: () => string;
  stop: () => Promise<void>;
}

export interface LoginResponse {
  ok?: boolean;
  user?: { id?: number; username?: string; role?: string; hasPin?: boolean };
  error?: { code?: string; message?: string; details?: unknown };
}

export interface Job {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  result: unknown;
  error?: string | null;
  payload: Record<string, unknown>;
}

export interface Library {
  id: number;
  name: string;
  kind: string;
  path: string;
  scan_schedule: string;
  lastScanAt: string | null;
  itemCount: number;
  totalBytes: number;
  exists: boolean;
  settings: Record<string, unknown>;
}

export interface ScanResult {
  libraryId: number;
  libraryName: string;
  status: 'done' | 'cancelled' | 'error';
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  hidden: number;
  errors: string[];
  counts: Record<string, number>;
  totalBytes: number;
  durationMs: number;
}

export interface ScanOutcome {
  job: Job;
  scan: ScanResult;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: Buffer;
  text: string;
  json: T | null;
  contentType: string;
}

export interface RequestOptions {
  json?: unknown;
  body?: string | Buffer;
  headers?: Record<string, string>;
  timeoutMs?: number;
  followRedirects?: boolean;
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => {
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not allocate a test port'));
    });
  });
  return promise;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    resolve(false);
  }, timeoutMs);
  timer.unref();
  child.once('exit', () => {
    clearTimeout(timer);
    resolve(true);
  });
  return promise;
}

/**
 * Spawn the real server against an isolated DATA_DIR/MEDIA_DIR and wait until it is
 * genuinely ready. The extra wait past boot covers the scanner's 1.5s boot timer so
 * libraries created by a test are not auto-scanned by startup automation.
 */
export async function startServer(): Promise<StartedServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-test-'));
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      MEDIA_DIR: mediaDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_USER,
      ADMIN_PASSWORD,
      LOG_LEVEL: 'warn',
      TMDB_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer): void => {
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  let startedAt: number | null = null;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during startup:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const health = (await response.json()) as { startedAt?: unknown };
        startedAt = typeof health.startedAt === 'number' ? health.startedAt : Date.now();
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(60);
  }
  if (startedAt === null) {
    child.kill('SIGKILL');
    throw new Error(`server did not become healthy in time:\n${output}`);
  }
  await sleep(Math.max(0, startedAt + 2300 - Date.now()));

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      if (!(await waitForExit(child, 5000))) {
        child.kill('SIGKILL');
        await waitForExit(child, 2000);
      }
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  };

  return { baseUrl, dataDir, mediaDir, port, child, logs: () => output, stop };
}

/** Tiny cookie-jar client. Every instance is an independent browser profile. */
export class Client {
  readonly baseUrl: string;
  readonly label: string;
  readonly cookies = new Map<string, string>();
  userId: number | null = null;

  constructor(baseUrl: string, label = 'client') {
    this.baseUrl = baseUrl;
    this.label = label;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  private captureCookies(response: Response): void {
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair, ...attributes] = raw.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request<T = unknown>(method: string, apiPath: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    assert.ok(apiPath.startsWith('/'), `request path must start with /: ${apiPath}`);
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (this.cookies.size > 0 && !('Cookie' in headers)) headers.Cookie = this.cookieHeader();
    let body: string | Buffer | undefined = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    const response = await fetch(`${this.baseUrl}${apiPath}`, {
      method,
      headers,
      body,
      redirect: options.followRedirects ? 'follow' : 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    this.captureCookies(response);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    const contentType = response.headers.get('content-type') || '';
    let parsed: unknown = null;
    if (contentType.includes('json') && text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === 'object' && 'user' in parsed) {
      const user = parsed.user;
      if (user && typeof user === 'object' && 'id' in user && typeof user.id === 'number') this.userId = user.id;
    }
    return {
      status: response.status,
      headers: response.headers,
      body: buffer,
      text,
      json: parsed as T | null,
      contentType,
    };
  }

  get<T = unknown>(apiPath: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('GET', apiPath, options);
  }

  head<T = unknown>(apiPath: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('HEAD', apiPath, options);
  }

  post<T = unknown>(apiPath: string, json?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', apiPath, json === undefined ? options : { ...options, json });
  }

  put<T = unknown>(apiPath: string, json?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', apiPath, json === undefined ? options : { ...options, json });
  }

  patch<T = unknown>(apiPath: string, json?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', apiPath, json === undefined ? options : { ...options, json });
  }

  del<T = unknown>(apiPath: string, json?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', apiPath, json === undefined ? options : { ...options, json });
  }

  async login(username: string, password: string, pin?: string): Promise<ApiResponse<LoginResponse>> {
    const payload: Record<string, unknown> = { username, password };
    if (pin !== undefined) payload.pin = pin;
    return this.post<LoginResponse>('/api/auth/login', payload);
  }

  async loginOk(username: string, password: string, pin?: string): Promise<ApiResponse<LoginResponse>> {
    const response = await this.login(username, password, pin);
    assert.equal(response.status, 200, `${username} login failed: ${response.text}`);
    assert.equal(response.json?.ok, true);
    const user = response.json?.user;
    if (user && typeof user.id === 'number') this.userId = user.id;
    return response;
  }
}

/** Admin client, already logged in. */
export async function adminClient(server: StartedServer): Promise<Client> {
  const client = new Client(server.baseUrl, 'admin');
  await client.loginOk(ADMIN_USER, ADMIN_PASSWORD);
  return client;
}

export async function newUserClient(
  server: StartedServer,
  admin: Client,
  username: string,
  role: 'user' | 'manager' | 'admin' = 'user',
  password = USER_PASSWORD,
): Promise<Client> {
  const created = await admin.post('/api/admin/users', { username, password, role, displayName: `${username} display` });
  assert.equal(created.status, 201, `could not create ${username}: ${created.text}`);
  const client = new Client(server.baseUrl, username);
  await client.loginOk(username, password);
  return client;
}

export async function pollJob(client: Client, jobId: string, timeoutMs = 90_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  let last: Job | null = null;
  while (Date.now() < deadline) {
    const response = await client.get<Job>(`/api/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200, `job poll failed: ${response.text}`);
    last = response.json;
    if (last && (last.status === 'done' || last.status === 'error' || last.status === 'cancelled')) return last;
    await sleep(100);
  }
  throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
}

/** Create a library through the API and return its DTO. */
export async function createLibrary(
  client: Client,
  input: { name: string; kind: 'movies' | 'shows' | 'music' | 'photos' | 'mixed'; path: string; scanSchedule?: string; settings?: Record<string, unknown> },
): Promise<Library> {
  const response = await client.post<Library>('/api/libraries', { scanSchedule: 'manual', ...input });
  assert.equal(response.status, 201, `library create failed: ${response.text}`);
  assert.ok(response.json, 'library response was not JSON');
  return response.json;
}

/** Queue a scan, wait for the job, and return both the job and its per-library result. */
export async function scanLibrary(client: Client, libraryId: number): Promise<ScanOutcome> {
  const response = await client.post<{ jobId: string }>(`/api/libraries/${libraryId}/scan`);
  assert.equal(response.status, 202, `scan trigger failed: ${response.text}`);
  assert.ok(response.json?.jobId, 'scan response had no jobId');
  const job = await pollJob(client, response.json.jobId);
  assert.equal(job.status, 'done', `scan job failed: ${job.error || job.message}`);
  const result = job.result as { ok?: boolean; libraries?: ScanResult[]; skipped?: unknown[] } | null;
  const scan = result?.libraries?.find((entry) => entry.libraryId === libraryId) ?? result?.libraries?.[0];
  assert.ok(scan, `scan job returned no library result: ${JSON.stringify(job.result)}`);
  return { job, scan };
}

/* -------------------------------------------------------------------------- */
/* Fixture generators (tiny, deterministic, ffmpeg-native)                    */
/* -------------------------------------------------------------------------- */

export function ffmpeg(args: string[]): void {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(`ffmpeg fixture failed: ${stderr || (error as Error).message}`);
  }
}

export interface VideoOptions {
  duration?: number;
  size?: string;
  rate?: number;
  /** ffmpeg video encoder, e.g. libx264 */
  videoCodec?: string;
  audio?: boolean;
  audioCodec?: string;
}

/** H.264 + AAC MP4 by default. File extension decides the container. */
export function makeVideo(filePath: string, options: VideoOptions = {}): string {
  const { duration = 2, size = '160x120', rate = 15, videoCodec = 'libx264', audio = true, audioCodec = 'aac' } = options;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', String(duration), '-c:v', videoCodec);
  if (videoCodec === 'libx264') args.push('-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', audioCodec, '-b:a', '64k');
  args.push('-map_metadata', '-1', filePath);
  ffmpeg(args);
  return filePath;
}

export function makeAudioTrack(
  filePath: string,
  metadata: { title?: string; genre?: string; track?: number; duration?: number } = {},
): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const duration = metadata.duration ?? 1.2;
  const args = [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${duration}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
  ];
  if (metadata.title) args.push('-metadata', `title=${metadata.title}`);
  if (metadata.genre) args.push('-metadata', `genre=${metadata.genre}`);
  if (metadata.track !== undefined) args.push('-metadata', `track=${metadata.track}`);
  args.push('-id3v2_version', '3', filePath);
  ffmpeg(args);
  return filePath;
}

export function makeImage(filePath: string, color = '0x3366cc', size = '48x32'): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', '-q:v', '4', filePath]);
  return filePath;
}

export function writeFile(filePath: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

export interface NfoOptions {
  title?: string;
  year?: number;
  plot?: string;
  tagline?: string;
  rating?: number;
  mpaa?: string;
  runtimeMinutes?: number;
  genres?: string[];
  tags?: string[];
  people?: { name: string; role?: 'actor' | 'director' | 'writer'; character?: string }[];
}

/** Minimal Kodi-style NFO. */
export function writeNfo(filePath: string, kind: 'movie' | 'tvshow' | 'episode', options: NfoOptions = {}): string {
  const root = kind === 'movie' ? 'movie' : kind === 'episode' ? 'episodedetails' : 'tvshow';
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<${root}>`];
  if (options.title) lines.push(`  <title>${escapeXml(options.title)}</title>`);
  if (options.year !== undefined) lines.push(`  <year>${options.year}</year>`);
  if (options.plot) lines.push(`  <plot>${escapeXml(options.plot)}</plot>`);
  if (options.tagline) lines.push(`  <tagline>${escapeXml(options.tagline)}</tagline>`);
  if (options.rating !== undefined) lines.push(`  <rating>${options.rating}</rating>`);
  if (options.mpaa) lines.push(`  <mpaa>${escapeXml(options.mpaa)}</mpaa>`);
  if (options.runtimeMinutes !== undefined) lines.push(`  <runtime>${options.runtimeMinutes}</runtime>`);
  for (const genre of options.genres ?? []) lines.push(`  <genre>${escapeXml(genre)}</genre>`);
  for (const tag of options.tags ?? []) lines.push(`  <tag>${escapeXml(tag)}</tag>`);
  for (const person of options.people ?? []) {
    if (person.role === 'director') lines.push(`  <director>${escapeXml(person.name)}</director>`);
    else if (person.role === 'writer') lines.push(`  <writer>${escapeXml(person.name)}</writer>`);
    else {
      lines.push('  <actor>', `    <name>${escapeXml(person.name)}</name>`, `    <role>${escapeXml(person.character ?? '')}</role>`, '  </actor>');
    }
  }
  lines.push(`</${root}>`, '');
  return writeFile(filePath, lines.join('\n'));
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function writeSrt(filePath: string, cues: { start: string; end: string; text: string }[]): string {
  const body = cues
    .map((cue, index) => `${index + 1}\n${cue.start} --> ${cue.end}\n${cue.text}`)
    .join('\n\n');
  return writeFile(filePath, `${body}\n`);
}

/** A simple SRT fixture with two cues. */
export function makeSrt(filePath: string): string {
  return writeSrt(filePath, [
    { start: '00:00:00,500', end: '00:00:01,200', text: 'First slop line' },
    { start: '00:00:01,300', end: '00:00:01,900', text: 'Second slop line' },
  ]);
}

/** Example NFO for a movie library fixture. */
export function movieNfo(dir: string, options: NfoOptions = {}): string {
  return writeNfo(path.join(dir, 'movie.nfo'), 'movie', options);
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export { assert, sleep };
