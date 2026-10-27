import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from './types.ts';

const env = process.env;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function zeroable(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const dataDir = path.resolve(env.DATA_DIR || 'data');
const mediaDir = path.resolve(env.MEDIA_DIR || path.join(dataDir, 'media'));

export const config: AppConfig = {
  version: env.APP_VERSION || '1.0.0',
  env: env.NODE_ENV || 'development',
  port: num(env.PORT, 3100),
  host: env.HOST || '0.0.0.0',
  dataDir,
  mediaDir,
  dbPath: path.join(dataDir, 'aislop.db'),
  cacheDir: path.join(dataDir, 'cache'),
  imageDir: path.join(dataDir, 'cache', 'images'),
  transcodeDir: path.join(dataDir, 'cache', 'transcode'),
  tempDir: path.join(dataDir, 'cache', 'temp'),
  logDir: path.join(dataDir, 'cache', 'logs'),
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || 'slop123',
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: env.FFPROBE_PATH || 'ffprobe',
  tmdbApiKey: env.TMDB_API_KEY || '',
  tvdbApiKey: env.TVDB_API_KEY || '',
  omdbApiKey: env.OMDB_API_KEY || '',
  defaultLanguage: env.DEFAULT_LANGUAGE || 'en',
  maxTranscodeHeight: num(env.MAX_TRANSCODE_HEIGHT, 1080),
  transcodePreset: env.TRANSCODE_PRESET || 'veryfast',
  transcodeConcurrency: num(env.TRANSCODE_CONCURRENCY, 2),
  transcodeHwAccel: env.TRANSCODE_HWACCEL || 'auto',
  transcodeHwAccelDevice: env.TRANSCODE_HWACCEL_DEVICE || env.TRANSCODE_VAAPI_DEVICE || '',
  transcodeThrottleSeconds: zeroable(env.TRANSCODE_THROTTLE_SECONDS, 120),
  hlsSegmentSeconds: num(env.HLS_SEGMENT_SECONDS, 4),
  scanConcurrency: num(env.SCAN_CONCURRENCY, 4),
  sessionDays: num(env.SESSION_DAYS, 30),
  secureCookies: bool(env.SECURE_COOKIES, false),
  trustProxy: bool(env.TRUST_PROXY, false),
  demoMode: bool(env.DEMO_MODE, false),
};

export const paths = {
  data: dataDir,
  media: mediaDir,
  db: config.dbPath,
  cache: config.cacheDir,
  images: config.imageDir,
  transcode: config.transcodeDir,
  temp: config.tempDir,
  logs: config.logDir,
  public: path.resolve(import.meta.dirname, '..', 'public'),
  schema: path.resolve(import.meta.dirname, 'db', 'schema.sql'),
} as const;

/** Create every persistent directory up front. Everything lives under DATA_DIR. */
export function ensureDataDirs(): void {
  for (const dir of [paths.data, paths.media, paths.cache, paths.images, paths.transcode, paths.temp, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(paths.images, 'generated'), { recursive: true });
  fs.mkdirSync(path.join(paths.cache, 'subtitles'), { recursive: true });
  // Drop folders. Host users see these under ./data/ingest when using the compose bind mount.
  for (const kind of ['movies', 'tv', 'music', 'photos']) {
    fs.mkdirSync(path.join(paths.data, 'ingest', kind), { recursive: true });
  }
}

export function isProduction(): boolean {
  return config.env === 'production';
}
