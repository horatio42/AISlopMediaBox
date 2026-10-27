import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { config } from '../config.ts';
import { getDb, nowISO, settings } from '../db.ts';
import { logger } from '../lib/logger.ts';
import type { ArtKind, MediaKind, MediaRow } from '../types.ts';

export const ART_KINDS: ArtKind[] = ['poster', 'backdrop', 'thumb', 'banner', 'logo', 'art', 'avatar', 'disc'];

export const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function isArtKind(value: string): value is ArtKind {
  return (ART_KINDS as string[]).includes(value);
}

export function imageMime(filePath: string): string {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const SIDECAR_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

function firstExisting(dir: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function sidecarFor(row: MediaRow, kind: ArtKind): string | null {
  const dir = row.kind === 'movie' || row.kind === 'video' || row.kind === 'episode' ? path.dirname(row.path) : row.path;
  const base = row.kind === 'movie' || row.kind === 'video' || row.kind === 'episode' ? row.title : '';
  const names: Record<ArtKind, string[]> = {
    poster: [
      `${base}-poster.jpg`,
      `${base}-poster.png`,
      'poster.jpg',
      'poster.png',
      'folder.jpg',
      'folder.png',
      'cover.jpg',
      'cover.png',
      'movie.jpg',
    ],
    backdrop: ['fanart.jpg', 'fanart.png', 'backdrop.jpg', 'background.jpg', 'art.jpg', `${base}-fanart.jpg`],
    thumb: ['thumb.jpg', 'thumbnail.jpg', `${base}-thumb.jpg`],
    banner: ['banner.jpg', 'banner.png'],
    logo: ['logo.png', 'logo.jpg', 'clearlogo.png'],
    art: ['art.jpg', 'fanart.jpg', 'backdrop.jpg'],
    avatar: ['folder.jpg', 'artist.jpg', 'poster.jpg'],
    disc: ['disc.jpg', 'cdart.png', 'discart.png'],
  };
  const seasonal: Record<ArtKind, string[]> = {
    poster: row.kind === 'season' && row.season_number !== null
      ? [`season${String(row.season_number).padStart(2, '0')}-poster.jpg`, `season${row.season_number}-poster.jpg`, `season ${String(row.season_number).padStart(2, '0')}-poster.jpg`]
      : [],
    backdrop: row.kind === 'season' && row.season_number !== null
      ? [`season${String(row.season_number).padStart(2, '0')}-fanart.jpg`, `season${String(row.season_number).padStart(2, '0')}-backdrop.jpg`]
      : [],
    thumb: [],
    banner: [],
    logo: [],
    art: [],
    avatar: [],
    disc: [],
  };
  const file = firstExisting(dir, [...seasonal[kind], ...names[kind]]);
  if (!file) return null;
  if (!SIDECAR_IMAGE_EXT.includes(path.extname(file).toLowerCase())) return null;
  return file;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 48);
}

function cacheDirFor(mediaId: number): string {
  const dir = path.join(config.imageDir, 'media', String(mediaId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeCachedFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  const imagesRoot = path.resolve(config.imageDir);
  if (!path.resolve(filePath).startsWith(imagesRoot + path.sep)) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    logger.warn('artwork', `Could not remove cached art ${filePath}: ${(error as Error).message}`);
  }
}

interface ArtRowLike {
  media_id: number;
  kind: ArtKind;
  path: string;
  source: string;
}

export function upsertArt(mediaId: number, kind: ArtKind, filePath: string, source: string, width: number | null = null, height: number | null = null): void {
  const db = getDb();
  const previous = db.prepare('SELECT path FROM media_art WHERE media_id = ? AND kind = ?').get(mediaId, kind) as { path: string } | undefined;
  if (previous && path.resolve(previous.path) !== path.resolve(filePath)) removeCachedFile(previous.path);
  db.prepare(
    `INSERT INTO media_art(media_id, kind, path, width, height, source, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(media_id, kind) DO UPDATE SET path = excluded.path, width = excluded.width,
       height = excluded.height, source = excluded.source, created_at = excluded.created_at`,
  ).run(mediaId, kind, filePath, width, height, source, nowISO());
}

function copySidecar(row: MediaRow, kind: ArtKind, sidecar: string): boolean {
  try {
    const ext = path.extname(sidecar).toLowerCase() || '.jpg';
    const destination = path.join(cacheDirFor(row.id), `${safeSegment(kind)}-sidecar${ext}`);
    fs.copyFileSync(sidecar, destination);
    upsertArt(row.id, kind, destination, 'sidecar');
    return true;
  } catch (error) {
    logger.warn('artwork', `Could not copy sidecar ${sidecar}: ${(error as Error).message}`);
    return false;
  }
}

class ArtSemaphore {
  private limit = Math.max(1, Math.min(2, config.scanConcurrency));
  private active = 0;
  private waiters: (() => void)[] = [];

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
      this.waiters.shift()?.();
    }
  }
}

const artLimit = new ArtSemaphore();

function runFfmpeg(args: string[], timeoutMs = 30_000): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let child: ChildProcess;
  try {
    child = spawn(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    resolve(false);
    return promise;
  }
  let stderr = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill('SIGKILL');
    resolve(false);
  }, timeoutMs);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString().slice(0, 2000);
  });
  child.on('error', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(false);
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) logger.debug('artwork', `ffmpeg art pass failed: ${stderr.trim().split('\n')[0] || code}`);
    resolve(code === 0);
  });
  return promise;
}

async function extractFrame(source: string, destination: string, seekSeconds: number | null, width: number): Promise<boolean> {
  const args: string[] = [];
  if (seekSeconds !== null && seekSeconds > 0) args.push('-ss', String(Math.round(seekSeconds * 1000) / 1000));
  args.push('-i', source, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', '-y', destination);
  return artLimit.run(() => runFfmpeg(args));
}

async function extractEmbeddedCover(source: string, destination: string): Promise<boolean> {
  return artLimit.run(() =>
    runFfmpeg(['-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', "scale='min(800,iw)':-2", '-q:v', '3', '-y', destination]),
  );
}

async function generateFor(row: MediaRow, force: boolean): Promise<void> {
  const existing = new Set(
    (getDb().prepare('SELECT kind FROM media_art WHERE media_id = ?').all(row.id) as { kind: ArtKind }[]).map((art) => art.kind),
  );
  const generate = settings.get('generateArt') !== false;
  const wanted: ArtKind[] =
    row.kind === 'movie' || row.kind === 'video'
      ? ['poster', 'backdrop', 'thumb']
      : row.kind === 'episode'
        ? ['thumb']
        : row.kind === 'photo'
          ? ['thumb']
          : row.kind === 'album' || row.kind === 'artist'
            ? ['poster']
            : [];

  const sidecarKinds: ArtKind[] =
    row.kind === 'movie' || row.kind === 'video'
      ? ['poster', 'backdrop', 'thumb', 'banner', 'logo', 'art']
      : row.kind === 'show' || row.kind === 'season'
        ? ['poster', 'backdrop', 'banner', 'logo']
        : row.kind === 'album'
          ? ['poster', 'disc']
          : row.kind === 'artist'
            ? ['poster', 'avatar']
            : row.kind === 'episode'
              ? ['thumb']
              : [];
  for (const kind of sidecarKinds) {
    if (!force && existing.has(kind)) continue;
    const sidecar = sidecarFor(row, kind);
    if (sidecar && copySidecar(row, kind, sidecar)) existing.add(kind);
  }

  for (const kind of wanted) {
    if (!force && existing.has(kind)) continue;
    if (!generate) continue;
    const destination = path.join(cacheDirFor(row.id), `${safeSegment(kind)}-ffmpeg.jpg`);
    let ok = false;
    if (row.kind === 'movie' || row.kind === 'video') {
      if (kind === 'poster') ok = await extractFrame(row.path, destination, row.runtime_seconds ? row.runtime_seconds * 0.1 : 30, 700);
      else if (kind === 'backdrop') ok = await extractFrame(row.path, destination, row.runtime_seconds ? row.runtime_seconds * 0.25 : 60, 1280);
      else ok = await extractFrame(row.path, destination, row.runtime_seconds ? row.runtime_seconds * 0.1 : 30, 480);
    } else if (row.kind === 'episode') {
      ok = await extractFrame(row.path, destination, row.runtime_seconds ? row.runtime_seconds * 0.1 : 20, 480);
    } else if (row.kind === 'photo') {
      ok = await extractFrame(row.path, destination, null, 640);
    } else if (row.kind === 'album' || row.kind === 'artist') {
      const child = getDb()
        .prepare(
          row.kind === 'album'
            ? "SELECT path FROM media WHERE album_id = ? AND kind = 'track' AND hidden = 0 ORDER BY disc_number, track_number, title LIMIT 1"
            : "SELECT path FROM media WHERE artist_id = ? AND kind = 'track' AND hidden = 0 ORDER BY title LIMIT 1",
        )
        .get(row.id) as { path: string } | undefined;
      if (child) ok = await extractEmbeddedCover(child.path, destination);
    }
    if (ok) {
      if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) continue;
      const width = kind === 'backdrop' ? 1280 : kind === 'poster' ? 700 : 480;
      upsertArt(row.id, kind, destination, 'ffmpeg', width);
    }
  }
}

/**
 * Best-effort art for one media row. Shows/seasons/albums derive from the first
 * child that has art, so a poster exists as soon as one episode does.
 */
export async function ensureArtForMedia(mediaId: number, options: { force?: boolean } = {}): Promise<boolean> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId) as MediaRow | undefined;
  if (!row) return false;
  try {
    await generateFor(row, options.force === true);
    await deriveFromChildren(row, options.force === true);
    return true;
  } catch (error) {
    logger.warn('artwork', `Art generation failed for ${mediaId}: ${(error as Error).message}`);
    return false;
  }
}

async function deriveFromChildren(row: MediaRow, force: boolean): Promise<void> {
  const db = getDb();
  const needs: ArtKind[] = row.kind === 'show' ? ['poster', 'backdrop'] : row.kind === 'season' || row.kind === 'album' || row.kind === 'artist' ? ['poster'] : [];
  if (needs.length === 0) return;
  const existing = new Set(
    (db.prepare('SELECT kind FROM media_art WHERE media_id = ?').all(row.id) as { kind: ArtKind }[]).map((art) => art.kind),
  );
  const missing: ArtKind[] = needs.filter((kind) => force || !existing.has(kind));
  if (missing.length === 0) return;

  const children =
    row.kind === 'show'
      ? (db.prepare("SELECT * FROM media WHERE kind = 'season' AND parent_id = ? AND hidden = 0 ORDER BY season_number LIMIT 1").all(row.id) as MediaRow[])
      : row.kind === 'season'
        ? (db.prepare("SELECT * FROM media WHERE kind = 'episode' AND parent_id = ? AND hidden = 0 ORDER BY episode_number LIMIT 1").all(row.id) as MediaRow[])
        : row.kind === 'artist'
          ? (db.prepare("SELECT * FROM media WHERE kind = 'album' AND artist_id = ? AND hidden = 0 ORDER BY year DESC NULLS LAST LIMIT 3").all(row.id) as MediaRow[])
          : [];
  const candidates: MediaRow[] = [];
  for (const child of children) {
    candidates.push(child);
    if (child.kind === 'season') {
      const episodes = db.prepare("SELECT * FROM media WHERE kind = 'episode' AND parent_id = ? AND hidden = 0 ORDER BY episode_number LIMIT 1").all(child.id) as MediaRow[];
      candidates.push(...episodes);
    }
    if (candidates.length >= 3) break;
  }
  const fallbacks: Record<ArtKind, ArtKind[]> = {
    poster: ['poster', 'art', 'thumb'],
    backdrop: ['backdrop', 'art', 'poster', 'thumb'],
    thumb: ['thumb', 'poster'],
    banner: ['banner', 'poster'],
    logo: ['logo', 'poster'],
    art: ['art', 'backdrop', 'poster', 'thumb'],
    avatar: ['avatar', 'poster', 'thumb'],
    disc: ['disc', 'poster'],
  };
  for (const child of candidates) {
    for (const kind of missing) {
      let art: { path: string; source: string } | undefined;
      for (const candidateKind of fallbacks[kind]) {
        art = db.prepare('SELECT path, source FROM media_art WHERE media_id = ? AND kind = ?').get(child.id, candidateKind) as { path: string; source: string } | undefined;
        if (art) break;
      }
      if (!art) continue;
      try {
        if (!fs.statSync(art.path).isFile()) continue;
        const ext = path.extname(art.path).toLowerCase();
        const destination = path.join(cacheDirFor(row.id), `${safeSegment(kind)}-derived${ext}`);
        fs.copyFileSync(art.path, destination);
        upsertArt(row.id, kind, destination, `derived:${art.source}`);
      } catch (error) {
        logger.debug('artwork', `derive art failed: ${(error as Error).message}`);
      }
    }
  }
}

export interface UploadedArtResult {
  kind: ArtKind;
  path: string;
  source: string;
  bytes: number;
}

export function saveUploadedArt(mediaId: number, kind: ArtKind, data: Buffer, mime: string): UploadedArtResult {
  if (data.length === 0) throw new Error('Empty image body');
  if (data.length > 20 * 1024 * 1024) throw new Error('Image too large (20MB max)');
  const ext = Object.entries(IMAGE_MIME).find(([, value]) => value === mime)?.[0] || '.jpg';
  const destination = path.join(cacheDirFor(mediaId), `${safeSegment(kind)}-upload${ext}`);
  fs.writeFileSync(destination, data);
  upsertArt(mediaId, kind, destination, 'upload');
  return { kind, path: destination, source: 'upload', bytes: data.length };
}

export function deleteArt(mediaId: number, kind?: ArtKind): boolean {
  const db = getDb();
  const rows = kind
    ? (db.prepare('SELECT media_id, kind, path, source FROM media_art WHERE media_id = ? AND kind = ?').all(mediaId, kind) as ArtRowLike[])
    : (db.prepare('SELECT media_id, kind, path, source FROM media_art WHERE media_id = ?').all(mediaId) as ArtRowLike[]);
  if (rows.length === 0) return false;
  const del = db.prepare('DELETE FROM media_art WHERE media_id = ? AND kind = ?');
  for (const row of rows) {
    del.run(row.media_id, row.kind);
    removeCachedFile(row.path);
  }
  return true;
}

/** Remove every cached art file + row for a media id (used by DELETE /media/:id?hard). */
export function purgeArtForMedia(mediaId: number): void {
  deleteArt(mediaId);
  const dir = path.resolve(config.imageDir, 'media', String(mediaId));
  if (!dir.startsWith(path.resolve(config.imageDir) + path.sep)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('artwork', `Could not purge art dir ${dir}: ${(error as Error).message}`);
  }
}

export function purgeArtForLibrary(libraryId: number): number {
  const ids = getDb().prepare('SELECT id FROM media WHERE library_id = ?').all(libraryId) as { id: number }[];
  for (const { id } of ids) purgeArtForMedia(id);
  return ids.length;
}

const REMOTE_ART_HOSTS: Record<string, string> = {
  'image.tmdb.org': 'tmdb',
  'artworks.thetvdb.com': 'tvdb',
  'static.tvmaze.com': 'tvmaze',
  'm.media-amazon.com': 'imdb',
};

/**
 * Download a provider image into cache. Only exact allowlisted hosts are accepted:
 * image.tmdb.org, artworks.thetvdb.com, static.tvmaze.com, m.media-amazon.com.
 * `provider` is an optional hint so OMDb/IMDb art keeps its true source.
 */
export async function downloadRemoteArt(mediaId: number, kind: ArtKind, url: string, provider?: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostProvider = REMOTE_ART_HOSTS[parsed.hostname];
  if (parsed.protocol !== 'https:' || !hostProvider) {
    logger.warn('artwork', `Refusing art URL host: ${parsed.hostname}`);
    return false;
  }
  const source = provider === 'omdb' && parsed.hostname === 'm.media-amazon.com' ? 'omdb' : hostProvider;
  try {
    const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return false;
    const finalUrl = response.url || parsed.toString();
    let finalHost: string;
    try {
      finalHost = new URL(finalUrl).hostname;
    } catch {
      return false;
    }
    if (!REMOTE_ART_HOSTS[finalHost]) {
      logger.warn('artwork', `Refusing redirected art host: ${finalHost}`);
      return false;
    }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!type.startsWith('image/')) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return false;
    if (buffer.length > 20 * 1024 * 1024) return false;
    const ext = Object.entries(IMAGE_MIME).find(([, value]) => value === type)?.[0] || '.jpg';
    const destination = path.join(cacheDirFor(mediaId), `${safeSegment(kind)}-${safeSegment(source)}${ext}`);
    fs.writeFileSync(destination, buffer);
    upsertArt(mediaId, kind, destination, source);
    return true;
  } catch (error) {
    logger.warn('artwork', `Remote art download failed: ${(error as Error).message}`);
    return false;
  }
}

/** Meme-styled deterministic SVG used when a media row has no art at all. */
export function placeholderSvg(row: MediaRow, kind: ArtKind): string {
  const hue = (row.id * 47 + 260) % 360;
  const palette = ['#c8ff3d', '#ff4d9d', '#7b5cff', '#3ddcff'];
  const accent = palette[row.id % palette.length];
  const title = row.title.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char] || '');
  const label = row.kind === 'show' ? 'SHOW' : row.kind === 'movie' ? 'MOVIE' : row.kind === 'album' ? 'ALBUM' : row.kind === 'artist' ? 'ARTIST' : row.kind === 'photo' ? 'PHOTO' : row.kind.toUpperCase();
  const subtitles = ['no poster, only vibes', 'art pending, aura immense', 'certified artless', 'pixels loading', 'skill issue: no art'];
  const quip = subtitles[row.id % subtitles.length];
  const wide = kind === 'backdrop' || kind === 'banner';
  const width = wide ? 1280 : 600;
  const height = wide ? 720 : 900;
  const fontSize = Math.max(28, Math.min(72, Math.floor(1200 / Math.max(8, title.length))));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} placeholder art">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 45%, 12%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 70) % 360}, 55%, 22%)"/>
    </linearGradient>
    <pattern id="grain" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="3" cy="3" r="1.4" fill="${accent}" opacity="0.16"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#grain)"/>
  <circle cx="${width * 0.84}" cy="${height * 0.16}" r="${width * 0.16}" fill="${accent}" opacity="0.12"/>
  <text x="48" y="72" fill="${accent}" font-family="ui-monospace, monospace" font-size="22" letter-spacing="4">${label} // AISLOP</text>
  <text x="48" y="${height / 2}" fill="#f6f3ff" font-family="system-ui, sans-serif" font-weight="800" font-size="${fontSize}">
    ${title.length > 42 ? title.slice(0, 39) + '…' : title}
  </text>
  <text x="48" y="${height / 2 + 56}" fill="${accent}" font-family="ui-monospace, monospace" font-size="20">${quip}</text>
  <rect x="48" y="${height - 96}" width="${Math.min(320, width - 96)}" height="4" fill="${accent}"/>
  <text x="48" y="${height - 56}" fill="#b9b2c9" font-family="ui-monospace, monospace" font-size="16">touch grass · watch slop · repeat</text>
</svg>`;
}

/** Cheap parent-art derivation for request paths (no ffmpeg work). */
export async function ensureDerivedArtForMedia(mediaId: number): Promise<boolean> {
  const row = getDb().prepare('SELECT * FROM media WHERE id = ?').get(mediaId) as MediaRow | undefined;
  if (!row) return false;
  if (row.kind !== 'show' && row.kind !== 'season' && row.kind !== 'album' && row.kind !== 'artist') return false;
  try {
    await deriveFromChildren(row, false);
    return true;
  } catch (error) {
    logger.debug('artwork', `derive-on-read failed for ${mediaId}: ${(error as Error).message}`);
    return false;
  }
}
