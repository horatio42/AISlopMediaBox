# AISlopMediaBox — Architecture & Contributor Contract

> One container. One SQLite file. One brain cell. Zero cloud.

This document is the single source of truth for how the app is built. Read it before touching code.

## Stack

- **Runtime**: Node.js 24 running TypeScript directly (type stripping, no build step). Erasable TS only — no enums, namespaces, decorators, or parameter properties.
- **HTTP**: Express 5. One process serves the API, media streams, and the static SPA.
- **Storage**: SQLite via `better-sqlite3` (WAL). Schema: `src/db/schema.sql`. All state under `DATA_DIR` (default `./data`, Docker `/data`).
- **Media tooling**: system `ffmpeg`/`ffprobe` (installed in the image).
- **Frontend**: dependency-free ES modules + CSS. No CDN, no external fonts, no analytics. Everything under `public/`.
- **Tests**: `node --test` with the built-in test runner, real HTTP against a temp data dir. Each file starts its own server on an ephemeral port; helpers live in `test/helpers.ts`.
- **Docker**: one image (`node:24-bookworm-slim` + ffmpeg + tini/gosu), one entrypoint, one `/data` volume. No sidecars.

## Directory ownership

| Area | Files | Owner |
|---|---|---|
| Core | `src/server.ts`, `src/config.ts`, `src/db.ts`, `src/types.ts`, `src/lib/*` (auth/http/dto/logger/passwords) | Integration lead only |
| Scanning / metadata / libraries / browse / media / art | `src/routes/libraries.ts`, `src/routes/media.ts`, `src/routes/browse.ts`, `src/routes/art.ts`, `src/services/scanner.ts`, `src/services/metadata.ts`, `src/services/artwork.ts`, `src/services/ffprobe.ts` | Agent: Library |
| Ingestion / providers | `src/services/ingest.ts`, `src/routes/ingest.ts`, `src/services/providers.ts`, `src/services/metadata.ts` (scoring), `src/services/artwork.ts` (provider host allowlist), `src/routes/media.ts` (`/matches`, `/match`) | Agent: Ingestion |
| Playback | `src/routes/stream.ts`, `src/services/transcode.ts`, `src/services/subtitles.ts`, `src/services/playback.ts` | Agent: Playback |
| User state / social | `src/routes/progress.ts`, `src/routes/collections.ts`, `src/routes/playlists.ts`, `src/routes/parties.ts`, `src/routes/requests.ts`, `src/routes/users.ts` | Agent: Social |
| Admin / jobs / moderation | `src/routes/admin.ts`, `src/routes/jobs.ts`, `src/services/jobs.ts` | Agent: Admin |
| Music / photos | `src/routes/music.ts`, `src/routes/photos.ts` | Agent: Music/Photos |
| Frontend core | `public/index.html`, `public/login.html`, `public/js/app.js`, `api.js`, `router.js`, `ui.js`, `public/js/views/*` (home, browse, detail, search, collections, playlists, requests, profile), `public/css/base.css`, `app.css`, `account.css` | Agent: Frontend |
| Frontend player | `public/js/views/watch.js`, `music.js`, `photos.js`, `party.js`, `public/css/player.css` | Agent: Player |
| Admin UI | `public/admin.html`, `public/js/admin/*` (shell + section modules, including `ingest.js`), `public/css/admin.css` | Agent: Admin UI |
| Demo content | `scripts/demo-content.mjs`, `scripts/seed.ts` | Agent: Demo |
| Container | `Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`, `.env.example` | Integration lead |
| Docs / screenshots | `README.md`, `docs/**`, `scripts/screenshots.mjs` | Agent: Docs |

**Do not edit `src/server.ts`, `src/types.ts`, `src/lib/dto.ts`, or another agent's files.** If a contract is missing, implement locally and report it. Routes are mounted in `server.ts` at the prefixes below; replace the scaffold router in your own file, keep the export name.

## Core contracts

### Request / response

- JSON API under `/api`. Errors: HTTP status + `{ "error": { "code": "snake_case", "message": "human copy", "details": any } }`. Throw `HttpError` from `src/lib/http.ts`; Express 5 catches sync throws.
- Auth: session cookie `slop_session`, `SameSite=Strict`, `HttpOnly`. All routes below get `req.user`; `/api/admin/*` already requires admin. `requireManager` lives in `src/lib/auth.ts`.
- Every response with a user's state uses `mediaRowsToDTO(rows, userId)` from `src/lib/dto.ts` (batched art/progress/favorites/children). Never hand-roll media JSON.
- Pagination: `?page=1&pageSize=48` → `{ items, total, page, pageSize }` (`sendPage` helper).
- SSE: `/api/events` emits named events via `bus.publish(type, payload)` from `src/lib/logger.ts`. Use event names: `scan.progress`, `job.update` (admins only), `media.changed`, `settings.changed`, `party.sync`, `stream.started`, `stream.ended` (private to the stream owner + admins), `ingest.progress`, `ingest.item`, `ingest.source` (broadcast to signed-in clients; the admin UI consumes them). The bus sends a `: keepalive` every 25s.
- Mutations return `{ ok: true, ... }` or the created object. Validate every body with small local guards (`typeof`, ranges, allowlists). Never trust paths from clients.
- Timestamps: ISO strings via `nowISO()`. SQLite booleans: 0/1.

### Media model

A single `media` table holds every kind:
- `movie` — playable video. `path` = video file.
- `show` — container, `path` = show root folder; `season` children; `episode` children of season. Episodes have `season_number`/`episode_number`; shows compute counts from children.
- `artist` → `album` (`album.artist_id`) → `track` (`track.album_id`, `track.artist_id`). For a single-artist album folder, create artist + album + tracks. Album art: `<folder>/cover.jpg/png`, or ffmpeg embedded art.
- `photo` — image file; also store `video` for loose video files with kind `video`.
- `path` is globally `UNIQUE`. Parent shows/seasons/albums are synthetic rows whose `path` is the folder path (also unique).
- Art paths in `media_art` are **absolute file paths** on disk, generated/extracted under `/data/cache/images`; `media_art.kind` ∈ poster|backdrop|thumb|banner|logo|art|avatar|disc. `source` string is used for cache-busting (e.g. `generated`, `sidecar`, `ffmpeg`). Serve via `/api/art/:mediaId/:kind`.
- Sidecar metadata: `<basename>.nfo` Kodi XML, `poster.jpg`, `fanart.jpg`, `banner.jpg`, `logo.png`; also accept `movie.nfo`. Local-first: scans only call an enabled provider when configured and `autoMatch` is enabled; manual matching needs the provider configured/enabled but ignores `autoMatch` (see providers below).
- Ingestion state lives in `ingest_sources` and `ingest_items` (unique `(source_id, path)`, statuses `pending|review|organized|error|ignored`, parsed fields, provider/candidates/enrichment JSON, `dest_path`, `library_id`, `media_id`). Sources are admin-managed absolute directories with a kind, destination library, action, threshold, settle delay, auto-match/hold/recursive flags.
- Genres in `media_genres`, tags in `media_tags`, cast in `media_people`.
- Episodes are directly playable; shows/seasons are not. Resume/progress is per-user + per-media (episode rows get their own progress; `progress.episode_id` links show context).

### Scan pipeline (Library agent)

1. `POST /api/libraries/:id/scan` creates a `scan` job via `services/jobs.ts`. Respond immediately `202 { jobId }`. `POST /api/libraries/scan-all` queues every usable, idle library.
2. Walk library path with `fs.readdir` recursively (skip dotfiles, `@eaDir`, `#recycle`, `.git`, symlink loops). Classify by extension:
   - video: mkv, mp4, m4v, avi, webm, mov, wmv, flv, mpg, mpeg, ts, m2ts
   - audio: mp3, flac, m4a, aac, ogg, opus, wav, wma, alac, aiff, aif
   - image: jpg, jpeg, png, webp, gif, avif, bmp
3. Parse names: `Movie Title (2019) [1080p].mkv`; shows `Show Name/Season 01/S01E02 - Episode Title.mkv` plus `Show Name/Show Name - 1x02 - Title.mkv`. Music: `Artist/Album/01 - Track.flac` and flat folder fallback.
4. Probe with ffprobe (concurrency ≤4), parse streams (video/audio/subtitle), bitrate, fps, chapters, duration. `audio_tracks` stores `[{index,codec,channels,language,title,default}]`.
5. Upsert by `path`; skip unchanged files (same `mtime` + `size_bytes`); mark stale DB rows (`library`, absent path) hidden/deleted; recompute library aggregates; publish `scan.progress` events (0..1) and `media.changed` at the end.
6. Generate art: poster from sidecar or ffmpeg frame; thumbnail/video preview at 10%; photos: thumb. Use ffmpeg for all image work — no native image libs. Placeholder art is generated client-side, so art generation may be best-effort.
7. Subtitles: external `.srt/.vtt/.ass/.ssa` matching basename or `movie.en.srt` → `subtitles` rows (language from suffix). Embedded text subs discovered from ffprobe → rows with `stream_index`.
8. Metadata matching: local NFO first; folder/filename inference (title, year, season/episode); an enabled metadata provider optionally contributes when configured and eligible. Respect `metadata_locked`. Store provider/id/match_score. Never crash the scan on one bad file; collect warnings in job result.
9. Scheduler: startup scans for libraries unscanned/stale >24h when `scanOnStart` is enabled; a 15-minute interval queues due `hourly|daily|weekly` libraries without overlap. Demo libraries are auto-created on boot only when `DEMO_MODE=1` and no libraries exist.
10. Exports for other modules: `scanLibrary(libraryId, opts)`, `enqueueScan`, `scanCounts`, `isScanning`, `findActiveScanJob`.

### Ingestion pipeline (Ingestion agent)

Ingestion is a separate job type (`ingest`) that writes canonical files into a library and then asks the scanner to index them. It owns `src/services/ingest.ts` and `src/routes/ingest.ts`; `src/services/providers.ts` is the shared metadata provider registry (TMDB/TVDB/OMDb/TVmaze/IMDb suggestions).

1. **Bootstrap**: `ensureDataDirs()` creates `DATA_DIR/ingest/{movies,tv,music,photos}`. `ensureDefaultSources()` idempotently inserts four `move`/auto-match/threshold-0.5/hold sources only when the table is empty.
2. **Sources**: manager API validates an absolute existing directory, rejects the DB/app-data/cache/temp roots, duplicate paths, and source↔destination library containment in either direction (through realpath). Destination library = explicit kind-compatible library, else first matching library, else `MEDIA_DIR/ingested-<kind>` with a daily schedule.
3. **Discovery**: walk recursively with caps (50k entries, 2k new items/pass), skip dotfiles/partials/zero-byte and files newer than `settle_seconds`; accepted extensions by kind; upsert `ingest_items` by `(source_id, path)`; organize/ignore rows are settled unless the source file changed. Parsing reuses `metadata.ts` (`parseMovieFilename`, `parseEpisodeFilename`, `parseTrackFilename`, `parseSeasonFolder`, NFO lookup).
4. **Processing**: local baseline confidence (NFO 0.95, title+year 0.55, title-only 0.35, show episode 0.5, music/photo 0.6). If the source has auto-match on, eligible providers are searched; a best candidate `>= 0.55` is resolved and its normalized metadata merged (local fields win, provider art URLs). Below `min_confidence`, `hold_unmatched=1` parks the item in `review` with candidates; otherwise it organizes with parsed names.
5. **Organize**: pure `destPathFor()` naming, `sanitizeSegment()` per component, `safeJoin()` root containment, `uniquePath()` ` (2)` collision suffix. Actions: move (EXDEV copy+unlink fallback), copy, hardlink (copy fallback + note), symlink (absolute source target). Sidecars (same-stem subtitles/NFO, generic/show/album/artist NFO, recognized art) follow the same action; shared sidecars are not overwritten; a movie/show NFO contradicting the chosen title/year is skipped. Never overwrites.
6. **Index**: one `scanLibrary()` per destination library per batch, unless a scan is active (deferred note); items map to media rows by `dest_path`, then provider enrichment and allowlisted remote art are applied respecting `metadata_locked`. Single-item organize/manual match triggers a scan immediately.
7. **Watcher**: unref'd timer reads `ingestWatch`/`ingestIntervalSeconds` fresh each tick, runs cheap discovery, and enqueues only when new/changed work or pending items exist. `enqueueIngest()` refuses duplicates (`ingest_in_progress` with jobId); the job queue itself allows one job per type.
8. **Providers**: `providerStatuses()` reports configured/enabled/keyless/kinds/hosts/note; `searchProviders(kind, query, year, {limit, manual})` merges eligible providers, dedupes by `provider:providerId`, sorts score/popularity; `resolveProvider()` normalizes details to `Enrichment`. All network calls have an 8s timeout, never throw to callers, and never log keys. Auto eligibility requires configured + keyless toggle + global `autoMatch`; manual eligibility requires configured + keyless toggle. Art downloads are restricted to provider image hosts (`image.tmdb.org`, `artworks.thetvdb.com`, `static.tvmaze.com`, `m.media-amazon.com`).

### Playback (Playback agent)

- `GET /api/stream/:id/info` → `{ directPlay, reasons[], mode, container, videoCodec, audioCodec, width, height, bitrate, duration, audioTracks, subtitles[], hlsUrl, directUrl }`. Direct play allowed only for browser-safe combinations (`src/services/playback.ts`): container `mp4`/`m4v`/`mov`/`webm`; video `h264`/`av1`/`vp9` (plus `vp8` in webm); audio `aac`/`mp3`/`opus` (plus `vorbis` in webm); standalone audio files by extension. HEVC, MKV, and unknown codecs transcode. `force=1`/`forceTranscode=1`, alternate audio, or subtitle burn-in also force translate.
- `GET /api/stream/:id` serves the file with HTTP Range (206), correct `Content-Type`, `Accept-Ranges`, ETag. Used for audio and direct-play video.
- `GET /api/stream/:id/hls/master.m3u8?audio=<idx>&subtitle=<id>&burn=1&start=<sec>&psid=<id>` creates/reuses an ffmpeg HLS session under `/data/cache/transcode/<session>/`. Sessions are keyed by media, tab (`psid`), audio, subtitle, burn, height, preset, mode, and acceleration preference — not by start: a seek restarts the same session at the new offset, so scrubbing cannot exhaust the concurrency cap. Segments are MPEG-TS for re-encodes and fMP4 (`init_<n>.mp4` + `g<n>_seg_*.m4s`) for remuxes. Segment requests: `GET /api/stream/:id/hls/:session/:file` validating filename strictly. `POST /api/stream/:id/hls/release` releases a tab's sessions on unload; `DELETE .../:session` stops one. Sessions idle-timeout (default 90s, `TRANSCODE_IDLE_SECONDS` override) and are cleaned up. Cap concurrent transcodes (`config.transcodeConcurrency`), reclaim the same tab's old session first, then reject with `429`.
- Remux path: when the container is unsupported but the video codec is copy-safe (h264/AV1/VP9), ffmpeg copies video and only converts audio if needed. This avoids a full re-encode for the common MKV/H.264 case.
- Throttling: each live session's encoded-segment count is compared with the last segment the client requested; once it is `transcodeThrottleSeconds` ahead, ffmpeg gets `SIGSTOP` and `SIGCONT` on catch-up (Plex/Jellyfin-style). Segment filenames are generation-scoped so a seek cannot serve a browser-cached stale segment.
- Hardware acceleration: `src/services/hwaccel.ts` enumerates ffmpeg's encoders, probes each candidate with a real frame, maps `/dev/dri` render nodes to libva drivers (radeonsi/iHD), and records rejections. `auto` picks the best working encoder (NVENC > QSV/RKMPP > VAAPI > V4L2 > Vulkan); explicit preferences fall back to software rather than failing playback. A session that fails with hardware decode retries encode-only, then software. `GET /api/hwaccel` exposes the report to admins.
- `GET /api/stream/:id/subtitles/:subId.vtt` converts embedded/external subs to WebVTT (ffmpeg or a small SRT parser), caches to `/data/cache/subtitles`. Burn-in is requested on the HLS URL (`burn=1&subtitle=<id>`), which maps to an ffmpeg `subtitles` filter.
- `POST /api/stream/:id/progress` heartbeat: upsert `progress` (position, duration, finished ≥ 90% or last 30s), maintain `streams` row, publish SSE `stream.started`. `GET /api/stream/:id/progress` returns resume position.
- Audio playback of tracks uses Range direct file serving; album art via art API.
- Implement track switching by starting a new HLS session unless direct-play compatible. HLS session JSON sidecar records audio index, subtitle, start offset; playlist starts at `-ss` from resume.
- Never expose arbitrary files: media id must resolve to DB row; segment path must match `[A-Za-z0-9_.-]+` and exist under session dir.
- If ffmpeg unavailable, info says direct-only; endpoints return a clear 503 `{code:'transcode_unavailable'}`.

### Endpoint contract

All routes require auth unless stated. All list endpoints accept `page`, `pageSize`.

**System** (implemented): `/api/health`, `/api/branding`, `/api/stats`, `/api/activity`, `/api/events`, `/api/auth/*`.

**Libraries** `/api/libraries` (Library agent):
- `GET /` → `{ items: LibraryDTO[] }` (include itemCount/totalBytes/exists)
- `POST /` `{name, kind, path, scanSchedule?, settings?}` → 201 LibraryDTO. Validate that the path exists and is a directory; reject the app data/cache roots.
- `PATCH /:id`, `DELETE /:id` (delete DB items + art cache, never touch source files)
- `POST /:id/scan` → `202 { jobId }`, `POST /scan-all`
- `GET /:id/items?page&pageSize&sort` (top-level rows)
- `GET /:id/stats` → counts by kind, bytes, last scan, recent adds.
- `GET /folders?path=` → directory browser for admin path picker. Restrict to filesystem browsing: return dirs and media file counts; requires admin/manager. Absolute paths only. Do not leak outside? The admin chose the path; browsing whole FS is acceptable but never follow symlinks into loops.

**Media** `/api/media` (Library agent):
- `GET /:id` → detail `{ item, show?, season?, seasons, episodes, tracks, albums, subtitles, related, nextEpisode?, artist?, album? }`
- `GET /:id/children?season=` → episodes/tracks
- `PATCH /:id` (manager) `{title, description, year, rating, tagline, genres[], tags[], people[], contentRating, metadataLocked}` update + art refresh hook. Publishes `media.changed`.
- `DELETE /:id` (admin) hide=1 (never delete source files); `?hard=1` removes DB row only
- `POST /:id/refresh` (manager) re-probe + re-match + regenerate art → `{ok}`
- `GET /:id/matches?query&kind&year&limit` (manager) → `{ok,targetId,kind,query,year,providers,candidates}`
- `POST /:id/match` (manager) multi-provider match by id/query (legacy TMDB ids keep the key-required behavior)
- `GET /:id/subtitles` list rows.

**Browse/search/home** `/api/browse` (Library agent):
- `GET /` filters: `kind`, `libraryId`, `genre`, `tag`, `contentRating`, `yearFrom`, `yearTo`, `sort` (title|added|year|rating|runtime|random), `order`, `q`, `person`, `favorites`, `watched`, `unwatched`, `inProgress`, `page`, `pageSize`. Only top-level kinds by default (`movie`, `show`, `artist`, `album`, `photo`, `video`); `?includeChildren=1` unlocks.
- `GET /home` → `{ hero, rows: [{ id, title, kind, items }], continueWatching, recentlyAdded, genres, collections, stats }`. Rows: Continue Watching, Recently Added, Movies, Shows, Music, Collections, “Because You Like <genre>”, Certified Bangers (rating ≥ 7.5, random). Respects per-user progress and the server `memes` setting.
- `GET /search?q=` → grouped `{ query, items, groups: {movies, shows, episodes, people, albums, artists, tracks, photos, videos, genres}, total }`. Matches titles, original titles, descriptions, genres, and cast.
- `GET /filters` → `{ genres, years:[min,max], libraries, tags, contentRatings }`
- `GET /random` → `{ item }` (movies/shows/videos only)
- `GET /genres/:genre` (top-level items)

**Art** `/api/art` (Library agent):
- `GET /:mediaId/:kind` (auth; images for shows/albums derive from the first child if missing) — real images use `Cache-Control: private, max-age=86400, immutable` + ETag; the generated SVG fallback uses `private, max-age=3600` + ETag.
- `POST /:mediaId/:kind` (manager, raw image body ≤20 MB) writes the cache image + art row and publishes `media.changed`; art only, no metadata lock. `DELETE /:mediaId/:kind` (manager) removes the cache file and row.
- `GET /:mediaId` → art manifest.

**Progress / state** `/api/progress`, plus `/api/continue` & `/api/history` (Social agent):
- `PUT /api/progress/:mediaId` `{positionSeconds, durationSeconds, finished?, episodeId?}` → upsert own progress + watched state when finished; returns `{ok, progress, state}`. Auto-finish at 90% or within 30s of the end.
- `GET /api/progress/:mediaId` → own progress or null.
- `GET /api/continue?limit=` → in-progress items (movies + episodes), newest first, with show context.
- `GET /api/history?page&pageSize&kind=` → watched/progressed items.
- `DELETE /api/progress/:mediaId` → clear resume point.
- `PATCH /api/media/:mediaId/state` conflict with media route — instead: `PUT /api/progress/:mediaId/state` `{favorite?, watched?, rating?}` → upsert `item_state` and progress.watched sync. Return `{favorite, watched, rating}`.
- `POST /api/progress/:mediaId/favorite` toggle → `{favorite}` (convenience).
- `GET /api/progress/stats` → watch time totals, play counts, favorites, finished counts, top genres, streak (fun).
- The router is mounted at `/api/progress`, `/api/continue`, and `/api/history`; `/api/progress/continue` and `/api/progress/history` alias the latter two. Section is derived from `req.baseUrl`.

**Collections** `/api/collections` (Social):
- `GET /` → items incl. itemCount/art (poster from first item).
- `POST /` `{name, description?, kind:'manual'|'smart', rules?, pinned?, sortOrder?}`; `PATCH /:id`, `DELETE /:id` (creator/curator)
- `GET /:id` → collection + `items: MediaDTO[]` (smart rules evaluated at read time)
- `POST /:id/items` `{mediaIds:[...]}`; `DELETE /:id/items/:mediaId`; `PUT /:id/items` reorder `{mediaIds}`.
- Smart rules DSL: `{ match:'all'|'any', rules:[{field,op,value}] }`, fields kind, genre, year, rating, libraryId, addedWithinDays, tag, person, titleContains; ops eq|neq|gt|gte|lt|lte|in|contains, constrained per field. Max 20 rules; cap results at 500. Evaluated live at read time; invalid rules are a 400, never silently ignored. Pinning/sort order is curator-only; editing is creator/curator.
- Auto-seed pinned collections on first run if none: "Certified Bangers" (manual empty is fine), smart "Recently Added" (addedWithinDays 30), "Absolute Cinema" (rating ≥ 8), "The Vault" (year < 2000). Admin can edit.

**Playlists** `/api/playlists` (Social): CRUD, items add/remove/reorder, `GET /:id` with items; public lists visible to all, private only owner/admin. `POST /:id/duplicate`. Kinds `mixed|video|audio|photo` (mixed excludes photos), max 500 items; `PUT /:id/items` reorders supplied ids and keeps omitted ones after them.

**Requests** `/api/requests` (Social): `GET /` (own; managers see all unless `mine=1`; `status` filter), `POST /` `{title, kind, year?, note?}` (respect `allowRequests`, 10/hour/user), `PATCH /:id` (manager review `{status, reviewNote}`; pending→approved/rejected/fulfilled, approved→fulfilled), `DELETE /:id` (own pending or admin). Also `GET /stats`, `POST /reports` `{reason, mediaId?|title?}`, `GET /reports/mine`.

**Parties** `/api/parties` (Social): `POST /` `{name, mediaId}` → party; `GET /` active public (`?mediaId`); `GET /:id`; `POST /:id/join`; `POST /:id/leave`; `POST /:id/state` host/admin only `{position, paused}`; `DELETE /:id` host/admin. State publishes `party.sync` globally (clients filter by `partyId`); host leaving ends the party; max 20 attendees; respects `allowParties`.

**Users/profile** `/api/users` (Social): `GET /me`, `PATCH /me` `{displayName?, preferences?, avatarHue?}`, `POST /me/password` `{current, next}`, `GET /me/export` (full JSON of own state), `DELETE /me` `{password}` (self-delete; refuses the last admin). Admin listing/CRUD lives in admin routes. Do NOT allow role escalation here.

**Music** `/api/music` (Music/Photos):
- `GET /` overview `{ recentTracks, recentlyPlayed, recentlyAdded, artists, albums, playlists, genres, stats }`
- `GET /artists?sort&page&pageSize`, `GET /artists/:id` (artist + albums + top tracks)
- `GET /albums?sort&page&pageSize&artistId`, `GET /albums/:id` (album + tracks + artist)
- `GET /tracks?page&pageSize&sort&albumId&artistId&genre&q` (flat, playable; default 100, max 500), `GET /tracks/:id` (track + album + artist)
- `GET /recently-played?limit=` from progress joined to tracks; `GET /genres`
- All return MediaDTOs via DTO helper.

**Photos** `/api/photos` (Music/Photos):
- `GET /?page&pageSize&sort&from&to&folder` → photos (library kind photos); `GET /timeline` → groups by month with cover + count; `GET /:id` → photo + neighbors; folder groups: `GET /folders`, `GET /folders/items?path=`, `GET /folders/root/items`, `GET /folders/:folderPath/items`. Folder paths are relative and `..` is rejected.
- Photos serve originals through `GET/HEAD /api/photos/:id/file` with byte ranges (optionally `?download=1`); thumbs use the art API.

**Ingestion** `/api/ingest` (Ingestion agent, manager/admin):
- `GET /sources` → `{items: IngestSourceDTO[]}` (destination preview + counts); `POST /sources` validates `{name, kind, path, libraryId?, action?, autoMatch?, minConfidence?, holdUnmatched?, recursive?, settleSeconds?, enabled?}`; `GET/PATCH/DELETE /sources/:id`. Delete removes source/items only, never files.
- `POST /sources/:id/scan` → `{ok, jobId, sourceId}`; `POST /scan-all` → one ingest job for enabled sources; duplicate enqueue = `409 ingest_in_progress` with `jobId`.
- `GET /items?status&sourceId&q&page&pageSize` → paginated items + status counts; `GET /items/:id` includes providers and mapped media.
- `POST /items/:id/search` `{query?}` manual provider search (stores candidates); `POST /items/:id/match` `{provider, providerId}` or manual `{title, year?}` (+ season/episode/episodeTitle/overview for shows); `POST /items/:id/organize`, `/ignore`, `/retry`.
- `GET /providers` → `ProviderStatus[]`; `GET /stats` → counts, watcher config, recent organized/errors, providers.

**Jobs** `/api/jobs` (Admin):
- `GET /?status&type&page&pageSize` (manager only) → JobDTO list + counts; `GET /:id` (owner/manager; redacted for users); `POST /:id/cancel` (owner/manager); `DELETE /history?olderThanDays=` (admin); `GET /active`.
- Job queue service: persistent DB-backed, **3 jobs globally and 1 per type**, `create(type, payload, createdBy)`, `update`, `finish`, `fail`, `cancel`, `registerHandler(type, fn)`, SSE `job.update`. Expose `jobQueue` singleton. On boot, mark stale queued/running jobs as error ("Server restarted mid-job") and resume nothing automatically.
- Handlers registered by scanner etc. via `registerHandler`. Circular imports: handlers import jobs, jobs doesn't import handlers.

**Admin** `/api/admin` (Admin):
- `GET /overview` → server health, counts, disk usage (statfs), memory, uptime, active streams, recent logs, job stats, storage by library, top media, watch stats.
- `GET/PATCH /settings` (all SiteSettings keys); validate. PATCH publishes `settings.changed`.
- `GET /logs?level&scope&q&page`; `DELETE /logs`; `GET /logs/export` (JSONL download).
- `GET /users?q&role&sort&order&page`, `POST /users` `{username,password,role,displayName}`, `PATCH /users/:id` `{role,disabled,displayName,pin?}`, `DELETE /users/:id` (not last admin, not self), `POST /users/:id/reset-password` `{password?}` (blank generates one).
- `POST /invites` `{role?,ttlHours?}` → code; `GET /invites`; `DELETE /invites/:id`.
- Moderation: `GET /reports?status`, `PATCH /reports/:id` `{status,notes}`. Creation lives in Social: `POST /api/requests/reports` `{reason, mediaId?|title?}` and `GET /api/requests/reports/mine`. Admin review lives here.
- `GET /requests`, `PATCH /requests/:id` — admin review (alias in admin for convenience).
- `POST /maintenance` `{action:'optimize'|'vacuum'|'clear-cache'|'regenerate-art'|'reindex', targets?, mediaId?}`. `optimize`: PRAGMA optimize + ANALYZE; vacuum: WAL checkpoint + VACUUM; clear-cache: targets default `transcode,subtitles,temp` (`images` also deletes art rows); regenerate-art: enqueues an `art` job; reindex: queues `probe`, falls back to forced scans, then SQLite `REINDEX`.
- `GET /storage` → per-library bytes, image cache bytes, db size, free disk.
- `GET /privacy` → live audit of outbound network: provider configured/toggle/keySource state, every host/mode endpoint, `zeroOutbound`, telemetry false, external asset count (0), cookie/hash/data settings.
- `GET /export` → full instance backup JSON metadata (not media bytes). `POST /import` metadata JSON.

### Frontend contract

- SPA booted by `public/js/app.js`. Views are ES modules default-exporting `async function render(container, ctx)` where `ctx = { params, query, signal, navigate, meta }`; return optional cleanup.
- Use `api.js` helpers (`get/post/patch/del`, `placeholderArt`, `artFor`, formatting) and `ui.js` (`h`, `cardLink`, `rail`, `posterGrid`, `emptyState`, `modal`, `toast`, icons). Use `data-link` for internal anchors; use `navigate()` for programmatic routing.
- Route table (fixed, do not change paths): `/`, `/browse/:kind`, `/item/:id`, `/watch/:id`, `/music`, `/music/:tab`, `/photos`, `/search`, `/collections`, `/collections/:id`, `/playlists`, `/playlists/:id`, `/requests`, `/profile`, `/party`, `/party/new`, `/party/:id`, `/tv`.
- Views other agents own: `views/watch.js` (video player), `views/music.js` (music + Plexamp UI), `views/photos.js`, `views/party.js`. Frontend agent owns the rest + shell.
- Playback UI: `/watch/:id` full-screen custom player with controls fade, seek, volume, subtitles/audio menus, playback speed, PiP, keyboard shortcuts (space/k, ←→ 10s, ↑↓ volume, f, m, c, s, esc), resume prompt, autoplay next, "Direct Play" vs "Transcoding" honesty badge with reasons, and party sync listener. HLS playback: Safari native; Chromium/Firefox use the vendored `public/vendor/hls.min.js` (no CDN). If hls.js is unavailable, the player shows a clear error and direct play still works.
- Music: persistent mini-player, queue with shuffle/repeat, album track list, artist pages, Plexamp-style now-playing with big art, audio visualizer (CSS bars to audio analyser), playlist add.
- Photos: masonry timeline, lightbox with arrows/zoom/download, keyboard, EXIF-ish details, slideshow.
- Admin UI: standalone `/admin` page with hash router: `#dashboard`, `#libraries`, `#ingest`, `#media`, `#users`, `#requests`, `#moderation`, `#jobs`, `#logs`, `#storage`, `#settings`, `#privacy`. Modules under `public/js/admin/`. Forms + tables, CSS/SVG charts, no chart libs. Admin-only; non-admin sessions redirect. Uses the same `/api/admin` endpoints.
- Design language: Apple TV spaciousness + shitpost copy. Tokens in `base.css` (accent lime #c8ff3d, pink #ff4d9d, violet #7b5cff, dark #09080d). Rounded cards, soft glow, big type, ribbons/pills, meme microcopy but readable. Mobile bottom nav. TV mode keyboard nav. Respect reduced motion.
- No inline `<script>` (CSP), no external assets, no eval. Inline styles are allowed via `style` attributes from JS.

### Meme copy rules

Funny, not cringe. Reference formats obliquely ("certified", "based", "ratio", "skill issue", "touch grass", "no thoughts head empty", "absolute cinema", "L + ratio", "it insists upon itself", "goated", "peak fiction", "cope", "seethe"). Do not punch down, no slurs, no politics, no crypto. Memes are seasoning, not the meal: every screen still must be obvious and usable. Admin copy stays mostly professional with occasional dry jokes.

### Privacy

- Zero outbound requests by default. Block external URLs in CSP. No fonts/CDNs/telemetry/analytics. Provider keys/toggles (TMDB, TVDB, OMDb, keyless TVmaze/IMDb) are explicit opt-ins; show the live registry and hosts in UI. Keys are never logged or broadcast. Logs stay local. `/data` export is user-controlled. Password hashes with scrypt. No password recovery email (there is no email).
- Do not log passwords, tokens, cookies, or full file contents.

### Commands

```bash
npm run dev        # node --watch --experimental-strip-types src/server.ts
npm run typecheck  # tsc --noEmit
npm test           # node --test --experimental-strip-types test/*.test.ts
npm run demo       # synthesize demo media under $MEDIA_DIR
npm run seed       # create demo libraries and queue scans when a server is up
DATA_DIR=test/tmp/data PORT=3999 node src/server.ts   # isolated test server
SLOP_URL=http://127.0.0.1:4400 node scripts/screenshots.mjs  # docs screenshots
```

Seed/demo content scripts write under `data/media`. Use `ffmpeg` locally to synthesize fixtures when testing.

### Definition of done for every slice

- Every endpoint in your slice implemented, validated, permission-checked.
- `npm run typecheck` clean.
- Smoke-tested with curl against a real server (paste evidence in final summary) OR automated tests if your agent owns tests.
- SSE events published where specified.
- No TODOs, stubs, dead routes, or fabricated data.
