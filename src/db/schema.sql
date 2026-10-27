-- AISlopMediaBox schema. SQLite, WAL, all state lives in /data.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','manager','user')),
  avatar_hue    INTEGER NOT NULL DEFAULT 280,
  pin_hash      TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  preferences   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'user',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('movies','shows','music','photos','mixed')),
  path            TEXT NOT NULL,
  scan_schedule   TEXT NOT NULL DEFAULT 'daily' CHECK (scan_schedule IN ('manual','hourly','daily','weekly')),
  settings        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_scan_at    TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id      INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('movie','show','season','episode','artist','album','track','photo','video')),
  title           TEXT NOT NULL,
  sort_title      TEXT NOT NULL DEFAULT '',
  original_title  TEXT,
  year            INTEGER,
  release_date    TEXT,
  description     TEXT NOT NULL DEFAULT '',
  tagline         TEXT,
  rating          REAL,
  content_rating  TEXT,
  runtime_seconds INTEGER,
  path            TEXT NOT NULL UNIQUE,
  folder_path     TEXT,
  container       TEXT,
  size_bytes      INTEGER,
  mtime           INTEGER,
  hash            TEXT,
  video_codec     TEXT,
  audio_codec     TEXT,
  width           INTEGER,
  height          INTEGER,
  bitrate         INTEGER,
  fps             REAL,
  audio_tracks    TEXT NOT NULL DEFAULT '[]',
  chapters        TEXT NOT NULL DEFAULT '[]',
  parent_id       INTEGER REFERENCES media(id) ON DELETE CASCADE,
  season_number   INTEGER,
  episode_number  INTEGER,
  track_number    INTEGER,
  disc_number     INTEGER,
  album_id        INTEGER REFERENCES media(id) ON DELETE SET NULL,
  artist_id       INTEGER REFERENCES media(id) ON DELETE SET NULL,
  metadata_provider TEXT,
  metadata_id     TEXT,
  metadata_locked INTEGER NOT NULL DEFAULT 0,
  match_score     REAL,
  hidden          INTEGER NOT NULL DEFAULT 0,
  added_at        TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_library ON media(library_id, kind);
CREATE INDEX IF NOT EXISTS idx_media_parent ON media(parent_id);
CREATE INDEX IF NOT EXISTS idx_media_kind_year ON media(kind, year);
CREATE INDEX IF NOT EXISTS idx_media_album ON media(album_id);
CREATE INDEX IF NOT EXISTS idx_media_artist ON media(artist_id);
CREATE INDEX IF NOT EXISTS idx_media_sort ON media(sort_title);

CREATE TABLE IF NOT EXISTS media_art (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('poster','backdrop','thumb','banner','logo','art','avatar','disc')),
  path       TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  source     TEXT NOT NULL DEFAULT 'generated',
  created_at TEXT NOT NULL,
  UNIQUE (media_id, kind)
);

CREATE TABLE IF NOT EXISTS media_genres (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  genre    TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (media_id, genre)
);
CREATE INDEX IF NOT EXISTS idx_genres_genre ON media_genres(genre);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (media_id, tag)
);

CREATE TABLE IF NOT EXISTS media_people (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'cast',
  character TEXT,
  ord       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_people_media ON media_people(media_id);

CREATE TABLE IF NOT EXISTS subtitles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id     INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  language     TEXT NOT NULL DEFAULT 'und',
  label        TEXT NOT NULL,
  format       TEXT NOT NULL DEFAULT 'srt',
  is_external  INTEGER NOT NULL DEFAULT 0,
  path         TEXT,
  stream_index INTEGER,
  forced       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (media_id, stream_index, path)
);

CREATE TABLE IF NOT EXISTS collections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart')),
  rules       TEXT NOT NULL DEFAULT '{}',
  pinned      INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_id      INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (collection_id, media_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'mixed' CHECK (kind IN ('mixed','video','audio','photo')),
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
);

CREATE TABLE IF NOT EXISTS item_state (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  favorite   INTEGER NOT NULL DEFAULT 0,
  watched    INTEGER NOT NULL DEFAULT 0,
  rating     REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE TABLE IF NOT EXISTS progress (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id         INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  episode_id       INTEGER REFERENCES media(id) ON DELETE SET NULL,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  finished         INTEGER NOT NULL DEFAULT 0,
  play_count       INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error','cancelled')),
  progress   REAL NOT NULL DEFAULT 0,
  message    TEXT NOT NULL DEFAULT '',
  result     TEXT,
  error      TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'info',
  scope      TEXT NOT NULL DEFAULT 'app',
  message    TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);

CREATE TABLE IF NOT EXISTS streams (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  media_id     INTEGER REFERENCES media(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL DEFAULT 'direct',
  client       TEXT,
  position     REAL NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  bytes_sent   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'movie' CHECK (kind IN ('movie','show','music','other')),
  year        INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','fulfilled')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  media_id    INTEGER REFERENCES media(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  notes       TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS parties (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  host_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  media_id   INTEGER REFERENCES media(id) ON DELETE CASCADE,
  position   REAL NOT NULL DEFAULT 0,
  paused     INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS party_members (
  party_id  TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (party_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Ingestion: watched drop folders, automatic organization, review queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('movies','shows','music','photos')),
  path            TEXT NOT NULL UNIQUE,
  library_id      INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
  action          TEXT NOT NULL DEFAULT 'move' CHECK (action IN ('move','copy','hardlink','symlink')),
  auto_match      INTEGER NOT NULL DEFAULT 1,
  min_confidence  REAL NOT NULL DEFAULT 0.5,
  hold_unmatched  INTEGER NOT NULL DEFAULT 1,
  recursive       INTEGER NOT NULL DEFAULT 1,
  settle_seconds  INTEGER NOT NULL DEFAULT 15,
  enabled         INTEGER NOT NULL DEFAULT 1,
  settings        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_scan_at    TEXT,
  last_result     TEXT
);

CREATE TABLE IF NOT EXISTS ingest_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           INTEGER NOT NULL REFERENCES ingest_sources(id) ON DELETE CASCADE,
  path                TEXT NOT NULL,
  dest_path           TEXT,
  name                TEXT NOT NULL,
  ext                 TEXT,
  size_bytes          INTEGER,
  mtime               INTEGER,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','review','organized','error','ignored')),
  parsed_title        TEXT,
  parsed_year         INTEGER,
  parsed_season       INTEGER,
  parsed_episode      INTEGER,
  title               TEXT,
  year                INTEGER,
  season_number       INTEGER,
  episode_number      INTEGER,
  provider            TEXT,
  provider_id         TEXT,
  confidence          REAL,
  candidates          TEXT NOT NULL DEFAULT '[]',
  enrichment          TEXT,
  media_id            INTEGER REFERENCES media(id) ON DELETE SET NULL,
  library_id          INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
  error               TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_ingest_items_source ON ingest_items(source_id, status);
CREATE INDEX IF NOT EXISTS idx_ingest_items_status ON ingest_items(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_items_dest ON ingest_items(dest_path);
