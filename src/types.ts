// Shared domain + API types. Erasable TypeScript only: the app runs directly on Node 24.
export type Role = 'admin' | 'manager' | 'user';
export type LibraryKind = 'movies' | 'shows' | 'music' | 'photos' | 'mixed';
export type MediaKind = 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album' | 'track' | 'photo' | 'video';
export type ArtKind = 'poster' | 'backdrop' | 'thumb' | 'banner' | 'logo' | 'art' | 'avatar' | 'disc';

export interface AudioTrack {
  index: number;
  codec: string;
  channels: number | null;
  language: string;
  title: string | null;
  default: boolean;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export interface SubtitleRow {
  id: number;
  media_id: number;
  language: string;
  label: string;
  format: string;
  is_external: 0 | 1;
  path: string | null;
  stream_index: number | null;
  forced: 0 | 1;
}

export interface MediaRow {
  id: number;
  library_id: number;
  kind: MediaKind;
  title: string;
  sort_title: string;
  original_title: string | null;
  year: number | null;
  release_date: string | null;
  description: string;
  tagline: string | null;
  rating: number | null;
  content_rating: string | null;
  runtime_seconds: number | null;
  path: string;
  folder_path: string | null;
  container: string | null;
  size_bytes: number | null;
  mtime: number | null;
  hash: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  fps: number | null;
  audio_tracks: string;
  chapters: string;
  parent_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  track_number: number | null;
  disc_number: number | null;
  album_id: number | null;
  artist_id: number | null;
  metadata_provider: string | null;
  metadata_id: string | null;
  metadata_locked: 0 | 1;
  match_score: number | null;
  hidden: 0 | 1;
  added_at: string;
  updated_at: string;
  // joined extras (optional)
  library_name?: string;
  genres?: string[];
  people?: PersonDTO[];
}

export interface PersonDTO {
  name: string;
  role: string;
  character?: string | null;
}

export interface ArtDTO {
  poster?: string;
  backdrop?: string;
  thumb?: string;
  banner?: string;
  logo?: string;
  art?: string;
  avatar?: string;
  disc?: string;
}

export interface MediaDTO {
  id: number;
  libraryId: number;
  libraryName?: string;
  kind: MediaKind;
  title: string;
  sortTitle: string;
  originalTitle?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  description: string;
  tagline?: string | null;
  rating?: number | null;
  contentRating?: string | null;
  runtimeSeconds?: number | null;
  durationSeconds?: number | null;
  container?: string | null;
  sizeBytes?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  fps?: number | null;
  audioTracks: AudioTrack[];
  chapters: Chapter[];
  genres: string[];
  people?: PersonDTO[];
  parentId?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  albumId?: number | null;
  artistId?: number | null;
  metadataProvider?: string | null;
  metadataLocked?: boolean;
  matchScore?: number | null;
  art: ArtDTO;
  // per-user state
  favorite?: boolean;
  watched?: boolean;
  userRating?: number | null;
  progress?: {
    positionSeconds: number;
    durationSeconds: number;
    finished: boolean;
    playCount: number;
    updatedAt: string;
  } | null;
  addedAt: string;
  childCount?: number;
  // routing helpers
  playable: boolean;
}

export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  avatarHue: number;
  disabled: boolean;
  preferences: UserPreferences;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface UserPreferences {
  theme?: 'slop' | 'dark' | 'light' | 'midnight';
  autoPlayNext?: boolean;
  defaultSubtitle?: string;
  defaultAudio?: string;
  reduceMotion?: boolean;
  spoilerBlur?: boolean;
  cardDensity?: 'cozy' | 'compact';
  memes?: boolean;
}

export interface AuthUser extends UserDTO {
  hasPin: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AppConfig {
  version: string;
  env: string;
  port: number;
  host: string;
  dataDir: string;
  mediaDir: string;
  dbPath: string;
  cacheDir: string;
  imageDir: string;
  transcodeDir: string;
  tempDir: string;
  logDir: string;
  adminUser: string;
  adminPassword: string;
  ffmpegPath: string;
  ffprobePath: string;
  tmdbApiKey: string;
  tvdbApiKey: string;
  omdbApiKey: string;
  defaultLanguage: string;
  maxTranscodeHeight: number;
  transcodePreset: string;
  transcodeConcurrency: number;
  transcodeHwAccel: string;
  transcodeHwAccelDevice: string;
  transcodeThrottleSeconds: number;
  hlsSegmentSeconds: number;
  scanConcurrency: number;
  sessionDays: number;
  secureCookies: boolean;
  trustProxy: boolean;
  demoMode: boolean;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type JobType = 'scan' | 'match' | 'art' | 'probe' | 'cleanup' | 'ingest';

export interface JobRow {
  id: string;
  type: JobType;
  payload: string;
  status: JobStatus;
  progress: number;
  message: string;
  result: string | null;
  error: string | null;
  created_by: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobDTO {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  message: string;
  result: unknown;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdBy?: string | null;
}

export type StreamMode = 'direct' | 'transcode' | 'remux';

export interface LibraryRow {
  id: number;
  name: string;
  kind: LibraryKind;
  path: string;
  scan_schedule: string;
  settings: string;
  created_at: string;
  updated_at: string;
  last_scan_at: string | null;
}

export interface LibraryDTO extends Omit<LibraryRow, 'settings'> {
  settings: Record<string, unknown>;
  itemCount: number;
  totalBytes: number;
  lastScanAt: string | null;
  exists: boolean;
}

export interface CollectionRow {
  id: number;
  name: string;
  description: string;
  kind: 'manual' | 'smart';
  rules: string;
  pinned: 0 | 1;
  sort_order: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionDTO {
  id: number;
  name: string;
  description: string;
  kind: 'manual' | 'smart';
  rules: Record<string, unknown>;
  pinned: boolean;
  sortOrder: number;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  art: ArtDTO;
}

export interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  kind: 'mixed' | 'video' | 'audio' | 'photo';
  is_public: 0 | 1;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlaylistDTO {
  id: number;
  name: string;
  description: string;
  kind: 'mixed' | 'video' | 'audio' | 'photo';
  isPublic: boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  durationSeconds: number;
  art: ArtDTO;
}

export interface ProgressRow {
  user_id: number;
  media_id: number;
  episode_id: number | null;
  position_seconds: number;
  duration_seconds: number;
  finished: 0 | 1;
  play_count: number;
  updated_at: string;
}

export interface RequestRow {
  id: number;
  user_id: number | null;
  title: string;
  kind: 'movie' | 'show' | 'music' | 'other';
  year: number | null;
  note: string;
  status: 'pending' | 'approved' | 'rejected' | 'fulfilled';
  reviewed_by: number | null;
  review_note: string;
  created_at: string;
  updated_at: string;
}

export interface ReportRow {
  id: number;
  user_id: number | null;
  media_id: number | null;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  notes: string;
  resolved_by: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface PartyRow {
  id: string;
  name: string;
  host_id: number | null;
  media_id: number | null;
  position: number;
  paused: 0 | 1;
  is_active: 0 | 1;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------
export type IngestKind = 'movies' | 'shows' | 'music' | 'photos';
export type IngestAction = 'move' | 'copy' | 'hardlink' | 'symlink';
export type IngestStatus = 'pending' | 'review' | 'organized' | 'error' | 'ignored';

export interface IngestSourceRow {
  id: number;
  name: string;
  kind: IngestKind;
  path: string;
  library_id: number | null;
  action: IngestAction;
  auto_match: 0 | 1;
  min_confidence: number;
  hold_unmatched: 0 | 1;
  recursive: 0 | 1;
  settle_seconds: number;
  enabled: 0 | 1;
  settings: string;
  created_at: string;
  updated_at: string;
  last_scan_at: string | null;
  last_result: string | null;
}

export interface IngestSourceStats {
  pending: number;
  review: number;
  organized: number;
  error: number;
  ignored: number;
}

export interface IngestSourceDTO {
  id: number;
  name: string;
  kind: IngestKind;
  path: string;
  libraryId: number | null;
  libraryName: string | null;
  destinationPath: string | null;
  action: IngestAction;
  autoMatch: boolean;
  minConfidence: number;
  holdUnmatched: boolean;
  recursive: boolean;
  settleSeconds: number;
  enabled: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  lastResult: unknown;
  counts: IngestSourceStats;
}

export interface IngestCandidateDTO {
  provider: string;
  providerId: string;
  kind: string;
  title: string;
  originalTitle?: string | null;
  year: number | null;
  overview?: string;
  rating?: number | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  popularity?: number;
  score: number;
}

export interface IngestItemRow {
  id: number;
  source_id: number;
  path: string;
  dest_path: string | null;
  name: string;
  ext: string | null;
  size_bytes: number | null;
  mtime: number | null;
  status: IngestStatus;
  parsed_title: string | null;
  parsed_year: number | null;
  parsed_season: number | null;
  parsed_episode: number | null;
  title: string | null;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  provider: string | null;
  provider_id: string | null;
  confidence: number | null;
  candidates: string;
  enrichment: string | null;
  media_id: number | null;
  library_id: number | null;
  error: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface IngestItemDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceKind: IngestKind;
  path: string;
  destPath: string | null;
  name: string;
  ext: string | null;
  sizeBytes: number | null;
  status: IngestStatus;
  parsed: {
    title: string | null;
    year: number | null;
    season: number | null;
    episode: number | null;
  };
  title: string | null;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  provider: string | null;
  providerId: string | null;
  confidence: number | null;
  candidates: IngestCandidateDTO[];
  mediaId: number | null;
  libraryId: number | null;
  error: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  media?: MediaDTO | null;
}

export interface IngestSettings {
  watch?: boolean;
  intervalSeconds?: number;
  providers?: string[];
}

export interface SiteSettings {
  serverName: string;
  tagline: string;
  accent: string;
  allowSignups: boolean;
  requireInvite: boolean;
  tmdbApiKey: string;
  tvdbApiKey: string;
  omdbApiKey: string;
  tvmazeEnabled: boolean;
  imdbEnabled: boolean;
  ingestWatch: boolean;
  ingestIntervalSeconds: number;
  transcodeEnabled: boolean;
  subtitleBurnIn: boolean;
  maxTranscodeHeight: number;
  transcodePreset: string;
  hwAccel: string;
  hwAccelDevice: string;
  hwAccelDecode: boolean;
  transcodeThrottleSeconds: number;
  scanOnStart: boolean;
  autoMatch: boolean;
  generateArt: boolean;
  allowRequests: boolean;
  allowParties: boolean;
  maintenanceMode: boolean;
  memes: boolean;
  telemetry: false;
}
