import { getDb } from '../db.ts';
import type {
  ArtDTO,
  ArtKind,
  AudioTrack,
  Chapter,
  MediaDTO,
  MediaKind,
  MediaRow,
  PersonDTO,
  PlaylistDTO,
  PlaylistRow,
  CollectionDTO,
  CollectionRow,
  UserDTO,
} from '../types.ts';
import { toUserDTO } from './auth.ts';
import type { UserRow } from './auth.ts';

const VIDEO_KINDS = new Set<MediaKind>(['movie', 'episode', 'video']);
const AUDIO_KINDS = new Set<MediaKind>(['track']);
const IMAGE_KINDS = new Set<MediaKind>(['photo']);

export function playableKind(kind: MediaKind): boolean {
  return VIDEO_KINDS.has(kind) || AUDIO_KINDS.has(kind);
}

export function artUrl(mediaId: number, kind: ArtKind, version: number | string = ''): string {
  const suffix = version ? `?v=${encodeURIComponent(String(version))}` : '';
  return `/api/art/${mediaId}/${kind}${suffix}`;
}

interface ArtRow {
  media_id: number;
  kind: ArtKind;
  path: string;
  source: string;
}

export interface MediaExtras {
  genres?: Map<number, string[]>;
  art?: Map<number, ArtRow[]>;
  people?: Map<number, PersonDTO[]>;
  states?: Map<number, { favorite: number; watched: number; rating: number | null }>;
  progress?: Map<number, { position_seconds: number; duration_seconds: number; finished: number; play_count: number; updated_at: string }>;
  childCounts?: Map<number, number>;
  libraryNames?: Map<number, string>;
}

function parseJSONArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function buildArt(mediaId: number, rows: ArtRow[] | undefined, updatedAt: string): ArtDTO {
  const art: ArtDTO = {};
  for (const row of rows || []) {
    art[row.kind] = artUrl(mediaId, row.kind, `${row.source}-${updatedAt}`);
  }
  return art;
}

/** Batch-load everything needed to serialize rows without N+1 queries. */
export function collectExtras(rows: MediaRow[], userId?: number): MediaExtras {
  const db = getDb();
  const extras: MediaExtras = { genres: new Map(), art: new Map(), people: new Map(), states: new Map(), progress: new Map(), childCounts: new Map() };
  if (rows.length === 0) return extras;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');

  const genres = db.prepare(`SELECT media_id, genre FROM media_genres WHERE media_id IN (${placeholders})`).all(...ids) as { media_id: number; genre: string }[];
  for (const row of genres) {
    const list = extras.genres!.get(row.media_id) || [];
    list.push(row.genre);
    extras.genres!.set(row.media_id, list);
  }

  const art = db.prepare(`SELECT media_id, kind, path, source FROM media_art WHERE media_id IN (${placeholders})`).all(...ids) as ArtRow[];
  for (const row of art) {
    const list = extras.art!.get(row.media_id) || [];
    list.push(row);
    extras.art!.set(row.media_id, list);
  }

  const people = db
    .prepare(`SELECT media_id, name, role, character FROM media_people WHERE media_id IN (${placeholders}) ORDER BY ord ASC LIMIT 200`)
    .all(...ids) as { media_id: number; name: string; role: string; character: string | null }[];
  for (const row of people) {
    const list = extras.people!.get(row.media_id) || [];
    list.push({ name: row.name, role: row.role, character: row.character });
    extras.people!.set(row.media_id, list);
  }

  if (userId) {
    const states = db
      .prepare(`SELECT media_id, favorite, watched, rating FROM item_state WHERE user_id = ? AND media_id IN (${placeholders})`)
      .all(userId, ...ids) as { media_id: number; favorite: number; watched: number; rating: number | null }[];
    for (const row of states) extras.states!.set(row.media_id, row);
    const progress = db
      .prepare(
        `SELECT media_id, position_seconds, duration_seconds, finished, play_count, updated_at
         FROM progress WHERE user_id = ? AND media_id IN (${placeholders})`,
      )
      .all(userId, ...ids) as {
      media_id: number;
      position_seconds: number;
      duration_seconds: number;
      finished: number;
      play_count: number;
      updated_at: string;
    }[];
    for (const row of progress) extras.progress!.set(row.media_id, row);
  }

  const counts = db
    .prepare(`SELECT parent_id, COUNT(*) AS n FROM media WHERE hidden = 0 AND parent_id IN (${placeholders}) GROUP BY parent_id`)
    .all(...ids) as { parent_id: number; n: number }[];
  for (const row of counts) extras.childCounts!.set(row.parent_id, row.n);

  const libraryIds = [...new Set(rows.map((row) => row.library_id))];
  if (libraryIds.length > 0) {
    const libs = db
      .prepare(`SELECT id, name FROM libraries WHERE id IN (${libraryIds.map(() => '?').join(',')})`)
      .all(...libraryIds) as { id: number; name: string }[];
    extras.libraryNames = new Map(libs.map((lib) => [lib.id, lib.name]));
  }
  return extras;
}

export function mediaToDTO(row: MediaRow, extras?: MediaExtras): MediaDTO {
  const art = buildArt(row.id, extras?.art?.get(row.id), row.updated_at);
  const state = extras?.states?.get(row.id);
  const progressRow = extras?.progress?.get(row.id);
  const duration = row.runtime_seconds ?? 0;
  return {
    id: row.id,
    libraryId: row.library_id,
    libraryName: extras?.libraryNames?.get(row.library_id) || row.library_name,
    kind: row.kind,
    title: row.title,
    sortTitle: row.sort_title,
    originalTitle: row.original_title,
    year: row.year,
    releaseDate: row.release_date,
    description: row.description,
    tagline: row.tagline,
    rating: row.rating,
    contentRating: row.content_rating,
    runtimeSeconds: row.runtime_seconds,
    durationSeconds: progressRow?.duration_seconds || duration,
    container: row.container,
    sizeBytes: row.size_bytes,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: row.width,
    height: row.height,
    bitrate: row.bitrate,
    fps: row.fps,
    audioTracks: parseJSONArray<AudioTrack>(row.audio_tracks),
    chapters: parseJSONArray<Chapter>(row.chapters),
    genres: extras?.genres?.get(row.id) || row.genres || [],
    people: extras?.people?.get(row.id) || row.people,
    parentId: row.parent_id,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    trackNumber: row.track_number,
    discNumber: row.disc_number,
    albumId: row.album_id,
    artistId: row.artist_id,
    metadataProvider: row.metadata_provider,
    metadataLocked: Boolean(row.metadata_locked),
    matchScore: row.match_score,
    art,
    favorite: state ? Boolean(state.favorite) : undefined,
    watched: state ? Boolean(state.watched) : undefined,
    userRating: state?.rating ?? undefined,
    progress: progressRow
      ? {
          positionSeconds: progressRow.position_seconds,
          durationSeconds: progressRow.duration_seconds,
          finished: Boolean(progressRow.finished),
          playCount: progressRow.play_count,
          updatedAt: progressRow.updated_at,
        }
      : null,
    addedAt: row.added_at,
    childCount: extras?.childCounts?.get(row.id),
    playable: playableKind(row.kind),
  };
}

export function mediaRowsToDTO(rows: MediaRow[], userId?: number): MediaDTO[] {
  const extras = collectExtras(rows, userId);
  return rows.map((row) => mediaToDTO(row, extras));
}

export function getMediaRow(id: number): MediaRow | undefined {
  return getDb().prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
}

export function getMediaDTO(id: number, userId?: number): MediaDTO | undefined {
  const row = getMediaRow(id);
  if (!row) return undefined;
  return mediaToDTO(row, collectExtras([row], userId));
}

export function getArtRow(mediaId: number, kind: ArtKind): ArtRow | undefined {
  return getDb().prepare('SELECT media_id, kind, path, source FROM media_art WHERE media_id = ? AND kind = ?').get(mediaId, kind) as ArtRow | undefined;
}

export function userRowToDTO(row: UserRow): UserDTO {
  return toUserDTO(row);
}

export function collectionToDTO(row: CollectionRow, extras?: { itemCount?: number; artRows?: ArtRow[]; creator?: string | null }): CollectionDTO {
  const art: ArtDTO = {};
  for (const artRow of extras?.artRows || []) art[artRow.kind] = artUrl(artRow.media_id, artRow.kind, artRow.source);
  let rules: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.rules);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rules = parsed as Record<string, unknown>;
  } catch {
    rules = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    rules,
    pinned: Boolean(row.pinned),
    sortOrder: row.sort_order,
    createdBy: extras?.creator,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: extras?.itemCount ?? 0,
    art,
  };
}

export function playlistToDTO(row: PlaylistRow, extras?: { itemCount?: number; durationSeconds?: number; artRows?: ArtRow[]; creator?: string | null }): PlaylistDTO {
  const art: ArtDTO = {};
  for (const artRow of extras?.artRows || []) art[artRow.kind] = artUrl(artRow.media_id, artRow.kind, artRow.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    isPublic: Boolean(row.is_public),
    createdBy: extras?.creator,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: extras?.itemCount ?? 0,
    durationSeconds: extras?.durationSeconds ?? 0,
    art,
  };
}
