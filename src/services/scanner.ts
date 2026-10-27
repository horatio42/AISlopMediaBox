import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { getDb, nowISO, settings } from '../db.ts';
import { bus, logger } from '../lib/logger.ts';
import { jobQueue } from './jobs.ts';
import type { JobDTO, LibraryRow, MediaKind, MediaRow } from '../types.ts';
import {
  classifyExtension,
  findNfo,
  parseEpisodeFilename,
  parseMovieFilename,
  parseSeasonFolder,
  parseTrackFilename,
  stripExtension,
} from './metadata.ts';
import type { NfoMetadata, ResolvedMetadata } from './metadata.ts';
import { resolveProvider, searchProviders } from './providers.ts';
import type { ProviderId, ProviderResolved } from './providers.ts';
import { chaptersOf, audioTracksOf, probeFile } from './ffprobe.ts';
import type { ProbeResult } from './ffprobe.ts';
import { downloadRemoteArt, ensureArtForMedia, purgeArtForMedia } from './artwork.ts';

/* ------------------------------------------------------------------ */
/* Path walking                                                        */
/* ------------------------------------------------------------------ */

const SKIP_DIRS: Record<string, true> = Object.fromEntries(
  ['@eaDir', '#recycle', '.git', '.svn', 'node_modules', 'lost+found', '$RECYCLE.BIN', 'System Volume Information', '.Trash', '.Trashes', '.stfolder'].map(
    (name) => [name, true as const],
  ),
);

export interface WalkedFile {
  path: string;
  name: string;
  dir: string;
  rel: string;
  stat: fs.Stats;
}

export interface WalkResult {
  files: WalkedFile[];
  dirs: string[];
  warnings: string[];
}

/** Recursive walk with depth, entry and symlink-loop guards. */
export function walkLibrary(root: string): WalkResult {
  const files: WalkedFile[] = [];
  const dirs: string[] = [];
  const warnings: string[] = [];
  const visited = new Set<string>();
  let entries = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > 32) {
      warnings.push(`Depth limit reached at ${dir}`);
      return;
    }
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      warnings.push(`Cannot read ${dir}: ${(error as Error).message}`);
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIRS[name]) continue;
      const full = path.join(dir, name);
      entries += 1;
      if (entries > 250_000) {
        warnings.push('Walk entry limit reached; stopping early');
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) {
          const target = fs.statSync(full);
          if (target.isDirectory()) stat = target;
          else if (target.isFile()) stat = target;
        }
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        dirs.push(full);
        walk(full, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size === 0) continue;
      files.push({ path: full, name, dir, rel: path.relative(root, full), stat });
    }
  };
  walk(root, 0);
  return { files, dirs, warnings };
}

export function sortTitle(title: string): string {
  const cleaned = title.trim().toLowerCase();
  return cleaned.replace(/^(the|an|a)\s+/, '');
}

/* ------------------------------------------------------------------ */
/* Media rows                                                          */
/* ------------------------------------------------------------------ */

export interface MediaInput {
  libraryId: number;
  kind: MediaKind;
  title: string;
  path: string;
  folderPath: string | null;
  originalTitle?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  description?: string;
  tagline?: string | null;
  rating?: number | null;
  contentRating?: string | null;
  runtimeSeconds?: number | null;
  container?: string | null;
  sizeBytes?: number | null;
  mtime?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  fps?: number | null;
  audioTracks?: string;
  chapters?: string;
  parentId?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  albumId?: number | null;
  artistId?: number | null;
  metadataProvider?: string | null;
  metadataId?: string | null;
  matchScore?: number | null;
}

export interface UpsertOutcome {
  id: number;
  created: boolean;
  locked: boolean;
}

/** Insert or update one media row addressed by its unique path. */
export function upsertMedia(input: MediaInput): UpsertOutcome {
  const db = getDb();
  const now = nowISO();
  const existing = db.prepare('SELECT * FROM media WHERE path = ?').get(input.path) as MediaRow | undefined;
  const locked = existing?.metadata_locked === 1;
  const base = {
    library_id: input.libraryId,
    kind: input.kind,
    title: locked && existing ? existing.title : input.title,
    sort_title: sortTitle(locked && existing ? existing.title : input.title),
    original_title: locked && existing ? existing.original_title : (input.originalTitle ?? null),
    year: locked && existing ? existing.year : (input.year ?? null),
    release_date: locked && existing ? existing.release_date : (input.releaseDate ?? null),
    description: locked && existing ? existing.description : (input.description ?? ''),
    tagline: locked && existing ? existing.tagline : (input.tagline ?? null),
    rating: locked && existing ? existing.rating : (input.rating ?? null),
    content_rating: locked && existing ? existing.content_rating : (input.contentRating ?? null),
    runtime_seconds: input.runtimeSeconds ?? existing?.runtime_seconds ?? null,
    path: input.path,
    folder_path: input.folderPath,
    container: input.container ?? existing?.container ?? null,
    size_bytes: input.sizeBytes ?? existing?.size_bytes ?? null,
    mtime: input.mtime ?? existing?.mtime ?? null,
    video_codec: input.videoCodec ?? null,
    audio_codec: input.audioCodec ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    bitrate: input.bitrate ?? null,
    fps: input.fps ?? null,
    audio_tracks: input.audioTracks ?? '[]',
    chapters: input.chapters ?? '[]',
    parent_id: input.parentId ?? null,
    season_number: input.seasonNumber ?? null,
    episode_number: input.episodeNumber ?? null,
    track_number: input.trackNumber ?? null,
    disc_number: input.discNumber ?? null,
    album_id: input.albumId ?? null,
    artist_id: input.artistId ?? null,
    metadata_provider: locked && existing ? existing.metadata_provider : (input.metadataProvider ?? null),
    metadata_id: locked && existing ? existing.metadata_id : (input.metadataId ?? null),
    match_score: locked && existing ? existing.match_score : (input.matchScore ?? null),
    hidden: 0,
    updated_at: now,
  };
  if (existing) {
    db.prepare(
      `UPDATE media SET library_id=@library_id, kind=@kind, title=@title, sort_title=@sort_title,
        original_title=@original_title, year=@year, release_date=@release_date, description=@description,
        tagline=@tagline, rating=@rating, content_rating=@content_rating, runtime_seconds=@runtime_seconds,
        folder_path=@folder_path, container=@container, size_bytes=@size_bytes, mtime=@mtime,
        video_codec=@video_codec, audio_codec=@audio_codec, width=@width, height=@height, bitrate=@bitrate,
        fps=@fps, audio_tracks=@audio_tracks, chapters=@chapters, parent_id=@parent_id,
        season_number=@season_number, episode_number=@episode_number, track_number=@track_number,
        disc_number=@disc_number, album_id=@album_id, artist_id=@artist_id,
        metadata_provider=@metadata_provider, metadata_id=@metadata_id, match_score=@match_score,
        hidden=@hidden, updated_at=@updated_at
       WHERE id=@id`,
    ).run({ ...base, id: existing.id });
    return { id: existing.id, created: false, locked };
  }
  const info = db
    .prepare(
      `INSERT INTO media(library_id, kind, title, sort_title, original_title, year, release_date, description,
        tagline, rating, content_rating, runtime_seconds, path, folder_path, container, size_bytes, mtime,
        video_codec, audio_codec, width, height, bitrate, fps, audio_tracks, chapters, parent_id,
        season_number, episode_number, track_number, disc_number, album_id, artist_id,
        metadata_provider, metadata_id, match_score, hidden, added_at, updated_at)
       VALUES(@library_id, @kind, @title, @sort_title, @original_title, @year, @release_date, @description,
        @tagline, @rating, @content_rating, @runtime_seconds, @path, @folder_path, @container, @size_bytes, @mtime,
        @video_codec, @audio_codec, @width, @height, @bitrate, @fps, @audio_tracks, @chapters, @parent_id,
        @season_number, @episode_number, @track_number, @disc_number, @album_id, @artist_id,
        @metadata_provider, @metadata_id, @match_score, @hidden, @added_at_iso, @updated_at)`,
    )
    .run({ ...base, added_at_iso: now });
  return { id: Number(info.lastInsertRowid), created: true, locked: false };
}

/* ------------------------------------------------------------------ */
/* Metadata, genres, people, subtitles                                 */
/* ------------------------------------------------------------------ */

export interface Enrichment {
  title?: string;
  originalTitle?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  description?: string;
  tagline?: string | null;
  rating?: number | null;
  contentRating?: string | null;
  runtimeSeconds?: number | null;
  genres: string[];
  tags: string[];
  people: { name: string; role: string; character?: string | null }[];
  provider?: string | null;
  providerId?: string | null;
  matchScore?: number | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
}

const LANGUAGES: Record<string, string> = {
  en: 'English', eng: 'English', fr: 'French', fre: 'French', de: 'German', ger: 'German',
  es: 'Spanish', spa: 'Spanish', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ru: 'Russian', rus: 'Russian', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', hi: 'Hindi', hin: 'Hindi', ar: 'Arabic', ara: 'Arabic',
  nl: 'Dutch', dut: 'Dutch', pl: 'Polish', pol: 'Polish', tr: 'Turkish', tur: 'Turkish',
  sv: 'Swedish', swe: 'Swedish', no: 'Norwegian', nor: 'Norwegian', da: 'Danish', dan: 'Danish',
  fi: 'Finnish', fin: 'Finnish', und: 'Unknown',
};

export function languageName(code: string): string {
  return LANGUAGES[code.toLowerCase()] || code.toUpperCase();
}

function replaceGenres(mediaId: number, genres: string[]): void {
  const db = getDb();
  db.prepare('DELETE FROM media_genres WHERE media_id = ?').run(mediaId);
  const insert = db.prepare('INSERT OR IGNORE INTO media_genres(media_id, genre) VALUES(?, ?)');
  const seen = new Set<string>();
  for (const genre of genres) {
    const clean = genre.trim().slice(0, 60);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    insert.run(mediaId, clean);
  }
}

function replaceTags(mediaId: number, tags: string[]): void {
  const db = getDb();
  db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(mediaId);
  const insert = db.prepare('INSERT OR IGNORE INTO media_tags(media_id, tag) VALUES(?, ?)');
  for (const tag of tags) {
    const clean = tag.trim().slice(0, 60);
    if (clean) insert.run(mediaId, clean);
  }
}

function replacePeople(mediaId: number, people: { name: string; role: string; character?: string | null }[]): void {
  const db = getDb();
  db.prepare('DELETE FROM media_people WHERE media_id = ?').run(mediaId);
  const insert = db.prepare('INSERT INTO media_people(media_id, name, role, character, ord) VALUES(?, ?, ?, ?, ?)');
  people.slice(0, 80).forEach((person, index) => {
    const name = person.name.trim().slice(0, 120);
    if (!name) return;
    insert.run(mediaId, name, person.role || 'cast', person.character ? person.character.slice(0, 200) : null, index);
  });
}

/** Apply enrichment unless the row is metadata-locked. Returns false when locked. */
export function applyEnrichment(mediaId: number, enrichment: Enrichment, force = false): boolean {
  const db = getDb();
  const row = db.prepare('SELECT metadata_locked FROM media WHERE id = ?').get(mediaId) as { metadata_locked: number } | undefined;
  if (!row) return false;
  if (row.metadata_locked === 1 && !force) return false;
  db.prepare(
    `UPDATE media SET
      title = COALESCE(@title, title), sort_title = COALESCE(@sort_title, sort_title),
      original_title = COALESCE(@original_title, original_title), year = COALESCE(@year, year),
      release_date = COALESCE(@release_date, release_date), description = CASE WHEN @description != '' THEN @description ELSE description END,
      tagline = COALESCE(@tagline, tagline), rating = COALESCE(@rating, rating),
      content_rating = COALESCE(@content_rating, content_rating),
      runtime_seconds = CASE WHEN runtime_seconds IS NULL THEN COALESCE(@runtime_seconds, runtime_seconds) ELSE runtime_seconds END,
      metadata_provider = COALESCE(@provider, metadata_provider), metadata_id = COALESCE(@provider_id, metadata_id),
      match_score = COALESCE(@match_score, match_score), updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id: mediaId,
    title: enrichment.title ?? null,
    sort_title: enrichment.title ? sortTitle(enrichment.title) : null,
    original_title: enrichment.originalTitle ?? null,
    year: enrichment.year ?? null,
    release_date: enrichment.releaseDate ?? null,
    description: enrichment.description ?? '',
    tagline: enrichment.tagline ?? null,
    rating: enrichment.rating ?? null,
    content_rating: enrichment.contentRating ?? null,
    runtime_seconds: enrichment.runtimeSeconds ?? null,
    provider: enrichment.provider ?? null,
    provider_id: enrichment.providerId ?? null,
    match_score: enrichment.matchScore ?? null,
    updated_at: nowISO(),
  });
  if (enrichment.genres.length) replaceGenres(mediaId, enrichment.genres);
  if (enrichment.tags.length) replaceTags(mediaId, enrichment.tags);
  if (enrichment.people.length) replacePeople(mediaId, enrichment.people);
  return true;
}

export interface SubtitleInput {
  language: string;
  label: string;
  format: string;
  isExternal: boolean;
  path: string | null;
  streamIndex: number | null;
  forced: boolean;
}

function formatFromCodec(codec: string): string {
  if (codec.includes('ass') || codec.includes('ssa')) return 'ass';
  if (codec.includes('webvtt') || codec.includes('vtt')) return 'vtt';
  return 'srt';
}

export function discoverExternalSubtitles(videoPath: string, allowGenericMovie: boolean): SubtitleInput[] {
  const dir = path.dirname(videoPath);
  const base = stripExtension(path.basename(videoPath)).toLowerCase();
  const results: SubtitleInput[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return results;
  }
  for (const name of names) {
    if (classifyExtension(name) !== 'subtitle') continue;
    const stem = stripExtension(name);
    const lower = stem.toLowerCase();
    let suffix: string | null = null;
    if (lower === base) suffix = '';
    else if (lower.startsWith(`${base}.`)) suffix = lower.slice(base.length + 1);
    else if (allowGenericMovie && (lower === 'movie' || lower.startsWith('movie.'))) suffix = lower === 'movie' ? '' : lower.slice(6);
    if (suffix === null) continue;
    const tokens = suffix.split('.').filter(Boolean);
    const forced = tokens.includes('forced');
    const languageToken = tokens.find((token) => token !== 'forced' && token !== 'sdh' && token !== 'cc' && /^[a-z]{2,3}$/.test(token));
    const language = languageToken || config.defaultLanguage || 'en';
    results.push({
      language,
      label: `${languageName(language)}${forced ? ' (forced)' : ''}${tokens.includes('sdh') ? ' (SDH)' : ''}`,
      format: path.extname(name).slice(1).toLowerCase(),
      isExternal: true,
      path: path.join(dir, name),
      streamIndex: null,
      forced,
    });
  }
  return results;
}

export function embeddedSubtitles(probe: ProbeResult): SubtitleInput[] {
  return probe.subtitles.map((stream) => ({
    language: stream.language,
    label: `${languageName(stream.language)}${stream.title ? ` — ${stream.title}` : ''}${stream.forced ? ' (forced)' : ''}`,
    format: formatFromCodec(stream.codec),
    isExternal: false,
    path: null,
    streamIndex: stream.index,
    forced: stream.forced,
  }));
}

export function storeSubtitles(mediaId: number, rows: SubtitleInput[]): void {
  const db = getDb();
  db.prepare('DELETE FROM subtitles WHERE media_id = ?').run(mediaId);
  const insert = db.prepare(
    `INSERT INTO subtitles(media_id, language, label, format, is_external, path, stream_index, forced, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(mediaId, row.language.slice(0, 12), row.label.slice(0, 120), row.format.slice(0, 12), row.isExternal ? 1 : 0, row.path, row.streamIndex, row.forced ? 1 : 0, nowISO());
  }
}

export interface ProbeFields {
  container: string | null;
  sizeBytes: number | null;
  runtimeSeconds: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  fps: number | null;
  audioTracks: string;
  chapters: string;
}

export function fieldsFromProbe(probe: ProbeResult, kind: MediaKind): ProbeFields {
  return {
    container: probe.container,
    sizeBytes: probe.sizeBytes,
    runtimeSeconds: probe.durationSeconds,
    videoCodec: kind === 'track' ? null : probe.video?.codec ?? null,
    audioCodec: probe.audio[0]?.codec ?? null,
    width: kind === 'track' ? null : probe.video?.width ?? null,
    height: kind === 'track' ? null : probe.video?.height ?? null,
    bitrate: probe.bitrate,
    fps: kind === 'track' ? null : probe.video?.fps ?? null,
    audioTracks: JSON.stringify(kind === 'track' ? [] : audioTracksOf(probe)),
    chapters: JSON.stringify(kind === 'track' ? [] : chaptersOf(probe)),
  };
}

/* ------------------------------------------------------------------ */
/* Scan state                                                          */
/* ------------------------------------------------------------------ */

const activeScans = new Map<number, { startedAt: string }>();
const cancelRequests = new Set<number>();

interface ScanState {
  library: LibraryRow;
  seen: Set<string>;
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  hidden: number;
  errors: string[];
  total: number;
  done: number;
  lastEmit: number;
  onProgress?: (progress: number, message: string) => void;
  cancelled: () => boolean;
  librarySettings: Record<string, unknown>;
}

function warn(state: ScanState, message: string): void {
  const line = message.slice(0, 500);
  state.errors.push(line);
  if (state.errors.length <= 100) logger.warn('scanner', line);
}

function tick(state: ScanState, message: string, force = false): void {
  state.done += 1;
  const progress = state.total > 0 ? Math.min(0.99, state.done / state.total) : 0;
  state.onProgress?.(progress, message);
  const now = Date.now();
  if (!force && now - state.lastEmit < 150) return;
  state.lastEmit = now;
  bus.publish('scan.progress', {
    libraryId: state.library.id,
    libraryName: state.library.name,
    status: 'running',
    progress,
    message,
    active: activeScans.size,
    processed: state.done,
    total: state.total,
  });
}

function isUnchanged(existing: MediaRow | undefined, stat: fs.Stats): boolean {
  if (!existing || existing.hidden === 1) return false;
  return existing.size_bytes === stat.size && existing.mtime === Math.floor(stat.mtimeMs);
}

function existingByPath(filePath: string): MediaRow | undefined {
  return getDb().prepare('SELECT * FROM media WHERE path = ?').get(filePath) as MediaRow | undefined;
}

async function probeOrWarn(filePath: string, state: ScanState): Promise<ProbeResult | null> {
  try {
    return await probeFile(filePath);
  } catch (error) {
    warn(state, `${path.basename(filePath)}: ${(error as Error).message}`);
    return null;
  }
}

function mergeLocal(root: NfoMetadata | null, title: string, year: number | null): Enrichment {
  return {
    title: root?.title || title,
    originalTitle: root?.originalTitle ?? null,
    year: root?.year ?? year,
    releaseDate: root?.releaseDate ?? null,
    description: root?.description || '',
    tagline: root?.tagline ?? null,
    rating: root?.rating ?? null,
    contentRating: root?.contentRating ?? null,
    runtimeSeconds: root?.runtimeSeconds ?? null,
    genres: root?.genres ?? [],
    tags: root?.tags ?? [],
    people: root?.people ?? [],
    provider: root?.provider ?? null,
    providerId: root?.providerId ?? null,
    matchScore: root ? 0.95 : year ? 0.6 : 0.45,
  };
}

function mergeRemote(local: Enrichment, remote: ResolvedMetadata, hasNfo: boolean): Enrichment {
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
    matchScore: Math.max(local.matchScore ?? 0, hasNfo ? 0.95 : remote.matchScore),
    posterUrl: remote.posterUrl,
    backdropUrl: remote.backdropUrl,
  };
}

/** Enrich a movie/show from NFO first, then any opted-in provider. */
async function resolveEnrichment(kind: 'movie' | 'show', filePath: string, title: string, year: number | null, folder: string | null): Promise<{ enrichment: Enrichment; hasNfo: boolean }> {
  const nfoTarget = kind === 'show' && folder ? folder : filePath;
  const nfo = findNfo(nfoTarget, kind);
  const local = mergeLocal(nfo?.metadata ?? null, title, year);
  if (settings.get('autoMatch') === false) return { enrichment: local, hasNfo: Boolean(nfo) };

  let remote: ProviderResolved | null = null;
  const nfoProvider = nfo?.metadata.provider?.toLowerCase();
  if (nfoProvider && nfo?.metadata.providerId) {
    // resolveProvider rejects unknown ids and providers that are not enabled.
    remote = await resolveProvider(nfoProvider as ProviderId, kind, nfo.metadata.providerId, title, year);
  }
  if (!remote) {
    const candidates = await searchProviders(kind, local.title || title, local.year ?? year, { limit: 5 });
    const best = candidates[0];
    if (best && best.score >= 0.55) {
      remote = await resolveProvider(best.provider, kind, best.providerId, local.title || title, local.year ?? year);
    }
  }
  if (!remote) return { enrichment: local, hasNfo: Boolean(nfo) };
  return { enrichment: mergeRemote(local, remote, Boolean(nfo)), hasNfo: Boolean(nfo) };
}


/* ------------------------------------------------------------------ */
/* Movies / loose videos                                               */
/* ------------------------------------------------------------------ */

function videoCountsByDir(files: WalkedFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (classifyExtension(file.name) !== 'video') continue;
    counts.set(file.dir, (counts.get(file.dir) || 0) + 1);
  }
  return counts;
}

async function scanMovies(state: ScanState, files: WalkedFile[]): Promise<void> {
  const videos = files.filter((file) => classifyExtension(file.name) === 'video' && !/^sample([.-]|$)/i.test(file.name));
  const counts = videoCountsByDir(files);
  const pending: WalkedFile[] = [];
  for (const file of videos) {
    state.seen.add(file.path);
    if (isUnchanged(existingByPath(file.path), file.stat)) {
      state.skipped += 1;
      tick(state, `Skipped ${file.name} (unchanged)`);
      continue;
    }
    pending.push(file);
  }
  const batchSize = Math.max(1, config.scanConcurrency);
  for (let index = 0; index < pending.length; index += batchSize) {
    if (state.cancelled()) return;
    const batch = pending.slice(index, index + batchSize);
    const probes = await Promise.all(batch.map((file) => probeOrWarn(file.path, state)));
    for (let i = 0; i < batch.length; i += 1) {
      if (state.cancelled()) return;
      const file = batch[i];
      const probe = probes[i];
      const parsed = parseMovieFilename(file.name);
      const folderParsed = parseMovieFilename(path.basename(file.dir));
      const title = parsed.title === 'Untitled slop' ? folderParsed.title : parsed.title;
      const year = parsed.year ?? folderParsed.year;
      const { enrichment } = await resolveEnrichment('movie', file.path, title, year, file.dir);
      const fields = probe ? fieldsFromProbe(probe, 'movie') : null;
      const outcome = upsertMedia({
        libraryId: state.library.id,
        kind: 'movie',
        title: enrichment.title || title,
        path: file.path,
        folderPath: file.dir,
        year: enrichment.year ?? year,
        originalTitle: enrichment.originalTitle,
        releaseDate: enrichment.releaseDate,
        description: enrichment.description,
        tagline: enrichment.tagline,
        rating: enrichment.rating,
        contentRating: enrichment.contentRating,
        runtimeSeconds: fields?.runtimeSeconds ?? enrichment.runtimeSeconds ?? null,
        container: fields?.container ?? path.extname(file.name).slice(1).toLowerCase(),
        sizeBytes: file.stat.size,
        mtime: Math.floor(file.stat.mtimeMs),
        videoCodec: fields?.videoCodec ?? null,
        audioCodec: fields?.audioCodec ?? null,
        width: fields?.width ?? null,
        height: fields?.height ?? null,
        bitrate: fields?.bitrate ?? null,
        fps: fields?.fps ?? null,
        audioTracks: fields?.audioTracks ?? '[]',
        chapters: fields?.chapters ?? '[]',
        metadataProvider: enrichment.provider,
        metadataId: enrichment.providerId,
        matchScore: enrichment.matchScore,
      });
      if (outcome.created) state.added += 1;
      else state.updated += 1;
      if (!outcome.locked) applyEnrichment(outcome.id, enrichment);
      const subtitles = [
        ...discoverExternalSubtitles(file.path, (counts.get(file.dir) || 0) === 1),
        ...(probe ? embeddedSubtitles(probe) : []),
      ];
      storeSubtitles(outcome.id, subtitles);
      if (!outcome.locked && enrichment.posterUrl) await downloadRemoteArt(outcome.id, 'poster', enrichment.posterUrl, enrichment.provider ?? undefined);
      if (!outcome.locked && enrichment.backdropUrl) await downloadRemoteArt(outcome.id, 'backdrop', enrichment.backdropUrl, enrichment.provider ?? undefined);
      await ensureArtForMedia(outcome.id);
      tick(state, `Scanned ${enrichment.title || title}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shows / seasons / episodes                                          */
/* ------------------------------------------------------------------ */

function seasonFolderOf(fileDir: string, showDir: string): { dir: string; season: number; title: string } | null {
  let current = fileDir;
  while (current !== showDir && current.startsWith(showDir + path.sep)) {
    const parsed = parseSeasonFolder(path.basename(current));
    if (parsed.season !== null) return { dir: current, season: parsed.season, title: parsed.title };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function scanShows(state: ScanState, files: WalkedFile[], dirs: string[]): Promise<void> {
  const showDirs = dirs.filter((dir) => path.dirname(dir) === state.library.path);
  const videosByShow = new Map<string, WalkedFile[]>();
  for (const file of files) {
    if (classifyExtension(file.name) !== 'video') continue;
    const showDir = showDirs.find((dir) => file.path.startsWith(dir + path.sep));
    if (!showDir) {
      warn(state, `Ignoring video outside a show folder: ${file.rel}`);
      continue;
    }
    const list = videosByShow.get(showDir) || [];
    list.push(file);
    videosByShow.set(showDir, list);
  }

  for (const showDir of showDirs) {
    if (state.cancelled()) return;
    const videos = videosByShow.get(showDir) || [];
    if (videos.length === 0) continue;
    state.seen.add(showDir);
    const parsedShow = parseMovieFilename(path.basename(showDir));
    const showTitle = parsedShow.title;
    const showYear = parsedShow.year;
    const { enrichment: showMeta } = await resolveEnrichment('show', showDir, showTitle, showYear, showDir);
    let showStat: fs.Stats | null = null;
    try {
      showStat = fs.statSync(showDir);
    } catch {
      showStat = null;
    }
    const showOutcome = upsertMedia({
      libraryId: state.library.id,
      kind: 'show',
      title: showMeta.title || showTitle,
      path: showDir,
      folderPath: state.library.path,
      year: showMeta.year ?? showYear,
      originalTitle: showMeta.originalTitle,
      releaseDate: showMeta.releaseDate,
      description: showMeta.description,
      tagline: showMeta.tagline,
      rating: showMeta.rating,
      contentRating: showMeta.contentRating,
      runtimeSeconds: showMeta.runtimeSeconds,
      mtime: showStat ? Math.floor(showStat.mtimeMs) : null,
      metadataProvider: showMeta.provider,
      metadataId: showMeta.providerId,
      matchScore: showMeta.matchScore,
    });
    if (!showOutcome.locked) applyEnrichment(showOutcome.id, showMeta);
    if (!showOutcome.locked && showMeta.posterUrl) await downloadRemoteArt(showOutcome.id, 'poster', showMeta.posterUrl, showMeta.provider ?? undefined);
    if (!showOutcome.locked && showMeta.backdropUrl) await downloadRemoteArt(showOutcome.id, 'backdrop', showMeta.backdropUrl, showMeta.provider ?? undefined);

    const seasonIds = new Map<string, { id: number; dir: string | null; title: string }>();
    const pending: { file: WalkedFile; season: number; episode: number; title: string; seasonDir: string | null; seasonTitle: string }[] = [];
    for (const file of videos) {
      state.seen.add(file.path);
      const parsed = parseEpisodeFilename(file.name);
      if (!parsed) {
        warn(state, `Could not parse episode number from ${file.rel}`);
        continue;
      }
      const folder = seasonFolderOf(file.dir, showDir);
      pending.push({
        file,
        season: folder?.season ?? parsed.season,
        episode: parsed.episode,
        title: parsed.title,
        seasonDir: folder?.dir ?? null,
        seasonTitle: folder?.title ?? `Season ${String(parsed.season).padStart(2, '0')}`,
      });
    }

    for (const entry of pending) {
      const key = entry.seasonDir ? `dir:${entry.seasonDir}` : `num:${entry.season}`;
      if (seasonIds.has(key)) continue;
      const seasonPath = entry.seasonDir ?? path.join(showDir, `Season ${String(entry.season).padStart(2, '0')}`);
      state.seen.add(seasonPath);
      const seasonNfo = findNfo(entry.seasonDir ?? seasonPath, 'season');
      let seasonStat: fs.Stats | null = null;
      try {
        seasonStat = fs.statSync(seasonPath);
      } catch {
        seasonStat = null;
      }
      const seasonOutcome = upsertMedia({
        libraryId: state.library.id,
        kind: 'season',
        title: seasonNfo?.metadata.title || entry.seasonTitle,
        path: seasonPath,
        folderPath: showDir,
        year: seasonNfo?.metadata.year ?? null,
        description: seasonNfo?.metadata.description || '',
        parentId: showOutcome.id,
        seasonNumber: entry.season,
        mtime: seasonStat ? Math.floor(seasonStat.mtimeMs) : null,
        metadataProvider: seasonNfo?.metadata.provider ?? null,
        metadataId: seasonNfo?.metadata.providerId ?? null,
        matchScore: seasonNfo ? 0.95 : 0.5,
      });
      if (seasonNfo && !seasonOutcome.locked) {
        applyEnrichment(seasonOutcome.id, {
          title: seasonNfo.metadata.title,
          year: seasonNfo.metadata.year,
          description: seasonNfo.metadata.description,
          genres: seasonNfo.metadata.genres,
          tags: seasonNfo.metadata.tags,
          people: seasonNfo.metadata.people,
          provider: seasonNfo.metadata.provider,
          providerId: seasonNfo.metadata.providerId,
          matchScore: 0.95,
        });
      }
      seasonIds.set(key, { id: seasonOutcome.id, dir: entry.seasonDir, title: entry.seasonTitle });
    }

    const unresolved: typeof pending = [];
    for (const entry of pending) {
      if (isUnchanged(existingByPath(entry.file.path), entry.file.stat)) {
        state.skipped += 1;
        tick(state, `Skipped ${entry.file.name} (unchanged)`);
        continue;
      }
      unresolved.push(entry);
    }

    const batchSize = Math.max(1, config.scanConcurrency);
    for (let index = 0; index < unresolved.length; index += batchSize) {
      if (state.cancelled()) return;
      const batch = unresolved.slice(index, index + batchSize);
      const probes = await Promise.all(batch.map((entry) => probeOrWarn(entry.file.path, state)));
      for (let i = 0; i < batch.length; i += 1) {
        if (state.cancelled()) return;
        const entry = batch[i];
        const probe = probes[i];
        const key = entry.seasonDir ? `dir:${entry.seasonDir}` : `num:${entry.season}`;
        const season = seasonIds.get(key);
        if (!season) continue;
        const nfo = findNfo(entry.file.path, 'episode');
        const fields = probe ? fieldsFromProbe(probe, 'episode') : null;
        const episodeMeta: Enrichment = {
          ...mergeLocal(nfo?.metadata ?? null, entry.title, null),
          runtimeSeconds: fields?.runtimeSeconds ?? nfo?.metadata.runtimeSeconds ?? null,
          provider: nfo?.metadata.provider ?? null,
          providerId: nfo?.metadata.providerId ?? null,
          matchScore: nfo ? 0.95 : 0.6,
        };
        const outcome = upsertMedia({
          libraryId: state.library.id,
          kind: 'episode',
          title: episodeMeta.title || entry.title,
          path: entry.file.path,
          folderPath: entry.file.dir,
          year: episodeMeta.year ?? null,
          releaseDate: episodeMeta.releaseDate,
          description: episodeMeta.description,
          tagline: episodeMeta.tagline,
          rating: episodeMeta.rating,
          contentRating: episodeMeta.contentRating,
          runtimeSeconds: fields?.runtimeSeconds ?? episodeMeta.runtimeSeconds,
          container: fields?.container ?? path.extname(entry.file.name).slice(1).toLowerCase(),
          sizeBytes: entry.file.stat.size,
          mtime: Math.floor(entry.file.stat.mtimeMs),
          videoCodec: fields?.videoCodec ?? null,
          audioCodec: fields?.audioCodec ?? null,
          width: fields?.width ?? null,
          height: fields?.height ?? null,
          bitrate: fields?.bitrate ?? null,
          fps: fields?.fps ?? null,
          audioTracks: fields?.audioTracks ?? '[]',
          chapters: fields?.chapters ?? '[]',
          parentId: season.id,
          seasonNumber: entry.season,
          episodeNumber: entry.episode,
          metadataProvider: episodeMeta.provider,
          metadataId: episodeMeta.providerId,
          matchScore: episodeMeta.matchScore,
        });
        if (outcome.created) state.added += 1;
        else state.updated += 1;
        if (!outcome.locked) applyEnrichment(outcome.id, episodeMeta);
        const subtitles = [...discoverExternalSubtitles(entry.file.path, false), ...(probe ? embeddedSubtitles(probe) : [])];
        storeSubtitles(outcome.id, subtitles);
        await ensureArtForMedia(outcome.id);
        tick(state, `Scanned ${entry.title}`);
      }
    }

    await ensureArtForMedia(showOutcome.id);
    for (const season of seasonIds.values()) await ensureArtForMedia(season.id);
  }
}

/* ------------------------------------------------------------------ */
/* Music                                                               */
/* ------------------------------------------------------------------ */

function cleanFolderTitle(folderName: string): string {
  return parseMovieFilename(folderName).title;
}

function tagValue(tags: Record<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = tags[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

async function scanMusic(state: ScanState, files: WalkedFile[]): Promise<void> {
  const audio = files.filter((file) => classifyExtension(file.name) === 'audio');
  const byAlbum = new Map<string, WalkedFile[]>();
  for (const file of audio) {
    const list = byAlbum.get(file.dir) || [];
    list.push(file);
    byAlbum.set(file.dir, list);
  }
  const artistCache = new Map<string, { id: number; title: string }>();

  for (const [albumDir, tracks] of byAlbum) {
    if (state.cancelled()) return;
    const atLibraryRoot = albumDir === state.library.path;
    const parentDir = path.dirname(albumDir);
    const realArtistDir = !atLibraryRoot && parentDir !== state.library.path ? parentDir : null;
    const artistPath = realArtistDir ?? path.join(albumDir, '#unknown-artist');
    state.seen.add(artistPath);
    if (realArtistDir) state.seen.add(realArtistDir);
    state.seen.add(albumDir);

    let artist = artistCache.get(artistPath);
    if (!artist) {
      const artistNfo = realArtistDir ? findNfo(realArtistDir, 'artist') : null;
      const artistTitle = artistNfo?.metadata.title || (realArtistDir ? cleanFolderTitle(path.basename(realArtistDir)) : 'Unknown Artist');
      let artistStat: fs.Stats | null = null;
      if (realArtistDir) {
        try {
          artistStat = fs.statSync(realArtistDir);
        } catch {
          artistStat = null;
        }
      }
      const outcome = upsertMedia({
        libraryId: state.library.id,
        kind: 'artist',
        title: artistTitle,
        path: artistPath,
        folderPath: state.library.path,
        description: artistNfo?.metadata.description || '',
        year: artistNfo?.metadata.year ?? null,
        mtime: artistStat ? Math.floor(artistStat.mtimeMs) : null,
        metadataProvider: artistNfo?.metadata.provider ?? null,
        metadataId: artistNfo?.metadata.providerId ?? null,
        matchScore: artistNfo ? 0.95 : 0.5,
      });
      if (artistNfo && !outcome.locked) {
        applyEnrichment(outcome.id, {
          title: artistNfo.metadata.title,
          description: artistNfo.metadata.description,
          genres: artistNfo.metadata.genres,
          tags: artistNfo.metadata.tags,
          people: artistNfo.metadata.people,
          provider: artistNfo.metadata.provider,
          providerId: artistNfo.metadata.providerId,
          matchScore: 0.95,
        });
      }
      artist = { id: outcome.id, title: artistTitle };
      artistCache.set(artistPath, artist);
      await ensureArtForMedia(outcome.id);
    }

    const albumNfo = findNfo(albumDir, 'album');
    const albumFolderTitle = cleanFolderTitle(path.basename(albumDir));
    const albumTitle = albumNfo?.metadata.title || albumFolderTitle || 'Untitled Album';
    const albumOutcome = upsertMedia({
      libraryId: state.library.id,
      kind: 'album',
      title: albumTitle,
      path: albumDir,
      folderPath: state.library.path,
      year: albumNfo?.metadata.year ?? parseMovieFilename(path.basename(albumDir)).year,
      releaseDate: albumNfo?.metadata.releaseDate ?? null,
      description: albumNfo?.metadata.description || '',
      parentId: artist.id,
      artistId: artist.id,
      metadataProvider: albumNfo?.metadata.provider ?? null,
      metadataId: albumNfo?.metadata.providerId ?? null,
      matchScore: albumNfo ? 0.95 : 0.55,
    });
    if (albumNfo && !albumOutcome.locked) {
      applyEnrichment(albumOutcome.id, {
        title: albumNfo.metadata.title,
        year: albumNfo.metadata.year,
        releaseDate: albumNfo.metadata.releaseDate,
        description: albumNfo.metadata.description,
        genres: albumNfo.metadata.genres,
        tags: albumNfo.metadata.tags,
        people: albumNfo.metadata.people,
        provider: albumNfo.metadata.provider,
        providerId: albumNfo.metadata.providerId,
        matchScore: 0.95,
      });
    }

    const sorted = [...tracks].sort((a, b) => {
      const aNum = parseTrackFilename(a.name).trackNumber ?? 999;
      const bNum = parseTrackFilename(b.name).trackNumber ?? 999;
      return aNum - bNum || a.name.localeCompare(b.name);
    });
    const pending: WalkedFile[] = [];
    for (const file of sorted) {
      state.seen.add(file.path);
      if (isUnchanged(existingByPath(file.path), file.stat)) {
        state.skipped += 1;
        tick(state, `Skipped ${file.name} (unchanged)`);
        continue;
      }
      pending.push(file);
    }
    const batchSize = Math.max(1, config.scanConcurrency);
    for (let index = 0; index < pending.length; index += batchSize) {
      if (state.cancelled()) return;
      const batch = pending.slice(index, index + batchSize);
      const probes = await Promise.all(batch.map((file) => probeOrWarn(file.path, state)));
      for (let i = 0; i < batch.length; i += 1) {
        const file = batch[i];
        const probe = probes[i];
        const parsed = parseTrackFilename(file.name);
        const tags = probe?.tags || {};
        const title = tagValue(tags, 'title') || parsed.title || stripExtension(file.name);
        const trackNumber = Number(tagValue(tags, 'track')?.split('/')[0]) || parsed.trackNumber;
        const discNumber = Number(tagValue(tags, 'disc')?.split('/')[0]) || parsed.discNumber;
        const date = tagValue(tags, 'date', 'year');
        const year = date ? Number((date.match(/(19\d{2}|20\d{2})/) || [])[1]) || null : null;
        const genreTag = tagValue(tags, 'genre');
        const fields = probe ? fieldsFromProbe(probe, 'track') : null;
        const outcome = upsertMedia({
          libraryId: state.library.id,
          kind: 'track',
          title,
          path: file.path,
          folderPath: file.dir,
          year,
          releaseDate: date ? date.slice(0, 10) : null,
          container: fields?.container ?? path.extname(file.name).slice(1).toLowerCase(),
          sizeBytes: file.stat.size,
          mtime: Math.floor(file.stat.mtimeMs),
          runtimeSeconds: fields?.runtimeSeconds ?? null,
          audioCodec: fields?.audioCodec ?? null,
          bitrate: fields?.bitrate ?? null,
          audioTracks: '[]',
          chapters: '[]',
          parentId: albumOutcome.id,
          trackNumber: trackNumber ?? null,
          discNumber: discNumber ?? null,
          albumId: albumOutcome.id,
          artistId: artist.id,
          matchScore: 0.55,
        });
        if (outcome.created) state.added += 1;
        else state.updated += 1;
        if (genreTag) applyEnrichment(outcome.id, { genres: genreTag.split(/[;,/]/), tags: [], people: [] });
        tick(state, `Scanned ${title}`);
      }
    }
    await ensureArtForMedia(albumOutcome.id);
    await ensureArtForMedia(artist.id);
  }
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

async function scanPhotos(state: ScanState, files: WalkedFile[]): Promise<void> {
  const images = files.filter((file) => classifyExtension(file.name) === 'image');
  const pending: WalkedFile[] = [];
  for (const file of images) {
    state.seen.add(file.path);
    if (isUnchanged(existingByPath(file.path), file.stat)) {
      state.skipped += 1;
      tick(state, `Skipped ${file.name} (unchanged)`);
      continue;
    }
    pending.push(file);
  }
  const batchSize = Math.max(1, config.scanConcurrency);
  for (let index = 0; index < pending.length; index += batchSize) {
    if (state.cancelled()) return;
    const batch = pending.slice(index, index + batchSize);
    const probes = await Promise.all(batch.map((file) => probeOrWarn(file.path, state)));
    for (let i = 0; i < batch.length; i += 1) {
      const file = batch[i];
      const probe = probes[i];
      const parsed = parseMovieFilename(file.name);
      const title = parsed.title || stripExtension(file.name) || 'Untitled photo';
      const outcome = upsertMedia({
        libraryId: state.library.id,
        kind: 'photo',
        title,
        path: file.path,
        folderPath: file.dir,
        year: parsed.year,
        container: path.extname(file.name).slice(1).toLowerCase(),
        sizeBytes: file.stat.size,
        mtime: Math.floor(file.stat.mtimeMs),
        width: probe?.video?.width ?? null,
        height: probe?.video?.height ?? null,
        matchScore: 0.5,
      });
      if (outcome.created) state.added += 1;
      else state.updated += 1;
      await ensureArtForMedia(outcome.id);
      tick(state, `Scanned ${title}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public scan API                                                     */
/* ------------------------------------------------------------------ */

export interface ScanOptions {
  jobId?: string;
  source?: string;
  onProgress?: (progress: number, message: string) => void;
  cancelled?: () => boolean;
}

export interface ScanCounts {
  [kind: string]: number;
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
  counts: ScanCounts;
  totalBytes: number;
  durationMs: number;
}

export interface ActiveScanJob {
  id: string;
  status: string;
}

export function findActiveScanJob(libraryId: number): ActiveScanJob | undefined {
  if (activeScans.has(libraryId)) return { id: 'in-memory', status: 'running' };
  const rows = getDb().prepare("SELECT id, status, payload FROM jobs WHERE type = 'scan' AND status IN ('queued','running')").all() as {
    id: string;
    status: string;
    payload: string;
  }[];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { libraryId?: unknown; libraryIds?: unknown; scope?: unknown };
      if (Number(payload.libraryId) === libraryId) return { id: row.id, status: row.status };
      if (Array.isArray(payload.libraryIds) && payload.libraryIds.map(Number).includes(libraryId)) return { id: row.id, status: row.status };
      const targetsAll = payload.scope === 'all' || (payload.libraryId === undefined && payload.libraryIds === undefined);
      if (targetsAll) return { id: row.id, status: row.status };
    } catch {
      /* corrupted payload, ignore */
    }
  }
  return undefined;
}

export function isScanning(libraryId: number): boolean {
  return activeScans.has(libraryId) || Boolean(findActiveScanJob(libraryId));
}

/** Request a soft cancel; the scan stops between files and returns status cancelled. */
export function cancelScan(libraryId: number): boolean {
  if (!activeScans.has(libraryId)) return false;
  cancelRequests.add(libraryId);
  return true;
}

export function scanCounts(libraryId: number): { counts: ScanCounts; totalBytes: number } {
  const rows = getDb()
    .prepare('SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM media WHERE library_id = ? AND hidden = 0 GROUP BY kind')
    .all(libraryId) as { kind: string; n: number; bytes: number }[];
  const counts: ScanCounts = {};
  let totalBytes = 0;
  for (const row of rows) {
    counts[row.kind] = row.n;
    totalBytes += row.bytes;
  }
  return { counts, totalBytes };
}

export function enqueueScan(libraryId: number, createdBy?: number, source = 'manual'): JobDTO {
  const library = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId) as LibraryRow | undefined;
  if (!library) throw new Error(`Library ${libraryId} does not exist`);
  const active = findActiveScanJob(libraryId);
  if (active) {
    const error = new Error('A scan is already running for this library. Cope.');
    (error as Error & { code?: string }).code = 'scan_in_progress';
    (error as Error & { jobId?: string }).jobId = active.id;
    throw error;
  }
  return jobQueue.create('scan', { libraryId, source }, createdBy);
}

export async function scanLibrary(libraryId: number, options: ScanOptions = {}): Promise<ScanResult> {
  const db = getDb();
  const startedAt = Date.now();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId) as LibraryRow | undefined;
  if (!library) throw new Error(`Library ${libraryId} does not exist`);
  if (activeScans.has(libraryId)) {
    const error = new Error(`Library "${library.name}" is already being scanned`);
    (error as Error & { code?: string }).code = 'scan_in_progress';
    throw error;
  }
  const rootStat = fs.statSync(library.path);
  if (!rootStat.isDirectory()) throw new Error(`Library path is not a directory: ${library.path}`);

  activeScans.set(libraryId, { startedAt: nowISO() });
  cancelRequests.delete(libraryId);
  let librarySettings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(library.settings) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) librarySettings = parsed as Record<string, unknown>;
  } catch {
    librarySettings = {};
  }
  const walked = walkLibrary(library.path);
  const relevant = walked.files.filter((file) => {
    const cls = classifyExtension(file.name);
    if (library.kind === 'movies' || library.kind === 'shows') return cls === 'video';
    if (library.kind === 'music') return cls === 'audio';
    if (library.kind === 'photos') return cls === 'image';
    return cls === 'video' || cls === 'audio' || cls === 'image';
  });
  const state: ScanState = {
    library,
    seen: new Set(),
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    hidden: 0,
    errors: [...walked.warnings],
    total: relevant.length,
    done: 0,
    lastEmit: 0,
    onProgress: options.onProgress,
    cancelled: () => cancelRequests.has(libraryId) || Boolean(options.cancelled?.()),
    librarySettings,
  };
  bus.publish('scan.progress', {
    libraryId,
    libraryName: library.name,
    status: 'running',
    progress: 0,
    message: `Scanning ${relevant.length} file${relevant.length === 1 ? '' : 's'} in ${library.name}`,
    active: activeScans.size,
    total: relevant.length,
  });

  let status: ScanResult['status'] = 'done';
  try {
    if (library.kind === 'movies') await scanMovies(state, walked.files);
    else if (library.kind === 'shows') await scanShows(state, walked.files, walked.dirs);
    else if (library.kind === 'music') await scanMusic(state, walked.files);
    else if (library.kind === 'photos') await scanPhotos(state, walked.files);
    else {
      await scanMovies(state, walked.files);
      await scanMusic(state, walked.files);
      await scanPhotos(state, walked.files);
    }
    if (state.cancelled()) status = 'cancelled';

    // Stale reconciliation only runs for a complete pass. A cancelled or failed
    // scan has not seen every file yet, so touching unseen rows would hide or
    // delete media that still exists on disk.
    if (status === 'done') {
      const removeMissing = librarySettings.removeMissing === true;
      const rows = db.prepare('SELECT id, path, hidden FROM media WHERE library_id = ?').all(libraryId) as { id: number; path: string; hidden: number }[];
      for (const row of rows) {
        if (state.seen.has(row.path)) continue;
        if (row.hidden === 1 && !removeMissing) continue;
        if (removeMissing) {
          purgeArtForMedia(row.id);
          db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
          state.removed += 1;
        } else {
          db.prepare('UPDATE media SET hidden = 1, updated_at = ? WHERE id = ?').run(nowISO(), row.id);
          state.hidden += 1;
        }
      }
      db.prepare('UPDATE libraries SET last_scan_at = ?, updated_at = ? WHERE id = ?').run(nowISO(), nowISO(), libraryId);
    }
  } catch (error) {
    status = 'error';
    state.errors.push((error as Error).message);
    logger.error('scanner', `Scan of "${library.name}" failed: ${(error as Error).message}`);
  } finally {
    activeScans.delete(libraryId);
    cancelRequests.delete(libraryId);
  }

  const { counts, totalBytes } = scanCounts(libraryId);
  const result: ScanResult = {
    libraryId,
    libraryName: library.name,
    status,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed,
    hidden: state.hidden,
    errors: state.errors.slice(0, 50),
    counts,
    totalBytes,
    durationMs: Date.now() - startedAt,
  };
  bus.publish('scan.progress', {
    libraryId,
    libraryName: library.name,
    status,
    progress: status === 'done' ? 1 : Math.min(0.99, state.total > 0 ? state.done / state.total : 0),
    message:
      status === 'cancelled'
        ? `Scan cancelled. ${state.added} added, ${state.skipped} skipped.`
        : `Scanned ${library.name}: ${state.added} new, ${state.updated} refreshed, ${state.skipped} untouched, ${state.hidden + state.removed} gone.`,
    active: activeScans.size,
    total: state.total,
  });
  bus.publish('media.changed', {
    libraryId,
    libraryName: library.name,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed + state.hidden,
  });
  logger.info('scanner', `Scan "${library.name}" ${status}`, {
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    hidden: state.hidden,
    removed: state.removed,
    ms: result.durationMs,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Job handler + library automation                                    */
/* ------------------------------------------------------------------ */

export async function handleScanJob(ctx: { jobId: string; payload: Record<string, unknown>; update: (progress: number, message?: string) => void; cancelled: () => boolean }): Promise<unknown> {
  const db = getDb();
  let ids: number[] = [];
  const payload = ctx.payload;
  if (Array.isArray(payload.libraryIds)) {
    ids = payload.libraryIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  } else if (payload.libraryId !== undefined) {
    const id = Number(payload.libraryId);
    if (Number.isInteger(id) && id > 0) ids = [id];
  } else {
    ids = (db.prepare('SELECT id FROM libraries ORDER BY id').all() as { id: number }[]).map((row) => row.id);
  }
  if (ids.length === 0) {
    ctx.update(1, 'No libraries to scan. Build a library first.');
    return { ok: true, libraries: [] };
  }
  const results: ScanResult[] = [];
  const skipped: { libraryId: number; reason: string }[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    if (ctx.cancelled()) break;
    const libraryId = ids[index];
    const library = db.prepare('SELECT name FROM libraries WHERE id = ?').get(libraryId) as { name: string } | undefined;
    if (!library) {
      skipped.push({ libraryId, reason: 'library not found' });
      continue;
    }
    ctx.update(Math.max(0, index / ids.length), `Scanning ${library.name} (${index + 1}/${ids.length})`);
    try {
      const result = await scanLibrary(libraryId, {
        jobId: ctx.jobId,
        cancelled: ctx.cancelled,
        onProgress: (progress, message) => ctx.update(Math.min(0.99, (index + progress) / ids.length), `${library.name}: ${message}`),
      });
      results.push(result);
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (failure.code === 'scan_in_progress') {
        skipped.push({ libraryId, reason: failure.message });
      } else {
        skipped.push({ libraryId, reason: failure.message });
        logger.warn('scanner', `Scan failed for ${library.name}: ${failure.message}`);
      }
    }
    ctx.update((index + 1) / ids.length, `Finished ${library.name} (${index + 1}/${ids.length})`);
  }
  return { ok: true, libraries: results, skipped };
}

jobQueue.registerHandler('scan', handleScanJob);

/* ------------------------------------------------------------------ */
/* Boot: demo libraries, startup scan, lightweight scheduler           */
/* ------------------------------------------------------------------ */

const warnedMissingLibraries = new Set<number>();
const SCHEDULE_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function bootstrapDemoLibraries(): void {
  if (!config.demoMode) return;
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM libraries').get() as { n: number }).n;
  if (count > 0) return;
  const definitions: { name: string; kind: LibraryRow['kind']; folder: string }[] = [
    { name: 'Movies', kind: 'movies', folder: 'movies' },
    { name: 'Shows', kind: 'shows', folder: 'shows' },
    { name: 'Music', kind: 'music', folder: 'music' },
    { name: 'Photos', kind: 'photos', folder: 'photos' },
  ];
  const created: LibraryRow[] = [];
  for (const definition of definitions) {
    const target = path.join(config.mediaDir, definition.folder);
    try {
      if (!fs.statSync(target).isDirectory()) continue;
    } catch {
      continue;
    }
    const existing = db.prepare('SELECT id FROM libraries WHERE path = ?').get(target) as { id: number } | undefined;
    if (existing) continue;
    const timestamp = nowISO();
    const info = db
      .prepare(
        `INSERT INTO libraries(name, kind, path, scan_schedule, settings, created_at, updated_at)
         VALUES(?, ?, ?, 'daily', '{}', ?, ?)`,
      )
      .run(definition.name, definition.kind, target, timestamp, timestamp);
    const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(info.lastInsertRowid)) as LibraryRow;
    created.push(row);
    logger.info('scanner', `Demo library "${definition.name}" created at ${target}`);
  }
  for (const library of created) enqueueIfIdle(library, 'demo');
}

function enqueueIfIdle(library: LibraryRow, source: string, createdBy?: number): boolean {
  if (isScanning(library.id)) return false;
  jobQueue.create('scan', { libraryId: library.id, source }, createdBy);
  logger.info('scanner', `Queued ${source} scan for "${library.name}"`);
  return true;
}

function pathIsUsable(libraryPath: string): boolean {
  try {
    return fs.statSync(libraryPath).isDirectory();
  } catch {
    return false;
  }
}

/** One boot pass: libraries never scanned or stale by >24h. */
function startupScans(): void {
  const db = getDb();
  const libraries = db.prepare('SELECT * FROM libraries ORDER BY id').all() as LibraryRow[];
  const cutoff = Date.now() - SCHEDULE_MS.daily;
  for (const library of libraries) {
    if (!pathIsUsable(library.path)) {
      if (!warnedMissingLibraries.has(library.id)) {
        warnedMissingLibraries.add(library.id);
        logger.warn('scanner', `Library "${library.name}" path is missing; skipping startup scan (${library.path})`);
      }
      continue;
    }
    const lastScan = library.last_scan_at ? Date.parse(library.last_scan_at) : 0;
    if (Number.isFinite(lastScan) && lastScan >= cutoff) continue;
    enqueueIfIdle(library, 'startup');
  }
}

/** Every 15 minutes: enqueue due scheduled scans, one per library, never overlap. */
export function checkScanSchedules(): void {
  const db = getDb();
  const libraries = db.prepare("SELECT * FROM libraries WHERE scan_schedule != 'manual' ORDER BY id").all() as LibraryRow[];
  const now = Date.now();
  for (const library of libraries) {
    if (!pathIsUsable(library.path)) {
      if (!warnedMissingLibraries.has(library.id)) {
        warnedMissingLibraries.add(library.id);
        logger.warn('scanner', `Library "${library.name}" path is missing; pausing scheduled scans (${library.path})`);
      }
      continue;
    }
    warnedMissingLibraries.delete(library.id);
    const interval = SCHEDULE_MS[library.scan_schedule] || SCHEDULE_MS.daily;
    const lastScan = library.last_scan_at ? Date.parse(library.last_scan_at) : 0;
    if (Number.isFinite(lastScan) && now - lastScan < interval) continue;
    enqueueIfIdle(library, 'schedule');
  }
}

function bootLibraryAutomation(): void {
  try {
    bootstrapDemoLibraries();
    if (settings.get('scanOnStart') !== false) startupScans();
    const timer = setInterval(checkScanSchedules, 15 * 60 * 1000);
    timer.unref();
  } catch (error) {
    logger.warn('scanner', `Library automation boot skipped: ${(error as Error).message}`);
  }
}

const bootTimer = setTimeout(bootLibraryAutomation, 1500);
bootTimer.unref();

/** Exposed for tests/scripts that want automation without the boot delay. */
export function runBootAutomationNow(): void {
  bootLibraryAutomation();
}

/* ------------------------------------------------------------------ */
/* Single-item refresh / manual metadata                               */
/* ------------------------------------------------------------------ */

export interface RefreshResult {
  ok: boolean;
  warnings: string[];
}

function updateTechnicalFields(id: number, probe: ProbeResult, kind: MediaKind): void {
  const fields = fieldsFromProbe(probe, kind);
  getDb()
    .prepare(
      `UPDATE media SET container=?, size_bytes=?, runtime_seconds=?, video_codec=?, audio_codec=?,
        width=?, height=?, bitrate=?, fps=?, audio_tracks=?, chapters=?, mtime=?, updated_at=? WHERE id=?`,
    )
    .run(
      fields.container,
      fields.sizeBytes,
      fields.runtimeSeconds,
      fields.videoCodec,
      fields.audioCodec,
      fields.width,
      fields.height,
      fields.bitrate,
      fields.fps,
      fields.audioTracks,
      fields.chapters,
      Math.floor(fs.statSync(probe.path).mtimeMs),
      nowISO(),
      id,
    );
}

/** Re-probe, re-match and regenerate art for a single media row. */
export async function refreshMedia(mediaId: number, options: { forceArt?: boolean } = {}): Promise<RefreshResult> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId) as MediaRow | undefined;
  if (!row) throw new Error('Media row not found');
  const warnings: string[] = [];
  const probeTargets: MediaKind[] = ['movie', 'episode', 'video', 'track', 'photo'];
  let probe: ProbeResult | null = null;
  if (probeTargets.includes(row.kind)) {
    try {
      const stat = fs.statSync(row.path);
      if (stat.isFile()) {
        probe = await probeFile(row.path, { immediate: true });
        updateTechnicalFields(row.id, probe, row.kind);
      }
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }

  let enrichment: Enrichment | null = null;
  if (row.kind === 'movie') {
    enrichment = (await resolveEnrichment('movie', row.path, row.title, row.year, path.dirname(row.path))).enrichment;
  } else if (row.kind === 'show') {
    enrichment = (await resolveEnrichment('show', row.path, row.title, row.year, row.path)).enrichment;
  } else if (row.kind === 'episode') {
    const nfo = findNfo(row.path, 'episode');
    enrichment = {
      ...mergeLocal(nfo?.metadata ?? null, row.title, row.year),
      runtimeSeconds: probe?.durationSeconds ?? nfo?.metadata.runtimeSeconds ?? row.runtime_seconds,
      provider: nfo?.metadata.provider ?? null,
      providerId: nfo?.metadata.providerId ?? null,
      matchScore: nfo ? 0.95 : 0.6,
    };
  } else if (row.kind === 'season') {
    const nfo = findNfo(row.path, 'season');
    if (nfo) enrichment = { ...mergeLocal(nfo.metadata, row.title, row.year) };
  } else if (row.kind === 'album') {
    const nfo = findNfo(row.path, 'album');
    if (nfo) enrichment = { ...mergeLocal(nfo.metadata, row.title, row.year) };
  } else if (row.kind === 'artist') {
    const nfo = findNfo(row.path, 'artist');
    if (nfo) enrichment = { ...mergeLocal(nfo.metadata, row.title, row.year) };
  } else if (row.kind === 'track' && probe) {
    const tags = probe.tags;
    const genreTag = tagValue(tags, 'genre');
    enrichment = { genres: genreTag ? genreTag.split(/[;,/]/) : [], tags: [], people: [] };
  }

  const locked = row.metadata_locked === 1;
  if (enrichment && !locked) {
    applyEnrichment(row.id, enrichment);
    if (enrichment.posterUrl) await downloadRemoteArt(row.id, 'poster', enrichment.posterUrl, enrichment.provider ?? undefined);
    if (enrichment.backdropUrl) await downloadRemoteArt(row.id, 'backdrop', enrichment.backdropUrl, enrichment.provider ?? undefined);
  }
  if ((row.kind === 'movie' || row.kind === 'episode' || row.kind === 'video') && probe) {
    storeSubtitles(row.id, [...discoverExternalSubtitles(row.path, false), ...embeddedSubtitles(probe)]);
  }
  await ensureArtForMedia(row.id, { force: options.forceArt !== false });
  bus.publish('media.changed', { mediaId: row.id, kind: row.kind, refreshed: true });
  return { ok: true, warnings };
}

/* ------------------------------------------------------------------ */
/* Maintenance job handlers (art / probe / match)                      */
/* ------------------------------------------------------------------ */

type MaintenanceContext = {
  jobId: string;
  payload: Record<string, unknown>;
  update: (progress: number, message?: string) => void;
  cancelled: () => boolean;
};

function targetIds(payload: Record<string, unknown>, kinds?: MediaKind[]): number[] {
  const db = getDb();
  if (Array.isArray(payload.mediaIds)) {
    return payload.mediaIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0).slice(0, 20_000);
  }
  if (payload.mediaId !== undefined) {
    const mediaId = Number(payload.mediaId);
    return Number.isInteger(mediaId) && mediaId > 0 ? [mediaId] : [];
  }
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (payload.libraryId !== undefined) {
    const libraryId = Number(payload.libraryId);
    if (!Number.isInteger(libraryId) || libraryId <= 0) return [];
    conditions.push('library_id = ?');
    params.push(libraryId);
  }
  if (kinds && kinds.length > 0) {
    conditions.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id FROM media ${clause} ORDER BY CASE kind
         WHEN 'track' THEN 0 WHEN 'photo' THEN 1 WHEN 'episode' THEN 2 WHEN 'movie' THEN 3 WHEN 'video' THEN 3
         WHEN 'album' THEN 4 WHEN 'artist' THEN 5 WHEN 'season' THEN 6 WHEN 'show' THEN 7 ELSE 8 END, id`,
    )
    .all(...params) as { id: number }[];
  return rows.map((row) => row.id);
}

export async function handleArtJob(ctx: MaintenanceContext): Promise<unknown> {
  const ids = targetIds(ctx.payload);
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < ids.length; index += 1) {
    if (ctx.cancelled()) break;
    try {
      const ok = await ensureArtForMedia(ids[index], { force: true });
      if (ok) processed += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logger.warn('scanner', `Art regeneration failed for ${ids[index]}: ${(error as Error).message}`);
    }
    ctx.update((index + 1) / Math.max(1, ids.length), `Art: ${index + 1}/${ids.length}`);
  }
  return { processed, failed, total: ids.length };
}

export async function handleProbeJob(ctx: MaintenanceContext): Promise<unknown> {
  const ids = targetIds(ctx.payload, ['movie', 'episode', 'video', 'track', 'photo']);
  const db = getDb();
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (let index = 0; index < ids.length; index += 1) {
    if (ctx.cancelled()) break;
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(ids[index]) as MediaRow | undefined;
    if (!row) {
      skipped += 1;
      continue;
    }
    try {
      const stat = fs.statSync(row.path);
      if (!stat.isFile()) {
        skipped += 1;
        continue;
      }
      const probe = await probeFile(row.path);
      updateTechnicalFields(row.id, probe, row.kind);
      if (row.kind === 'movie' || row.kind === 'episode' || row.kind === 'video') {
        storeSubtitles(row.id, [...discoverExternalSubtitles(row.path, false), ...embeddedSubtitles(probe)]);
      }
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.warn('scanner', `Re-probe failed for ${row.path}: ${(error as Error).message}`);
    }
    ctx.update((index + 1) / Math.max(1, ids.length), `Probing: ${index + 1}/${ids.length}`);
  }
  return { processed, failed, skipped, total: ids.length };
}

export async function handleMatchJob(ctx: MaintenanceContext): Promise<unknown> {
  const ids = targetIds(ctx.payload, ['movie', 'show', 'episode', 'season']);
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < ids.length; index += 1) {
    if (ctx.cancelled()) break;
    try {
      await refreshMedia(ids[index], { forceArt: false });
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.warn('scanner', `Metadata refresh failed for ${ids[index]}: ${(error as Error).message}`);
    }
    ctx.update((index + 1) / Math.max(1, ids.length), `Matching: ${index + 1}/${ids.length}`);
  }
  return { processed, failed, total: ids.length };
}

jobQueue.registerHandler('art', handleArtJob);
jobQueue.registerHandler('probe', handleProbeJob);
jobQueue.registerHandler('match', handleMatchJob);
