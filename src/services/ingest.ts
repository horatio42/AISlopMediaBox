import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.ts';
import { getDb, nowISO, settings } from '../db.ts';
import { bus, logger } from '../lib/logger.ts';
import type {
  IngestAction,
  IngestCandidateDTO,
  IngestItemDTO,
  IngestItemRow,
  IngestKind,
  IngestSourceDTO,
  IngestSourceRow,
  IngestSourceStats,
  IngestStatus,
  LibraryRow,
  JobDTO,
  MediaRow,
} from '../types.ts';
import { getMediaDTO } from '../lib/dto.ts';
import { jobQueue } from './jobs.ts';
import type { JobContext } from './jobs.ts';
import {
  applyEnrichment,
  discoverExternalSubtitles,
  enqueueScan,
  findActiveScanJob,
  scanLibrary,
} from './scanner.ts';
import type { Enrichment } from './scanner.ts';
import {
  findNfo,
  parseEpisodeFilename,
  parseMovieFilename,
  parseSeasonFolder,
  parseTrackFilename,
  stripExtension,
} from './metadata.ts';
import type { NfoLookup } from './metadata.ts';
import { downloadRemoteArt, ensureArtForMedia } from './artwork.ts';
import { providerStatuses, resolveProvider, searchProviders } from './providers.ts';
import type { ProviderCandidate, ProviderResolved, ProviderStatus } from './providers.ts';

export const INGEST_LIMITS = {
  maxNewItemsPerPass: 2000,
  maxCandidates: 8,
  maxWalkEntries: 50_000,
  maxSidecars: 40,
  maxSegmentLength: 120,
  autoCreateLibrarySchedule: 'daily',
} as const;

const VIDEO_EXT: Record<string, true> = Object.fromEntries(
  ['mkv', 'mp4', 'm4v', 'avi', 'webm', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts'].map((ext) => [ext, true as const]),
);
const AUDIO_EXT: Record<string, true> = Object.fromEntries(
  ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'alac', 'aiff', 'aif'].map((ext) => [ext, true as const]),
);
const IMAGE_EXT: Record<string, true> = Object.fromEntries(
  ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'].map((ext) => [ext, true as const]),
);
const SUBTITLE_EXT: Record<string, true> = Object.fromEntries(
  ['srt', 'vtt', 'ass', 'ssa'].map((ext) => [ext, true as const]),
);
const ART_NAMES: Record<string, true> = Object.fromEntries(
  ['poster', 'folder', 'cover', 'fanart', 'backdrop', 'background', 'thumb', 'banner', 'logo', 'disc', 'discart'].map((name) => [name, true as const]),
);
const ART_EXT: Record<string, true> = Object.fromEntries(['jpg', 'jpeg', 'png', 'webp', 'avif'].map((ext) => [ext, true as const]));
const INGEST_KINDS: IngestKind[] = ['movies', 'shows', 'music', 'photos'];
const INGEST_ACTIONS: IngestAction[] = ['move', 'copy', 'hardlink', 'symlink'];
const INGEST_STATUSES: IngestStatus[] = ['pending', 'review', 'organized', 'error', 'ignored'];

export interface IngestResolution {
  title?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  provider?: string | null;
  providerId?: string | null;
  confidence?: number | null;
  enrichment?: Enrichment | null;
  candidates?: ProviderCandidate[] | IngestCandidateDTO[] | null;
}

export interface DestFields {
  title: string;
  year?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
  artist?: string | null;
  album?: string | null;
  trackNumber?: number | null;
  originalName?: string | null;
  mtimeMs?: number | null;
}

export interface ProcessOptions {
  triggerScan?: boolean;
}

function one<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

export function sourceKindExtensions(kind: IngestKind): Record<string, true> {
  if (kind === 'movies' || kind === 'shows') return VIDEO_EXT;
  if (kind === 'music') return AUDIO_EXT;
  return IMAGE_EXT;
}

/* Bounded NFO lookup cache: shared show NFOs move with the first episode, so later
 * items in the same batch must still see the metadata they were discovered with. */
const NFO_CACHE_MAX = 256;
const NFO_CACHE_TTL_MS = 5 * 60_000;
const nfoCache = new Map<string, { at: number; value: NfoLookup | null }>();

function cachedFindNfo(target: string, kind: 'movie' | 'show' | 'episode'): NfoLookup | null {
  const key = `${kind}\u0000${target}`;
  const hit = nfoCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < NFO_CACHE_TTL_MS) return hit.value;
  const value = findNfo(target, kind);
  if (nfoCache.size >= NFO_CACHE_MAX) {
    const oldest = nfoCache.keys().next();
    if (!oldest.done) nfoCache.delete(oldest.value);
  }
  nfoCache.set(key, { at: now, value });
  return value;
}

function clearNfoCache(): void {
  nfoCache.clear();
}

/** One safe filesystem segment: no separators, controls, NUL; trimmed; length-capped. */
export function sanitizeSegment(value: string, fallback = 'Untitled'): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!cleaned) return fallback;
  return cleaned.slice(0, INGEST_LIMITS.maxSegmentLength).replace(/[.\s]+$/g, '') || fallback;
}

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Destination path escaped the library root');
  }
  return target;
}

function yearSuffix(year: number | null | undefined): string {
  return year ? ` (${year})` : '';
}

function padNumber(value: number | null | undefined, width = 2): string {
  return String(Math.max(0, Math.trunc(value ?? 0))).padStart(width, '0');
}

function yearInName(value: string): number | null {
  const match = value.match(/(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
}

function photoYear(fields: DestFields): number {
  const nameYear = yearInName(fields.originalName || fields.title);
  if (nameYear) return nameYear;
  if (fields.year) return fields.year;
  if (fields.mtimeMs && Number.isFinite(fields.mtimeMs)) return new Date(fields.mtimeMs).getUTCFullYear();
  return new Date().getUTCFullYear();
}

/** Canonical destination for an ingest item. Pure naming helper; no filesystem writes. */
export function destPathFor(kind: IngestKind, root: string, fields: DestFields): string {
  const originalName = fields.originalName ? path.basename(fields.originalName) : null;
  const ext = originalName ? path.extname(originalName) : '';
  if (kind === 'movies') {
    const title = sanitizeSegment(fields.title || 'Untitled');
    const folder = `${title}${yearSuffix(fields.year)}`;
    return safeJoin(root, folder, `${folder}${ext || '.mkv'}`);
  }
  if (kind === 'shows') {
    const show = sanitizeSegment(fields.title || 'Untitled Show');
    const season = Math.max(0, Math.trunc(fields.seasonNumber ?? 1));
    const episode = Math.max(0, Math.trunc(fields.episodeNumber ?? 0));
    const episodeTitle = sanitizeSegment(fields.episodeTitle || `Episode ${episode}`, `Episode ${episode}`);
    const fileName = sanitizeSegment(`${show} - S${padNumber(season)}E${padNumber(episode)} - ${episodeTitle}`, show) + (ext || '.mkv');
    return safeJoin(root, show, `Season ${padNumber(season)}`, fileName);
  }
  if (kind === 'music') {
    const artist = sanitizeSegment(fields.artist || 'Unknown Artist');
    const album = sanitizeSegment(fields.album || 'Unknown Album');
    const trackNumber = fields.trackNumber ? `${padNumber(fields.trackNumber)} - ` : '';
    const title = sanitizeSegment(fields.title || 'Untitled Track');
    return safeJoin(root, artist, album, sanitizeSegment(`${trackNumber}${title}`, 'Untitled Track') + (ext || '.mp3'));
  }
  const year = photoYear(fields);
  const photoExt = originalName ? path.extname(originalName) : '';
  const name = sanitizeSegment(originalName ? stripExtension(originalName) : fields.title || 'photo', 'photo') + photoExt;
  return safeJoin(root, String(year), name);
}

export function destStem(dest: string): string {
  return stripExtension(path.basename(dest));
}

/** Append ` (2)`, ` (3)`, ... before the extension until the path is free. */
function uniquePath(candidate: string): string {
  if (!fs.existsSync(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const base = path.basename(candidate, ext);
  for (let index = 2; index < 1000; index += 1) {
    const next = path.join(dir, `${base} (${index})${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  throw new Error(`Could not find a free destination name for ${path.basename(candidate)}`);
}

/* ------------------------------------------------------------------ */
/* Sources + destination libraries                                     */
/* ------------------------------------------------------------------ */

export function getSourceRow(id: number): IngestSourceRow | undefined {
  return getDb().prepare('SELECT * FROM ingest_sources WHERE id = ?').get(id) as IngestSourceRow | undefined;
}

function requireSource(id: number): IngestSourceRow {
  const row = getSourceRow(id);
  if (!row) throw ingestError(`Ingest source ${id} does not exist`, 'not_found');
  return row;
}

function libraryMatchesKind(library: LibraryRow, kind: IngestKind): boolean {
  if (kind === 'shows') return library.kind === 'shows';
  return library.kind === kind || library.kind === 'mixed';
}

/** Resolve symlinks when possible so loop checks cannot be bypassed by a link. */
function canonicalPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function autoLibraryPath(kind: IngestKind): string {
  return path.join(paths.media, `ingested-${kind}`);
}

function autoLibraryName(kind: IngestKind): string {
  const labels: Record<IngestKind, string> = { movies: 'Ingested Movies', shows: 'Ingested Shows', music: 'Ingested Music', photos: 'Ingested Photos' };
  return labels[kind];
}

/** Resolve the destination library, creating `<mediaDir>/ingested-<kind>` when needed. */
export function destinationLibrary(source: IngestSourceRow): LibraryRow {
  const db = getDb();
  if (source.library_id !== null && source.library_id !== undefined) {
    const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(source.library_id) as LibraryRow | undefined;
    if (row && libraryMatchesKind(row, source.kind)) return row;
    if (row) throw new Error(`Source library #${row.id} kind "${row.kind}" cannot hold ${source.kind}`);
  }
  const existing = db.prepare('SELECT * FROM libraries WHERE kind = ? ORDER BY id LIMIT 1').get(source.kind) as LibraryRow | undefined;
  if (existing) return existing;
  const libraryPath = autoLibraryPath(source.kind);
  const found = db.prepare('SELECT * FROM libraries WHERE path = ?').get(libraryPath) as LibraryRow | undefined;
  if (found) return found;
  fs.mkdirSync(libraryPath, { recursive: true });
  const timestamp = nowISO();
  const info = db
    .prepare(
      `INSERT INTO libraries(name, kind, path, scan_schedule, settings, created_at, updated_at)
       VALUES(?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(autoLibraryName(source.kind), source.kind, libraryPath, INGEST_LIMITS.autoCreateLibrarySchedule, timestamp, timestamp);
  const created = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(info.lastInsertRowid)) as LibraryRow;
  logger.info('ingest', `Created destination library "${created.name}"`, { libraryId: created.id, path: created.path });
  bus.publish('library.changed', { libraryId: created.id, created: true });
  return created;
}

function isInside(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

/** Reject source/destination trees that contain each other (ingest loops). */
export function assertNoLoop(sourcePath: string, libraryPath: string): void {
  const sources = [path.resolve(sourcePath), canonicalPath(sourcePath)];
  const libraries = [path.resolve(libraryPath), canonicalPath(libraryPath)];
  for (const source of sources) {
    for (const library of libraries) {
      if (isInside(source, library) || isInside(library, source)) {
        throw new Error('Source and destination library must not contain each other');
      }
    }
  }
}

export function ensureDefaultSources(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM ingest_sources').get() as { n: number }).n;
  if (count > 0) return;
  const definitions: { kind: IngestKind; name: string; folder: string }[] = [
    { kind: 'movies', name: 'Drop Movies', folder: 'movies' },
    { kind: 'shows', name: 'Drop TV', folder: 'tv' },
    { kind: 'music', name: 'Drop Music', folder: 'music' },
    { kind: 'photos', name: 'Drop Photos', folder: 'photos' },
  ];
  const timestamp = nowISO();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ingest_sources(name, kind, path, library_id, action, auto_match, min_confidence, hold_unmatched, recursive, settle_seconds, enabled, settings, created_at, updated_at)
     VALUES(?, ?, ?, NULL, 'move', 1, 0.5, 1, 1, 15, 1, '{}', ?, ?)`,
  );
  for (const definition of definitions) {
    const dir = path.join(paths.data, 'ingest', definition.folder);
    fs.mkdirSync(dir, { recursive: true });
    insert.run(definition.name, definition.kind, dir, timestamp, timestamp);
  }
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

interface ParsedItem {
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
}

const SHOW_MARKER = /(?:^|[.\s_-])(?:s\d{1,3}[.\s_-]*e\d{1,4}|\d{1,3}x\d{1,4}|season[.\s_-]*\d{1,3}[.\s_-]*episode[.\s_-]*\d{1,4})/i;

function showTitleFromName(name: string): string | null {
  const base = stripExtension(name).replace(/_/g, ' ').trim();
  const marker = base.match(SHOW_MARKER);
  const before = marker && marker.index !== undefined ? base.slice(0, marker.index) : '';
  const cleaned = parseMovieFilename(`${before}.apply`).title;
  if (cleaned && cleaned !== 'Untitled slop' && cleaned !== 'Apply') return cleaned;
  return null;
}

function showFolderFor(filePath: string, sourceRoot: string): string | null {
  let dir = path.dirname(filePath);
  if (dir === sourceRoot) return null;
  const parsed = parseSeasonFolder(path.basename(dir));
  if (parsed.season !== null) {
    const parent = path.dirname(dir);
    if (parent !== sourceRoot && isInside(parent, sourceRoot)) dir = parent;
  }
  return dir;
}

function parsedFieldsFor(kind: IngestKind, filePath: string, stat: fs.Stats, sourceRoot: string): ParsedItem {
  const name = path.basename(filePath);
  if (kind === 'movies') {
    const parsed = parseMovieFilename(name);
    return { title: parsed.title || null, year: parsed.year, season: null, episode: null };
  }
  if (kind === 'shows') {
    const episode = parseEpisodeFilename(name);
    let showTitle = showTitleFromName(name);
    if (!showTitle) {
      const folder = showFolderFor(filePath, sourceRoot);
      const folderTitle = folder ? parseMovieFilename(`${path.basename(folder)}.apply`).title : '';
      showTitle = folderTitle && folderTitle !== 'Apply' ? folderTitle : null;
    }
    return {
      title: showTitle,
      year: null,
      season: episode?.season ?? null,
      episode: episode?.episode ?? null,
    };
  }
  if (kind === 'music') {
    const parsed = parseTrackFilename(name);
    return { title: parsed.title || null, year: null, season: null, episode: null };
  }
  const parsed = parseMovieFilename(name);
  return { title: parsed.title || null, year: parsed.year ?? yearInName(name) ?? new Date(stat.mtimeMs).getUTCFullYear(), season: null, episode: null };
}

/** Sniff NFO next to a new file so discovery can store the local confidence early. */
function localNfoMeta(kind: IngestKind, filePath: string): { title: string | null; year: number | null } {
  if (kind === 'movies') {
    const nfo = findNfo(filePath, 'movie');
    return { title: nfo?.metadata.title ?? null, year: nfo?.metadata.year ?? null };
  }
  if (kind === 'shows') {
    const nfo = findNfo(filePath, 'episode');
    if (nfo) return { title: nfo.metadata.title ?? null, year: nfo.metadata.year ?? null };
    return { title: null, year: null };
  }
  return { title: null, year: null };
}

function hasBadName(name: string): boolean {
  const lower = name.toLowerCase();
  return name.startsWith('.') || lower.endsWith('.part') || lower.endsWith('.tmp') || lower.endsWith('.crdownload') || lower.endsWith('.!qB');
}

export interface DiscoveryResult {
  added: number;
  updated: number;
  skipped: number;
  total: number;
  warnings: string[];
}

export function discoverItems(sourceOrId: IngestSourceRow | number, force = false): DiscoveryResult {
  const source = typeof sourceOrId === 'number' ? requireSource(sourceOrId) : sourceOrId;
  const db = getDb();
  const result: DiscoveryResult = { added: 0, updated: 0, skipped: 0, total: 0, warnings: [] };
  try {
    fs.mkdirSync(source.path, { recursive: true });
  } catch (error) {
    result.warnings.push(`Cannot create source directory ${source.path}: ${errorMessage(error)}`);
    return result;
  }
  if (!fs.statSync(source.path).isDirectory()) {
    result.warnings.push(`Source path is not a directory: ${source.path}`);
    return result;
  }
  const allowed = sourceKindExtensions(source.kind);
  const now = Date.now();
  const settleMs = Math.max(0, source.settle_seconds) * 1000;
  const selectExisting = db.prepare('SELECT * FROM ingest_items WHERE source_id = ? AND path = ?');
  const insert = db.prepare(
    `INSERT INTO ingest_items(source_id, path, name, ext, size_bytes, mtime, status, parsed_title, parsed_year, parsed_season, parsed_episode, title, year, season_number, episode_number, confidence, candidates, created_at, updated_at)
     VALUES(@source_id, @path, @name, @ext, @size_bytes, @mtime, 'pending', @parsed_title, @parsed_year, @parsed_season, @parsed_episode, @parsed_title, @parsed_year, @parsed_season, @parsed_episode, @confidence, '[]', @now, @now)
     ON CONFLICT(source_id, path) DO UPDATE SET
       size_bytes = excluded.size_bytes, mtime = excluded.mtime, status = 'pending', error = NULL,
       parsed_title = excluded.parsed_title, parsed_year = excluded.parsed_year,
       parsed_season = excluded.parsed_season, parsed_episode = excluded.parsed_episode,
       title = excluded.parsed_title, year = excluded.parsed_year,
       season_number = excluded.parsed_season, episode_number = excluded.parsed_episode,
       confidence = excluded.confidence, updated_at = excluded.updated_at`,
  );
  const walk = (dir: string, depth: number): void => {
    if (result.total >= INGEST_LIMITS.maxWalkEntries || result.added >= INGEST_LIMITS.maxNewItemsPerPass) return;
    if (depth > 32) {
      result.warnings.push(`Depth limit reached at ${dir}`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      result.warnings.push(`Cannot read ${dir}: ${errorMessage(error)}`);
      return;
    }
    for (const entry of entries) {
      if (result.total >= INGEST_LIMITS.maxWalkEntries || result.added >= INGEST_LIMITS.maxNewItemsPerPass) return;
      if (hasBadName(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (source.recursive === 1) walk(full, depth + 1);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) {
          const target = fs.statSync(full);
          if (!target.isFile()) continue;
          stat = target;
        }
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      if (!allowed[extOf(entry.name)]) continue;
      if (now - stat.mtimeMs < settleMs) {
        result.skipped += 1;
        continue;
      }
      result.total += 1;
      const existing = selectExisting.get(source.id, full) as IngestItemRow | undefined;
      if (existing) {
        const unchanged = existing.size_bytes === stat.size && existing.mtime === Math.floor(stat.mtimeMs);
        if (existing.status === 'organized' || existing.status === 'ignored') {
          result.skipped += 1;
          continue;
        }
        if (unchanged && !force) {
          result.skipped += 1;
          continue;
        }
        if (existing.status === 'review' && unchanged) {
          result.skipped += 1;
          continue;
        }
      }
      const parsed = parsedFieldsFor(source.kind, full, stat, source.path);
      const nfo = localNfoMeta(source.kind, full);
      const confidence = nfo.title ? 0.95 : parsed.title ? (parsed.year ? 0.55 : 0.35) : 0;
      insert.run({
        source_id: source.id,
        path: full,
        name: entry.name,
        ext: extOf(entry.name),
        size_bytes: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        parsed_title: parsed.title,
        parsed_year: parsed.year,
        parsed_season: parsed.season,
        parsed_episode: parsed.episode,
        confidence,
        now: nowISO(),
      });
      if (existing) result.updated += 1;
      else result.added += 1;
    }
  };
  walk(source.path, 0);
  db.prepare('UPDATE ingest_sources SET last_scan_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), source.id);
  return result;
}

/* ------------------------------------------------------------------ */
/* Matching / processing                                               */
/* ------------------------------------------------------------------ */

export function getItemRow(id: number): IngestItemRow | undefined {
  return getDb().prepare('SELECT * FROM ingest_items WHERE id = ?').get(id) as IngestItemRow | undefined;
}

function requireItem(id: number): IngestItemRow {
  const row = getItemRow(id);
  if (!row) throw ingestError(`Ingest item ${id} does not exist`, 'not_found');
  return row;
}

function enrichmentFromNfo(
  nfo: ReturnType<typeof findNfo>,
  fallbackTitle: string | null,
  fallbackYear: number | null,
  fallbackScore = 0.35,
): Enrichment {
  const meta = nfo?.metadata;
  return {
    title: meta?.title || fallbackTitle || undefined,
    originalTitle: meta?.originalTitle ?? null,
    year: meta?.year ?? fallbackYear,
    releaseDate: meta?.releaseDate ?? null,
    description: meta?.description ?? '',
    tagline: meta?.tagline ?? null,
    rating: meta?.rating ?? null,
    contentRating: meta?.contentRating ?? null,
    runtimeSeconds: meta?.runtimeSeconds ?? null,
    genres: meta?.genres ?? [],
    tags: meta?.tags ?? [],
    people: meta?.people ?? [],
    provider: meta?.provider ?? null,
    providerId: meta?.providerId ?? null,
    matchScore: meta ? 0.95 : fallbackScore,
    posterUrl: null,
    backdropUrl: null,
  };
}

export function enrichmentFromProvider(resolved: ProviderResolved): Enrichment {
  return {
    title: resolved.title,
    originalTitle: resolved.originalTitle,
    year: resolved.year,
    releaseDate: resolved.releaseDate,
    description: resolved.description,
    tagline: resolved.tagline,
    rating: resolved.rating,
    contentRating: resolved.contentRating,
    runtimeSeconds: resolved.runtimeSeconds,
    genres: resolved.genres,
    tags: resolved.tags,
    people: resolved.people,
    provider: resolved.provider,
    providerId: resolved.providerId,
    matchScore: resolved.matchScore,
    posterUrl: resolved.posterUrl,
    backdropUrl: resolved.backdropUrl,
  };
}

export function candidateToDTO(candidate: ProviderCandidate): IngestCandidateDTO {
  return {
    provider: candidate.provider,
    providerId: candidate.providerId,
    kind: candidate.kind,
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    overview: candidate.overview,
    rating: candidate.rating,
    posterUrl: candidate.posterUrl,
    backdropUrl: candidate.backdropUrl,
    popularity: candidate.popularity,
    score: candidate.score,
  };
}

function candidatesFromJSON(raw: string): IngestCandidateDTO[] {
  const parsed = parseJSON<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as IngestCandidateDTO[]) : [];
}

function updateItem(id: number, patch: Record<string, unknown>): void {
  const db = getDb();
  const columns = Object.keys(patch);
  db.prepare(`UPDATE ingest_items SET ${columns.map((column) => `${column} = @${column}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: nowISO(),
  });
}

function publishItem(item: IngestItemRow): void {
  bus.publish('ingest.item', { itemId: item.id, status: item.status, sourceId: item.source_id });
}

function localBaseline(item: IngestItemRow, kind: IngestKind): number {
  if (kind === 'music') return 0.6;
  if (kind === 'photos') return 0.6;
  if (kind === 'shows') {
    if (item.parsed_title && item.parsed_season !== null && item.parsed_episode !== null) return 0.5;
    return item.parsed_title ? 0.35 : 0;
  }
  if (!item.parsed_title) return 0;
  return item.parsed_year ? 0.55 : 0.35;
}

function mergeLocalRemote(local: Enrichment, remote: Enrichment): Enrichment {
  return {
    title: local.title || remote.title,
    originalTitle: local.originalTitle || remote.originalTitle,
    year: local.year ?? remote.year,
    releaseDate: local.releaseDate || remote.releaseDate,
    description: local.description || remote.description,
    tagline: local.tagline || remote.tagline,
    rating: local.rating ?? remote.rating,
    contentRating: local.contentRating || remote.contentRating,
    runtimeSeconds: local.runtimeSeconds ?? remote.runtimeSeconds,
    genres: local.genres.length ? local.genres : remote.genres,
    tags: local.tags.length ? local.tags : remote.tags,
    people: local.people.length ? local.people : remote.people,
    provider: remote.provider,
    providerId: remote.providerId,
    matchScore: Math.max(local.matchScore ?? 0, remote.matchScore ?? 0),
    posterUrl: remote.posterUrl,
    backdropUrl: remote.backdropUrl,
  };
}

export interface ProcessOutcome {
  itemId: number;
  status: IngestStatus;
  confidence: number;
  mediaId: number | null;
  message: string;
}

export async function processItem(itemId: number, options: ProcessOptions = {}): Promise<ProcessOutcome> {
  const item = requireItem(itemId);
  const source = requireSource(item.source_id);
  if (item.status === 'organized' || item.status === 'ignored') {
    return { itemId, status: item.status, confidence: item.confidence ?? 0, mediaId: item.media_id, message: 'Item is already settled' };
  }
  const kind = source.kind;
  const baseline = localBaseline(item, kind);
  let movieNfo: NfoLookup | null = null;
  let showNfo: NfoLookup | null = null;
  let episodeNfo: NfoLookup | null = null;
  if (kind === 'movies') movieNfo = cachedFindNfo(item.path, 'movie');
  else if (kind === 'shows') {
    episodeNfo = cachedFindNfo(item.path, 'episode');
    const showFolder = showFolderFor(item.path, source.path);
    if (showFolder) showNfo = cachedFindNfo(showFolder, 'show');
  }
  const hasLocal = Boolean(movieNfo || showNfo || episodeNfo);
  const showMeta = showNfo?.metadata ?? null;
  let enrichment: Enrichment;
  if (kind === 'shows') {
    enrichment = enrichmentFromNfo(showNfo, item.parsed_title, item.parsed_year, baseline);
    if (episodeNfo && !showNfo) {
      const episode = episodeNfo.metadata;
      enrichment.description = enrichment.description || episode.description || '';
      enrichment.genres = enrichment.genres.length ? enrichment.genres : episode.genres;
      enrichment.tags = enrichment.tags.length ? enrichment.tags : episode.tags;
      enrichment.people = enrichment.people.length ? enrichment.people : episode.people;
      enrichment.contentRating = enrichment.contentRating || episode.contentRating;
      enrichment.provider = enrichment.provider || episode.provider || null;
      enrichment.providerId = enrichment.providerId || episode.providerId || null;
    }
  } else {
    enrichment = enrichmentFromNfo(movieNfo, item.parsed_title, item.parsed_year, baseline);
  }
  let confidence = hasLocal ? 0.95 : baseline;
  let candidates: ProviderCandidate[] = [];
  let provider: string | null = enrichment.provider ?? null;
  let providerId: string | null = enrichment.providerId ?? null;
  let resolvedTitle = showMeta?.title || enrichment.title || item.parsed_title;
  let resolvedYear = showMeta?.year ?? enrichment.year ?? item.parsed_year;

  const shouldSearch = (kind === 'movies' || kind === 'shows')
    && source.auto_match === 1
    && Boolean(item.parsed_title || (kind === 'movies' && enrichment.title));
  if (shouldSearch) {
    const query = kind === 'shows' ? (item.parsed_title || showMeta?.title || '') : (enrichment.title || item.parsed_title || '');
    const year = kind === 'shows' ? (item.parsed_year ?? showMeta?.year ?? null) : (enrichment.year ?? item.parsed_year);
    try {
      candidates = await searchProviders(kind === 'movies' ? 'movie' : 'show', query, year, { limit: INGEST_LIMITS.maxCandidates });
    } catch (error) {
      logger.warn('ingest', `Provider search failed during ingest: ${errorMessage(error)}`);
      candidates = [];
    }
    const best = candidates[0];
    if (best && best.score >= 0.55) {
      let resolved: ProviderResolved | null = null;
      try {
        resolved = await resolveProvider(best.provider, best.kind, best.providerId, query, year);
      } catch (error) {
        logger.warn('ingest', `Provider resolve failed during ingest: ${errorMessage(error)}`);
      }
      if (resolved) {
        const remote = enrichmentFromProvider(resolved);
        if (hasLocal) {
          enrichment = mergeLocalRemote(enrichment, remote);
          resolvedTitle = enrichment.title || resolvedTitle;
          resolvedYear = enrichment.year ?? resolvedYear;
        } else {
          enrichment = remote;
          resolvedTitle = resolved.title;
          resolvedYear = resolved.year;
        }
        confidence = Math.max(confidence, best.score, resolved.matchScore);
        provider = resolved.provider;
        providerId = resolved.providerId;
      }
    }
  }

  if (kind === 'shows') {
    resolvedTitle = enrichment.title || resolvedTitle || null;
    resolvedYear = enrichment.year ?? resolvedYear;
    if (provider) {
      enrichment.provider = provider;
      enrichment.providerId = providerId;
      enrichment.matchScore = confidence;
    }
    const season = item.parsed_season ?? 1;
    const episode = item.parsed_episode ?? 0;
    updateItem(item.id, {
      title: resolvedTitle,
      year: resolvedYear,
      season_number: season,
      episode_number: episode,
      confidence,
      candidates: JSON.stringify(candidates.slice(0, INGEST_LIMITS.maxCandidates).map(candidateToDTO)),
      enrichment: JSON.stringify(enrichment),
      provider,
      provider_id: providerId,
      error: null,
    });
  } else {
    enrichment.title = enrichment.title || resolvedTitle || undefined;
    enrichment.year = enrichment.year ?? resolvedYear;
    enrichment.provider = provider ?? enrichment.provider ?? null;
    enrichment.providerId = providerId ?? enrichment.providerId ?? null;
    enrichment.matchScore = confidence;
    updateItem(item.id, {
      title: enrichment.title ?? resolvedTitle,
      year: enrichment.year ?? resolvedYear,
      confidence,
      candidates: JSON.stringify(candidates.slice(0, INGEST_LIMITS.maxCandidates).map(candidateToDTO)),
      enrichment: JSON.stringify(enrichment),
      provider,
      provider_id: providerId,
      error: null,
    });
  }

  const fresh = requireItem(item.id);
  const hold = confidence < source.min_confidence && source.hold_unmatched === 1;
  if (hold) {
    updateItem(item.id, { status: 'review' });
    const reviewed = requireItem(item.id);
    publishItem(reviewed);
    bus.publish('ingest.progress', { sourceId: source.id, processed: 1, total: 1, message: `Item ${item.id} needs a human`, status: 'review' });
    return { itemId: item.id, status: 'review', confidence, mediaId: null, message: 'Below confidence threshold; review queued' };
  }

  const resolution: IngestResolution = {
    title: fresh.title,
    year: fresh.year,
    season: fresh.season_number,
    episode: fresh.episode_number,
    provider,
    providerId,
    confidence,
    enrichment,
    candidates,
  };
  const organized = await organizeItem(item.id, resolution, options);
  return { itemId: item.id, status: organized.status, confidence, mediaId: organized.mediaId, message: organized.message };
}

export interface OrganizeResult {
  itemId: number;
  status: IngestStatus;
  destPath: string | null;
  libraryId: number | null;
  mediaId: number | null;
  message: string;
}

interface TransferNote {
  fallback: boolean;
  message: string;
}

function transferFile(source: string, destination: string, action: IngestAction): TransferNote {
  if (action === 'symlink') {
    // Absolute link to the source file. Removing the source breaks playback; that is the symlink bargain.
    fs.symlinkSync(path.resolve(source), destination, 'file');
    return { fallback: false, message: '' };
  }
  if (action === 'copy') {
    fs.copyFileSync(source, destination);
    return { fallback: false, message: '' };
  }
  if (action === 'hardlink') {
    try {
      fs.linkSync(source, destination);
      return { fallback: false, message: '' };
    } catch (error) {
      fs.copyFileSync(source, destination);
      return { fallback: true, message: `hardlink failed (${errorMessage(error)}); copied instead` };
    }
  }
  try {
    fs.renameSync(source, destination);
    return { fallback: false, message: '' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
    return { fallback: true, message: 'cross-device move; copied then removed source' };
  }
}

function appendNote(item: IngestItemRow, note: string): string {
  if (!note) return item.notes || '';
  const existing = item.notes ? `${item.notes}\n` : '';
  return `${existing}${note}`.slice(-2000);
}

function musicFolders(source: IngestSourceRow, item: IngestItemRow): { artist: string | null; album: string | null } {
  const dir = path.dirname(item.path);
  const rel = path.relative(source.path, dir);
  const segments = rel && rel !== '.' ? rel.split(path.sep).filter(Boolean) : [];
  const parsed = parseTrackFilename(item.name);
  if (segments.length >= 2) {
    return { artist: segments[segments.length - 2], album: segments[segments.length - 1] };
  }
  if (segments.length === 1) return { artist: parsed.artist, album: segments[0] };
  return { artist: parsed.artist, album: null };
}

function sidecarPlan(
  kind: IngestKind,
  item: IngestItemRow,
  dest: string,
  sourceRoot: string,
  skipNfo: boolean,
): { source: string; destination: string; actionKey: string }[] {
  const sourceDir = path.dirname(item.path);
  const sourceStem = stripExtension(item.name);
  const destDir = path.dirname(dest);
  const destBase = destStem(dest);
  const plan: { source: string; destination: string; actionKey: string }[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(sourceDir);
  } catch {
    return plan;
  }
  for (const name of names) {
    if (plan.length >= INGEST_LIMITS.maxSidecars) break;
    if (name === item.name || name.startsWith('.')) continue;
    const ext = extOf(name);
    const stem = stripExtension(name);
    const sameStem = stem === sourceStem || stem.startsWith(`${sourceStem}.`);
    const suffix = sameStem && stem !== sourceStem ? stem.slice(sourceStem.length) : '';
    if (SUBTITLE_EXT[ext] && sameStem) {
      plan.push({ source: path.join(sourceDir, name), destination: path.join(destDir, `${destBase}${suffix}.${ext}`), actionKey: 'subtitle' });
      continue;
    }
    if (ext === 'nfo') {
      if (skipNfo) continue;
      if (sameStem) {
        plan.push({ source: path.join(sourceDir, name), destination: path.join(destDir, `${destBase}.nfo`), actionKey: 'nfo' });
      } else if (name === 'movie.nfo' && kind === 'movies') {
        plan.push({ source: path.join(sourceDir, name), destination: path.join(destDir, 'movie.nfo'), actionKey: 'movie-nfo' });
      } else if ((name === 'tvshow.nfo' || name === 'show.nfo') && kind === 'shows') {
        const showRoot = path.dirname(path.dirname(dest));
        plan.push({ source: path.join(sourceDir, name), destination: path.join(showRoot, name), actionKey: 'show-nfo' });
      } else if (name === 'album.nfo' && kind === 'music') {
        plan.push({ source: path.join(sourceDir, name), destination: path.join(path.dirname(dest), 'album.nfo'), actionKey: 'album-nfo' });
      } else if (name === 'artist.nfo' && kind === 'music') {
        plan.push({ source: path.join(sourceDir, name), destination: path.join(path.dirname(path.dirname(dest)), 'artist.nfo'), actionKey: 'artist-nfo' });
      }
      continue;
    }
    if (ART_EXT[ext] && ART_NAMES[path.basename(name, path.extname(name)).toLowerCase()]) {
      const artDir = kind === 'shows' ? path.dirname(path.dirname(dest)) : destDir;
      plan.push({ source: path.join(sourceDir, name), destination: path.join(artDir, sanitizeSegment(name, 'art.jpg')), actionKey: 'art' });
    }
  }
  if (kind === 'shows') {
    const showFolder = showFolderFor(item.path, sourceRoot);
    if (showFolder && showFolder !== sourceDir) {
      const showRoot = path.dirname(path.dirname(dest));
      if (!skipNfo) {
        for (const name of ['tvshow.nfo', 'show.nfo']) {
          const candidate = path.join(showFolder, name);
          if (fs.existsSync(candidate)) plan.push({ source: candidate, destination: path.join(showRoot, name), actionKey: 'show-nfo' });
        }
      }
      let showArtNames: string[] = [];
      try {
        showArtNames = fs.readdirSync(showFolder);
      } catch {
        showArtNames = [];
      }
      for (const name of showArtNames) {
        const ext = extOf(name);
        if (!ART_EXT[ext] || !ART_NAMES[path.basename(name, path.extname(name)).toLowerCase()]) continue;
        plan.push({ source: path.join(showFolder, name), destination: path.join(showRoot, sanitizeSegment(name, 'art.jpg')), actionKey: 'art' });
      }
    }
  }
  return plan;
}

export async function organizeItem(itemId: number, resolution?: IngestResolution, options: ProcessOptions = {}): Promise<OrganizeResult> {
  const item = requireItem(itemId);
  if (item.status === 'organized') {
    const error = new Error('Item is already organized') as Error & { code?: string };
    error.code = 'already_organized';
    throw error;
  }
  if (item.status === 'ignored') {
    const error = new Error('Item is ignored; retry it before organizing') as Error & { code?: string };
    error.code = 'item_ignored';
    throw error;
  }
  const source = requireSource(item.source_id);
  let library: LibraryRow;
  try {
    library = destinationLibrary(source);
    assertNoLoop(source.path, library.path);
  } catch (error) {
    updateItem(item.id, { status: 'error', error: errorMessage(error).slice(0, 1000) });
    publishItem(requireItem(item.id));
    throw ingestError(`Destination library unusable: ${errorMessage(error)}`, 'organize_failed');
  }

  const storedEnrichment = parseJSON<Enrichment | null>(item.enrichment, null);
  const enrichment: Enrichment = resolution?.enrichment ?? storedEnrichment ?? {
    title: item.parsed_title || undefined,
    year: item.parsed_year,
    genres: [],
    tags: [],
    people: [],
    matchScore: item.confidence ?? 0,
  };
  const rawTitle = resolution?.title || enrichment.title || item.parsed_title;
  const title = sanitizeSegment(rawTitle || (source.kind === 'shows' ? 'Untitled Show' : item.name), source.kind === 'shows' ? 'Untitled Show' : 'Untitled');
  const year = resolution?.year ?? enrichment.year ?? item.parsed_year ?? null;
  const season = resolution?.season ?? item.parsed_season ?? 1;
  const episode = resolution?.episode ?? item.parsed_episode ?? 0;
  const episodeNfo = source.kind === 'shows' ? cachedFindNfo(item.path, 'episode') : null;
  const episodeTitle = resolution?.episodeTitle || episodeNfo?.metadata.title || parseEpisodeFilename(item.name)?.title || `Episode ${episode}`;
  const movieNfo = source.kind === 'movies' ? cachedFindNfo(item.path, 'movie') : null;
  let showNfo: NfoLookup | null = null;
  if (source.kind === 'shows') {
    const showFolder = showFolderFor(item.path, source.path);
    if (showFolder) showNfo = cachedFindNfo(showFolder, 'show');
  }
  // Episode NFO titles describe the episode, not the show, so only show/movie NFOs can conflict with the chosen show title.
  const titleNfo = movieNfo ?? showNfo;
  const nfoTitle = titleNfo?.metadata.title?.trim().toLowerCase() || null;
  const titleOverridden = Boolean(nfoTitle && nfoTitle !== title.toLowerCase());
  const yearOverridden = Boolean(titleNfo?.metadata.year && year !== null && titleNfo.metadata.year !== year);
  // Copy NFO sidecars unless the chosen canonical title/year contradicts them; a stale NFO would
  // otherwise win on the next scan and undo the match the admin just made.
  const skipNfo = titleOverridden || yearOverridden;
  const music = source.kind === 'music' ? musicFolders(source, item) : { artist: null, album: null };
  const track = source.kind === 'music' ? parseTrackFilename(item.name) : null;

  const fields: DestFields = {
    title: source.kind === 'shows' ? title : (track?.title || title),
    year,
    seasonNumber: season,
    episodeNumber: episode,
    episodeTitle,
    artist: music.artist,
    album: music.album,
    trackNumber: track?.trackNumber ?? null,
    originalName: item.name,
    mtimeMs: item.mtime,
  };
  let destination: string;
  try {
    destination = uniquePath(destPathFor(source.kind, library.path, fields));
  } catch (error) {
    updateItem(item.id, { status: 'error', error: errorMessage(error).slice(0, 1000) });
    publishItem(requireItem(item.id));
    throw error;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const notes: string[] = [];
  try {
    if (!fs.existsSync(item.path) || !fs.statSync(item.path).isFile()) {
      throw new Error(`Source file disappeared: ${item.path}`);
    }
    const primary = transferFile(item.path, destination, source.action);
    if (primary.fallback) notes.push(primary.message);
    const sharedSidecars = new Set(['movie-nfo', 'show-nfo', 'album-nfo', 'artist-nfo', 'art']);
    for (const sidecar of sidecarPlan(source.kind, item, destination, source.path, skipNfo)) {
      if (!fs.existsSync(sidecar.source)) continue;
      if (isInside(sidecar.destination, library.path) === false) continue;
      const shared = sharedSidecars.has(sidecar.actionKey);
      if (shared && fs.existsSync(sidecar.destination)) continue;
      const target = shared ? sidecar.destination : uniquePath(sidecar.destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const transfer = transferFile(sidecar.source, target, source.action);
      if (transfer.fallback) notes.push(`${path.basename(sidecar.source)}: ${transfer.message}`);
    }
  } catch (error) {
    updateItem(item.id, { status: 'error', error: errorMessage(error).slice(0, 1000) });
    publishItem(requireItem(item.id));
    const failure = new Error(`Organize failed: ${errorMessage(error)}`) as Error & { code?: string };
    failure.code = 'organize_failed';
    throw failure;
  }

  const confidence = resolution?.confidence ?? item.confidence ?? enrichment.matchScore ?? 0;
  const canonicalTitle = source.kind === 'music'
    ? parseTrackFilename(item.name).title || title
    : source.kind === 'photos'
      ? (item.parsed_title || stripExtension(item.name))
      : title;
  updateItem(item.id, {
    status: 'organized',
    dest_path: destination,
    library_id: library.id,
    title: canonicalTitle,
    year: source.kind === 'music' || source.kind === 'photos' ? item.parsed_year : year,
    season_number: source.kind === 'shows' ? season : null,
    episode_number: source.kind === 'shows' ? episode : null,
    confidence,
    enrichment: JSON.stringify(enrichment),
    notes: appendNote(item, notes.join('; ')),
    error: null,
    media_id: null,
  });
  const organized = requireItem(item.id);
  publishItem(organized);
  if (options.triggerScan) await indexOrganizedItems([item.id]);
  const fresh = requireItem(item.id);
  return {
    itemId: item.id,
    status: fresh.status,
    destPath: fresh.dest_path,
    libraryId: fresh.library_id,
    mediaId: fresh.media_id,
    message: options.triggerScan ? 'Organized and indexed' : 'Organized; indexing pending batch scan',
  };
}

/* ------------------------------------------------------------------ */
/* Indexing + media linkage                                            */
/* ------------------------------------------------------------------ */

function showRowForEpisode(row: MediaRow): MediaRow | undefined {
  if (row.kind !== 'episode' || row.parent_id === null) return undefined;
  const season = getDb().prepare('SELECT * FROM media WHERE id = ?').get(row.parent_id) as MediaRow | undefined;
  if (!season || season.parent_id === null) return undefined;
  return getDb().prepare('SELECT * FROM media WHERE id = ?').get(season.parent_id) as MediaRow | undefined;
}

async function applyIngestEnrichment(item: IngestItemRow, row: MediaRow, enrichment: Enrichment): Promise<MediaRow> {
  if (row.kind === 'episode' && item.year !== null && row.metadata_locked === 0) {
    getDb().prepare('UPDATE media SET year = COALESCE(year, ?), updated_at = ? WHERE id = ?').run(item.year, nowISO(), row.id);
  }
  if (row.kind === 'photo') {
    applyEnrichment(row.id, enrichment);
    return row;
  }
  let target = row;
  if (row.kind === 'episode') {
    const show = showRowForEpisode(row);
    if (show) target = show;
  }
  if (target.kind === 'movie' || target.kind === 'show') {
    const applied = applyEnrichment(target.id, enrichment);
    if (!applied || target.metadata_locked === 1) return target;
    if (enrichment.posterUrl) await downloadRemoteArt(target.id, 'poster', enrichment.posterUrl);
    if (enrichment.backdropUrl) await downloadRemoteArt(target.id, 'backdrop', enrichment.backdropUrl);
    await ensureArtForMedia(target.id);
  }
  return target;
}

/** Scan destination libraries once per batch, then attach ingest items to media rows. */
export async function indexOrganizedItems(itemIds?: number[]): Promise<{ scanned: number[]; deferred: number[]; mapped: number }> {
  const db = getDb();
  const params: unknown[] = [];
  let where = "status = 'organized'";
  if (itemIds && itemIds.length > 0) {
    where += ` AND id IN (${itemIds.map(() => '?').join(',')})`;
    params.push(...itemIds);
  } else {
    where += ' AND media_id IS NULL';
  }
  const items = db.prepare(`SELECT * FROM ingest_items WHERE ${where}`).all(...params) as IngestItemRow[];
  const libraryIds = [...new Set(items.map((item) => item.library_id).filter((id): id is number => Number.isInteger(id)))];
  const scanned: number[] = [];
  const deferred: number[] = [];
  for (const libraryId of libraryIds) {
    const active = findActiveScanJob(libraryId);
    if (active) {
      deferred.push(libraryId);
      for (const item of items.filter((entry) => entry.library_id === libraryId)) {
        updateItem(item.id, { notes: appendNote(item, `Indexing deferred: scan ${active.id} is ${active.status}`) });
      }
      continue;
    }
    try {
      const result = await scanLibrary(libraryId);
      scanned.push(libraryId);
      if (result.status === 'error') {
        for (const item of items.filter((entry) => entry.library_id === libraryId)) {
          updateItem(item.id, { notes: appendNote(item, `Scan error: ${result.errors[0] || 'unknown'}`) });
        }
      }
    } catch (error) {
      deferred.push(libraryId);
      const message = errorMessage(error);
      for (const item of items.filter((entry) => entry.library_id === libraryId)) {
        updateItem(item.id, { notes: appendNote(item, `Scan skipped: ${message}`) });
      }
    }
  }
  let mapped = 0;
  for (const item of items) {
    if (!item.dest_path) continue;
    const row = db.prepare('SELECT * FROM media WHERE path = ?').get(item.dest_path) as MediaRow | undefined;
    if (!row) continue;
    const enrichment = parseJSON<Enrichment | null>(item.enrichment, null);
    if (enrichment) {
      try {
        await applyIngestEnrichment(item, row, enrichment);
      } catch (error) {
        logger.warn('ingest', `Enrichment failed for item ${item.id}: ${errorMessage(error)}`);
      }
    }
    updateItem(item.id, { media_id: row.id, library_id: row.library_id });
    mapped += 1;
    const fresh = requireItem(item.id);
    publishItem(fresh);
  }
  return { scanned, deferred, mapped };
}

/* ------------------------------------------------------------------ */
/* Review actions                                                      */
/* ------------------------------------------------------------------ */

export interface MatchSearchResult {
  item: IngestItemDTO;
  candidates: IngestCandidateDTO[];
  providers: ProviderStatus[];
}

export async function searchItemCandidates(itemId: number, query?: string): Promise<MatchSearchResult> {
  const item = requireItem(itemId);
  const source = requireSource(item.source_id);
  if (item.status === 'organized') {
    const error = new Error('Item is already organized') as Error & { code?: string };
    error.code = 'already_organized';
    throw error;
  }
  if (source.kind !== 'movies' && source.kind !== 'shows') {
    updateItem(item.id, { candidates: '[]' });
    return { item: getItemDTO(item.id), candidates: [], providers: providerStatuses() };
  }
  const kind = source.kind === 'movies' ? 'movie' : 'show';
  const fallbackQuery = item.parsed_title || item.title || parseMovieFilename(item.name).title;
  const resolvedQuery = (query?.trim() || fallbackQuery || '').slice(0, 300);
  let candidates: ProviderCandidate[] = [];
  if (resolvedQuery) {
    try {
      candidates = await searchProviders(kind, resolvedQuery, item.parsed_year, { limit: INGEST_LIMITS.maxCandidates, manual: true });
    } catch (error) {
      logger.warn('ingest', `Manual provider search failed: ${errorMessage(error)}`);
    }
  }
  const dtos = candidates.map(candidateToDTO);
  updateItem(item.id, { candidates: JSON.stringify(dtos) });
  return { item: getItemDTO(item.id), candidates: dtos, providers: providerStatuses() };
}

export interface ManualMatchInput extends IngestResolution {
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  overview?: string | null;
}

export async function applyManualMatch(itemId: number, input: ManualMatchInput): Promise<OrganizeResult & { item: IngestItemDTO }> {
  const item = requireItem(itemId);
  const source = requireSource(item.source_id);
  if (item.status === 'organized') {
    const error = new Error('Item is already organized') as Error & { code?: string };
    error.code = 'already_organized';
    throw error;
  }
  const kind = item.status === 'ignored' ? 'ignored' : 'ok';
  if (kind === 'ignored') {
    updateItem(item.id, { status: 'pending', error: null });
  }
  const provider = input.provider?.trim() || null;
  const providerId = input.providerId?.trim() || null;
  let resolution: IngestResolution = {
    title: input.title ?? null,
    year: input.year ?? null,
    season: input.season ?? item.parsed_season,
    episode: input.episode ?? item.parsed_episode,
    episodeTitle: input.episodeTitle ?? null,
    provider,
    providerId,
    confidence: input.confidence ?? 1,
    enrichment: input.enrichment ?? null,
    candidates: input.candidates ?? null,
  };
  if (provider) {
    const known = providerStatuses().find((status) => status.id === provider);
    if (!known) {
      const error = new Error(`Unknown provider: ${provider}`) as Error & { code?: string };
      error.code = 'bad_provider';
      throw error;
    }
    if (!providerId) {
      const error = new Error('providerId is required when provider is set') as Error & { code?: string };
      error.code = 'bad_provider';
      throw error;
    }
    const subjectKind = source.kind === 'movies' ? 'movie' : source.kind === 'shows' ? 'show' : null;
    if (!subjectKind) {
      const error = new Error('Provider matching supports movie/show ingest sources only') as Error & { code?: string };
      error.code = 'bad_provider';
      throw error;
    }
    let resolved: ProviderResolved | null = null;
    try {
      resolved = await resolveProvider(known.id, subjectKind, providerId, input.title ?? item.parsed_title ?? undefined, input.year ?? item.parsed_year, { manual: true });
    } catch (error) {
      logger.warn('ingest', `Manual provider resolve failed: ${errorMessage(error)}`);
    }
    if (!resolved) {
      const error = new Error('Provider returned no details for that id') as Error & { code?: string };
      error.code = 'no_match';
      throw error;
    }
    const resolvedEnrichment = enrichmentFromProvider(resolved);
    const confidence = Math.max(resolved.matchScore, 0.9);
    resolvedEnrichment.matchScore = confidence;
    resolution = {
      title: resolved.title,
      year: resolved.year,
      season: input.season ?? item.parsed_season,
      episode: input.episode ?? item.parsed_episode,
      episodeTitle: input.episodeTitle ?? null,
      provider: resolved.provider,
      providerId: resolved.providerId,
      confidence,
      enrichment: resolvedEnrichment,
      candidates: input.candidates ?? null,
    };
  } else {
    const title = (input.title ?? '').trim();
    if (!title) {
      const error = new Error('A title is required for a manual match') as Error & { code?: string };
      error.code = 'bad_request';
      throw error;
    }
    if (input.year !== undefined && input.year !== null) {
      if (!Number.isInteger(input.year) || input.year < 1800 || input.year > 2200) {
        const error = new Error('year must be an integer between 1800 and 2200') as Error & { code?: string };
        error.code = 'bad_request';
        throw error;
      }
    }
    const base = parseJSON<Enrichment | null>(item.enrichment, null);
    resolution.title = title.slice(0, 300);
    resolution.enrichment = {
      title: resolution.title,
      originalTitle: base?.originalTitle ?? null,
      year: resolution.year,
      releaseDate: base?.releaseDate ?? null,
      description: input.overview?.slice(0, 5000) ?? base?.description ?? '',
      tagline: base?.tagline ?? null,
      rating: base?.rating ?? null,
      contentRating: base?.contentRating ?? null,
      runtimeSeconds: base?.runtimeSeconds ?? null,
      genres: base?.genres ?? [],
      tags: base?.tags ?? [],
      people: base?.people ?? [],
      provider: null,
      providerId: null,
      matchScore: 1,
      posterUrl: null,
      backdropUrl: null,
    };
  }
  updateItem(item.id, {
    title: resolution.title,
    year: resolution.year,
    season_number: source.kind === 'shows' ? (resolution.season ?? 1) : null,
    episode_number: source.kind === 'shows' ? (resolution.episode ?? 0) : null,
    confidence: resolution.confidence ?? 1,
    provider: resolution.provider ?? null,
    provider_id: resolution.providerId ?? null,
    enrichment: JSON.stringify(resolution.enrichment),
    status: 'pending',
    error: null,
  });
  const organized = await organizeItem(item.id, resolution, { triggerScan: true });
  return { ...organized, item: getItemDTO(item.id) };
}

export async function retryItem(itemId: number): Promise<{ item: IngestItemDTO; outcome: ProcessOutcome }> {
  const item = requireItem(itemId);
  if (item.status === 'organized') {
    const error = new Error('Item is already organized') as Error & { code?: string };
    error.code = 'already_organized';
    throw error;
  }
  updateItem(item.id, { status: 'pending', error: null, media_id: null, dest_path: null, notes: null });
  // Retry is an explicit user action: if it organizes, index it now instead of
  // leaving mediaId null until some later library scan.
  const outcome = await processItem(item.id, { triggerScan: true });
  return { item: getItemDTO(item.id), outcome };
}

export function ignoreItem(itemId: number): IngestItemDTO {
  const item = requireItem(itemId);
  if (item.status === 'organized') {
    const error = new Error('Item is already organized') as Error & { code?: string };
    error.code = 'already_organized';
    throw error;
  }
  updateItem(item.id, { status: 'ignored', error: null });
  publishItem(requireItem(item.id));
  return getItemDTO(item.id);
}

export async function organizeParsedItem(itemId: number): Promise<OrganizeResult & { item: IngestItemDTO }> {
  const item = requireItem(itemId);
  const source = requireSource(item.source_id);
  const enrichment = parseJSON<Enrichment | null>(item.enrichment, null);
  const resolution: IngestResolution = {
    title: item.parsed_title || item.title,
    year: item.parsed_year ?? item.year,
    season: item.parsed_season,
    episode: item.parsed_episode,
    episodeTitle: parseEpisodeFilename(item.name)?.title ?? null,
    confidence: item.confidence ?? 0,
    enrichment: enrichment ?? {
      title: item.parsed_title || undefined,
      year: item.parsed_year,
      genres: [],
      tags: [],
      people: [],
      matchScore: item.confidence ?? 0,
    },
  };
  if (item.status === 'ignored') updateItem(item.id, { status: 'pending' });
  const { kind } = source;
  if (kind !== 'movies' && kind !== 'shows' && kind !== 'music' && kind !== 'photos') {
    const error = new Error('Unsupported ingest kind') as Error & { code?: string };
    error.code = 'bad_request';
    throw error;
  }
  const organized = await organizeItem(item.id, resolution, { triggerScan: true });
  return { ...organized, item: getItemDTO(item.id) };
}

/* ------------------------------------------------------------------ */
/* Source validation + DTOs                                            */
/* ------------------------------------------------------------------ */

export function ingestError(message: string, code = 'bad_request'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function parseSettingsObject(raw: string): Record<string, unknown> {
  const parsed = parseJSON<unknown>(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function sourceCounts(sourceId: number): IngestSourceStats {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM ingest_items WHERE source_id = ? GROUP BY status').all(sourceId) as {
    status: IngestStatus;
    n: number;
  }[];
  const counts: IngestSourceStats = { pending: 0, review: 0, organized: 0, error: 0, ignored: 0 };
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

function previewDestination(source: Pick<IngestSourceRow, 'library_id' | 'kind'>): { libraryId: number | null; libraryName: string | null; path: string } {
  const db = getDb();
  if (source.library_id !== null && source.library_id !== undefined) {
    const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(source.library_id) as LibraryRow | undefined;
    if (row) return { libraryId: row.id, libraryName: row.name, path: row.path };
  }
  const existing = db.prepare('SELECT * FROM libraries WHERE kind = ? ORDER BY id LIMIT 1').get(source.kind) as LibraryRow | undefined;
  if (existing) return { libraryId: existing.id, libraryName: existing.name, path: existing.path };
  const autoPath = autoLibraryPath(source.kind);
  const auto = db.prepare('SELECT * FROM libraries WHERE path = ?').get(autoPath) as LibraryRow | undefined;
  if (auto) return { libraryId: auto.id, libraryName: auto.name, path: auto.path };
  return { libraryId: null, libraryName: autoLibraryName(source.kind), path: autoPath };
}

export function sourceToDTO(row: IngestSourceRow): IngestSourceDTO {
  const destination = previewDestination(row);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    path: row.path,
    libraryId: row.library_id ?? destination.libraryId,
    libraryName: destination.libraryName,
    destinationPath: destination.path,
    action: row.action,
    autoMatch: row.auto_match === 1,
    minConfidence: row.min_confidence,
    holdUnmatched: row.hold_unmatched === 1,
    recursive: row.recursive === 1,
    settleSeconds: row.settle_seconds,
    enabled: row.enabled === 1,
    settings: parseSettingsObject(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastScanAt: row.last_scan_at,
    lastResult: parseJSON<unknown>(row.last_result, null),
    counts: sourceCounts(row.id),
  };
}

export function getSourceDTO(id: number): IngestSourceDTO {
  const row = getSourceRow(id);
  if (!row) throw ingestError(`Ingest source ${id} does not exist`, 'not_found');
  return sourceToDTO(row);
}

export function itemToDTO(row: IngestItemRow, source?: IngestSourceRow, includeMedia = false): IngestItemDTO {
  const owner = source ?? getSourceRow(row.source_id);
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: owner?.name ?? 'Unknown source',
    sourceKind: owner?.kind ?? 'movies',
    path: row.path,
    destPath: row.dest_path,
    name: row.name,
    ext: row.ext,
    sizeBytes: row.size_bytes,
    status: row.status,
    parsed: {
      title: row.parsed_title,
      year: row.parsed_year,
      season: row.parsed_season,
      episode: row.parsed_episode,
    },
    title: row.title,
    year: row.year,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    provider: row.provider,
    providerId: row.provider_id,
    confidence: row.confidence,
    candidates: candidatesFromJSON(row.candidates),
    mediaId: row.media_id,
    libraryId: row.library_id,
    error: row.error,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    media: includeMedia && row.media_id ? getMediaDTO(row.media_id) ?? null : null,
  };
}

export function getItemDTO(id: number, includeMedia = true): IngestItemDTO {
  const row = getItemRow(id);
  if (!row) throw ingestError(`Ingest item ${id} does not exist`, 'not_found');
  return itemToDTO(row, undefined, includeMedia);
}

export interface SourceInput {
  name?: unknown;
  kind?: unknown;
  path?: unknown;
  libraryId?: unknown;
  action?: unknown;
  autoMatch?: unknown;
  minConfidence?: unknown;
  holdUnmatched?: unknown;
  recursive?: unknown;
  settleSeconds?: unknown;
  enabled?: unknown;
}

function boolInput(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw ingestError(`${field} must be a boolean`);
  return value;
}

function numberInput(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw ingestError(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

function validateSourcePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw ingestError('path is required');
  if (raw.includes('\0')) throw ingestError('Path contains a null byte');
  if (!path.isAbsolute(raw.trim())) throw ingestError('Source path must be absolute');
  const resolved = path.resolve(raw.trim());
  const canonical = canonicalPath(resolved);
  if (resolved === path.resolve(config.dbPath) || canonical === canonicalPath(config.dbPath)) throw ingestError('Source path cannot be the database file');
  if (resolved === path.resolve(config.dataDir) || canonical === canonicalPath(config.dataDir)) throw ingestError('Source path cannot be the app data root');
  for (const [label, restricted] of [['cache', paths.cache], ['temp', paths.temp]] as const) {
    if (isInside(resolved, restricted) || isInside(canonical, canonicalPath(restricted))) {
      throw ingestError(`Source path cannot live inside the ${label} directory`);
    }
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw ingestError(`Source path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw ingestError('Source path must be a directory');
  return resolved;
}

function validateLibraryId(raw: unknown, kind: IngestKind): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ingestError('libraryId must be a positive integer or null');
  const row = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(id) as LibraryRow | undefined;
  if (!row) throw ingestError(`Library ${id} does not exist`, 'not_found');
  if (!libraryMatchesKind(row, kind)) throw ingestError(`Library "${row.name}" is ${row.kind}; it cannot receive ${kind}`);
  return row.id;
}

function validateKind(raw: unknown): IngestKind {
  if (typeof raw !== 'string' || !(INGEST_KINDS as string[]).includes(raw)) {
    throw ingestError(`kind must be one of: ${INGEST_KINDS.join(', ')}`);
  }
  return raw as IngestKind;
}

/** Validate a source create/patch, rejecting unsafe paths and destination loops. */
export function validateSource(sourcePath: string, kind: IngestKind, libraryId: number | null): void {
  try {
    if (libraryId !== null) {
      const library = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId) as LibraryRow | undefined;
      if (library) assertNoLoop(sourcePath, library.path);
      return;
    }
    const preview = previewDestination({ library_id: null, kind });
    assertNoLoop(sourcePath, preview.path);
    for (const row of getDb().prepare('SELECT path FROM libraries WHERE kind = ?').all(kind) as { path: string }[]) {
      assertNoLoop(sourcePath, row.path);
    }
  } catch (error) {
    throw ingestError(errorMessage(error), 'bad_request');
  }
}

export function createSource(input: SourceInput): IngestSourceDTO {
  const kind = validateKind(input.kind);
  const sourcePath = validateSourcePath(input.path);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw ingestError('name must be 1-120 characters');
  const libraryId = validateLibraryId(input.libraryId, kind);
  validateSource(sourcePath, kind, libraryId);
  const duplicate = getDb().prepare('SELECT id FROM ingest_sources WHERE path = ?').get(sourcePath) as { id: number } | undefined;
  if (duplicate) throw ingestError(`That source path is already source #${duplicate.id}`, 'conflict');
  const actionRaw = input.action === undefined ? 'move' : input.action;
  if (typeof actionRaw !== 'string' || !(INGEST_ACTIONS as string[]).includes(actionRaw)) {
    throw ingestError(`action must be one of: ${INGEST_ACTIONS.join(', ')}`);
  }
  const autoMatch = boolInput(input.autoMatch, 'autoMatch', true);
  const holdUnmatched = boolInput(input.holdUnmatched, 'holdUnmatched', true);
  const recursive = boolInput(input.recursive, 'recursive', true);
  const enabled = boolInput(input.enabled, 'enabled', true);
  const minConfidence = numberInput(input.minConfidence, 'minConfidence', 0.5, 0, 1);
  const settleSeconds = Math.trunc(numberInput(input.settleSeconds, 'settleSeconds', 15, 0, 3600));
  const timestamp = nowISO();
  const info = getDb()
    .prepare(
      `INSERT INTO ingest_sources(name, kind, path, library_id, action, auto_match, min_confidence, hold_unmatched, recursive, settle_seconds, enabled, settings, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(name, kind, sourcePath, libraryId, actionRaw, autoMatch ? 1 : 0, minConfidence, holdUnmatched ? 1 : 0, recursive ? 1 : 0, settleSeconds, enabled ? 1 : 0, timestamp, timestamp);
  fs.mkdirSync(sourcePath, { recursive: true });
  return sourceToDTO(requireSource(Number(info.lastInsertRowid)));
}

export function updateSource(id: number, input: SourceInput): IngestSourceDTO {
  const existing = requireSource(id);
  const kind = input.kind === undefined ? existing.kind : validateKind(input.kind);
  const sourcePath = input.path === undefined ? existing.path : validateSourcePath(input.path);
  const requestedLibrary = input.libraryId === undefined ? existing.library_id : input.libraryId;
  const libraryId = requestedLibrary === null ? null : validateLibraryId(requestedLibrary, kind);
  const name = input.name === undefined ? existing.name : typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw ingestError('name must be 1-120 characters');
  validateSource(sourcePath, kind, libraryId);
  const duplicate = getDb().prepare('SELECT id FROM ingest_sources WHERE path = ? AND id != ?').get(sourcePath, id) as { id: number } | undefined;
  if (duplicate) throw ingestError(`That source path is already source #${duplicate.id}`, 'conflict');
  const actionRaw = input.action === undefined ? existing.action : input.action;
  if (typeof actionRaw !== 'string' || !(INGEST_ACTIONS as string[]).includes(actionRaw)) {
    throw ingestError(`action must be one of: ${INGEST_ACTIONS.join(', ')}`);
  }
  const autoMatch = boolInput(input.autoMatch, 'autoMatch', existing.auto_match === 1);
  const holdUnmatched = boolInput(input.holdUnmatched, 'holdUnmatched', existing.hold_unmatched === 1);
  const recursive = boolInput(input.recursive, 'recursive', existing.recursive === 1);
  const enabled = boolInput(input.enabled, 'enabled', existing.enabled === 1);
  const minConfidence = numberInput(input.minConfidence, 'minConfidence', existing.min_confidence, 0, 1);
  const settleSeconds = Math.trunc(numberInput(input.settleSeconds, 'settleSeconds', existing.settle_seconds, 0, 3600));
  getDb()
    .prepare(
      `UPDATE ingest_sources SET name = ?, kind = ?, path = ?, library_id = ?, action = ?, auto_match = ?, min_confidence = ?,
       hold_unmatched = ?, recursive = ?, settle_seconds = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .run(name, kind, sourcePath, libraryId, actionRaw, autoMatch ? 1 : 0, minConfidence, holdUnmatched ? 1 : 0, recursive ? 1 : 0, settleSeconds, enabled ? 1 : 0, nowISO(), id);
  return sourceToDTO(requireSource(id));
}

export function deleteSource(id: number): { ok: true; sourceId: number; removedItems: number } {
  requireSource(id);
  const removedItems = (getDb().prepare('SELECT COUNT(*) AS n FROM ingest_items WHERE source_id = ?').get(id) as { n: number }).n;
  getDb().prepare('DELETE FROM ingest_sources WHERE id = ?').run(id);
  bus.publish('ingest.source', { sourceId: id, removed: true });
  return { ok: true, sourceId: id, removedItems };
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

export interface IngestStats {
  counts: IngestSourceStats & { total: number };
  sources: number;
  enabledSources: number;
  watcher: { enabled: boolean; intervalSeconds: number; activeJobId: string | null };
  recentOrganized: IngestItemDTO[];
  recentErrors: IngestItemDTO[];
  providers: ProviderStatus[];
}

export function ingestStats(): IngestStats {
  const db = getDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM ingest_items GROUP BY status').all() as { status: IngestStatus; n: number }[];
  const counts: IngestSourceStats & { total: number } = { pending: 0, review: 0, organized: 0, error: 0, ignored: 0, total: 0 };
  for (const row of rows) {
    counts[row.status] = row.n;
    counts.total += row.n;
  }
  const sources = (db.prepare('SELECT COUNT(*) AS n FROM ingest_sources').get() as { n: number }).n;
  const enabledSources = (db.prepare('SELECT COUNT(*) AS n FROM ingest_sources WHERE enabled = 1').get() as { n: number }).n;
  const active = activeIngestJob();
  const recent = (status: IngestStatus): IngestItemDTO[] => {
    const items = db.prepare('SELECT * FROM ingest_items WHERE status = ? ORDER BY updated_at DESC LIMIT 8').all(status) as IngestItemRow[];
    return items.map((row) => itemToDTO(row));
  };
  return {
    counts,
    sources,
    enabledSources,
    watcher: {
      enabled: settings.get('ingestWatch'),
      intervalSeconds: clampInterval(settings.get('ingestIntervalSeconds')),
      activeJobId: active?.id ?? null,
    },
    recentOrganized: recent('organized'),
    recentErrors: recent('error'),
    providers: providerStatuses(),
  };
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(3600, Math.max(5, Math.trunc(value)));
}

/* ------------------------------------------------------------------ */
/* Jobs + watcher                                                      */
/* ------------------------------------------------------------------ */

export interface IngestRunCounts {
  sources: number;
  discovered: number;
  processed: number;
  organized: number;
  review: number;
  errors: number;
  skipped: number;
  mapped: number;
  scannedLibraries: number[];
  deferredLibraries: number[];
}

export function activeIngestJob(): JobDTO | undefined {
  const rows = getDb().prepare("SELECT * FROM jobs WHERE type = 'ingest' AND status IN ('queued','running') ORDER BY created_at LIMIT 5").all() as {
    id: string;
    type: 'ingest';
    payload: string;
    status: string;
    progress: number;
    message: string;
    result: string | null;
    error: string | null;
    created_by: number | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
  }[];
  const row = rows[0];
  if (!row) return undefined;
  return jobQueue.get(row.id);
}

export function enqueueIngest(sourceId?: number, createdBy?: number): JobDTO {
  if (sourceId !== undefined) requireSource(sourceId);
  const active = activeIngestJob();
  if (active) {
    const error = ingestError('An ingest job is already queued or running', 'ingest_in_progress') as Error & { jobId?: string };
    error.jobId = active.id;
    throw error;
  }
  const payload: Record<string, unknown> = { scope: 'all' };
  if (sourceId !== undefined) payload.sourceId = sourceId;
  return jobQueue.create('ingest', payload, createdBy);
}

function pendingItemsFor(sources: IngestSourceRow[], limit: number): IngestItemRow[] {
  if (sources.length === 0) return [];
  const placeholders = sources.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM ingest_items WHERE status = 'pending' AND source_id IN (${placeholders}) ORDER BY id LIMIT ?`)
    .all(...sources.map((source) => source.id), limit) as IngestItemRow[];
}

function saveSourceResult(source: IngestSourceRow, summary: IngestRunCounts): void {
  getDb()
    .prepare('UPDATE ingest_sources SET last_result = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...summary, finishedAt: nowISO() }).slice(0, 4000), nowISO(), source.id);
}

export async function processIngestJob(ctx: JobContext): Promise<IngestRunCounts> {
  const db = getDb();
  clearNfoCache();
  const payloadSource = ctx.payload.sourceId !== undefined ? Number(ctx.payload.sourceId) : null;
  let sources: IngestSourceRow[];
  if (payloadSource !== null && Number.isInteger(payloadSource) && payloadSource > 0) {
    const row = getSourceRow(payloadSource);
    sources = row ? [row] : [];
  } else {
    sources = db.prepare('SELECT * FROM ingest_sources WHERE enabled = 1 ORDER BY id').all() as IngestSourceRow[];
  }
  const counts: IngestRunCounts = {
    sources: sources.length,
    discovered: 0,
    processed: 0,
    organized: 0,
    review: 0,
    errors: 0,
    skipped: 0,
    mapped: 0,
    scannedLibraries: [],
    deferredLibraries: [],
  };
  if (sources.length === 0) {
    ctx.update(1, 'No ingest sources enabled. Nothing to chew on.');
    return counts;
  }
  const discoveries = new Map<number, DiscoveryResult>();
  for (let index = 0; index < sources.length; index += 1) {
    if (ctx.cancelled()) break;
    const source = sources[index];
    ctx.update(Math.min(0.1, (index / sources.length) * 0.1), `Discovering ${source.name}`);
    try {
      const discovery = discoverItems(source);
      discoveries.set(source.id, discovery);
      counts.discovered += discovery.added + discovery.updated;
      counts.skipped += discovery.skipped;
      bus.publish('ingest.progress', {
        sourceId: source.id,
        processed: 0,
        total: discovery.added + discovery.updated,
        message: `Found ${discovery.added} new, ${discovery.updated} changed`,
        status: 'discovering',
      });
    } catch (error) {
      counts.errors += 1;
      logger.warn('ingest', `Discovery failed for "${source.name}": ${errorMessage(error)}`);
    }
  }

  const pending = pendingItemsFor(sources, INGEST_LIMITS.maxNewItemsPerPass);
  let processed = 0;
  const processedSourceIds = new Set<number>();
  for (const item of pending) {
    if (ctx.cancelled()) break;
    processedSourceIds.add(item.source_id);
    try {
      const outcome = await processItem(item.id, { triggerScan: false });
      counts.processed += 1;
      if (outcome.status === 'organized') counts.organized += 1;
      else if (outcome.status === 'review') counts.review += 1;
      else if (outcome.status === 'error') counts.errors += 1;
      else counts.skipped += 1;
    } catch (error) {
      counts.errors += 1;
      updateItem(item.id, { status: 'error', error: errorMessage(error).slice(0, 1000) });
      publishItem(requireItem(item.id));
      logger.warn('ingest', `Item ${item.id} failed: ${errorMessage(error)}`);
    }
    processed += 1;
    const progress = 0.1 + (pending.length > 0 ? (processed / pending.length) * 0.6 : 0.6);
    ctx.update(progress, `Processed ${processed}/${pending.length}`);
    bus.publish('ingest.progress', {
      sourceId: item.source_id,
      processed,
      total: pending.length,
      message: `Processed ${processed}/${pending.length}`,
      status: 'processing',
    });
  }

  ctx.update(0.75, 'Indexing organized items');
  const indexed = await indexOrganizedItems();
  counts.mapped = indexed.mapped;
  counts.scannedLibraries = indexed.scanned;
  counts.deferredLibraries = indexed.deferred;

  for (const source of sources) {
    if (!processedSourceIds.has(source.id) && !discoveries.has(source.id)) continue;
    const discovery = discoveries.get(source.id);
    const sourceItems = pending.filter((item) => item.source_id === source.id);
    saveSourceResult(source, {
      ...counts,
      sources: 1,
      discovered: discovery ? discovery.added + discovery.updated : 0,
      processed: sourceItems.length,
      organized: sourceItems.filter((item) => getItemRow(item.id)?.status === 'organized').length,
      review: sourceItems.filter((item) => getItemRow(item.id)?.status === 'review').length,
    });
  }

  ctx.update(1, `Ingest done: ${counts.organized} organized, ${counts.review} in review, ${counts.errors} errors`);
  bus.publish('ingest.progress', {
    processed: counts.processed,
    total: counts.processed,
    message: `Ingest done: ${counts.organized} organized, ${counts.review} need review`,
    status: ctx.cancelled() ? 'cancelled' : 'done',
  });
  logger.info('ingest', 'Ingest job finished', { ...counts });
  return counts;
}

/** Synchronous discover + process pass for one source (used by tests and scripts). */
export async function scanSource(id: number): Promise<IngestRunCounts> {
  const source = requireSource(id);
  clearNfoCache();
  const discovery = discoverItems(source);
  const pending = pendingItemsFor([source], INGEST_LIMITS.maxNewItemsPerPass);
  const counts: IngestRunCounts = {
    sources: 1,
    discovered: discovery.added + discovery.updated,
    processed: 0,
    organized: 0,
    review: 0,
    errors: 0,
    skipped: discovery.skipped,
    mapped: 0,
    scannedLibraries: [],
    deferredLibraries: [],
  };
  for (const item of pending) {
    try {
      const outcome = await processItem(item.id, { triggerScan: false });
      counts.processed += 1;
      if (outcome.status === 'organized') counts.organized += 1;
      else if (outcome.status === 'review') counts.review += 1;
      else counts.skipped += 1;
    } catch (error) {
      counts.errors += 1;
      updateItem(item.id, { status: 'error', error: errorMessage(error).slice(0, 1000) });
    }
  }
  const indexed = await indexOrganizedItems();
  counts.mapped = indexed.mapped;
  counts.scannedLibraries = indexed.scanned;
  counts.deferredLibraries = indexed.deferred;
  saveSourceResult(source, counts);
  return counts;
}

let watcherTimer: NodeJS.Timeout | undefined;

/** Cheap discovery pass so an idle box does not generate an empty job every tick. */
function watcherHasWork(): boolean {
  if (activeIngestJob()) return false;
  const sources = getDb().prepare('SELECT * FROM ingest_sources WHERE enabled = 1').all() as IngestSourceRow[];
  let pending = 0;
  for (const source of sources) {
    try {
      const discovery = discoverItems(source);
      if (discovery.added > 0 || discovery.updated > 0) return true;
    } catch (error) {
      logger.debug('ingest', `Watcher could not inspect "${source.name}": ${errorMessage(error)}`);
    }
  }
  if (sources.length > 0) {
    const placeholders = sources.map(() => '?').join(',');
    pending = (getDb()
      .prepare(`SELECT COUNT(*) AS n FROM ingest_items WHERE status = 'pending' AND source_id IN (${placeholders})`)
      .get(...sources.map((source) => source.id)) as { n: number }).n;
  }
  return pending > 0;
}

function scheduleWatcher(): void {
  clearTimeout(watcherTimer);
  const interval = clampInterval(settings.get('ingestIntervalSeconds'));
  watcherTimer = setTimeout(() => {
    watcherTimer = undefined;
    try {
      if (settings.get('ingestWatch') === true && watcherHasWork()) {
        enqueueIngest();
      }
    } catch (error) {
      logger.debug('ingest', `Watcher skipped a tick: ${errorMessage(error)}`);
    }
    scheduleWatcher();
  }, interval * 1000);
  watcherTimer.unref();
}

/** Start the interval watcher; idempotent. Options are read fresh on every tick. */
export function startIngestWatcher(): void {
  if (watcherTimer) return;
  ensureDefaultSources();
  scheduleWatcher();
}

export function stopIngestWatcher(): void {
  clearTimeout(watcherTimer);
  watcherTimer = undefined;
}

jobQueue.registerHandler('ingest', processIngestJob);
const ingestBootTimer = setTimeout(() => {
  try {
    startIngestWatcher();
  } catch (error) {
    logger.warn('ingest', `Ingest watcher boot skipped: ${errorMessage(error)}`);
  }
}, 1500);
ingestBootTimer.unref();


