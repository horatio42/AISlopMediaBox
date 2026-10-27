# API reference

A small, honest JSON API. Everything is same-origin and cookie-authenticated; there are no API keys
and no CORS party. This page is a map, not a generated OpenAPI dump.

- Base path: `/api`
- Auth: session cookie `slop_session` (`HttpOnly`, `SameSite=Strict`; `Secure` when `SECURE_COOKIES=1`)
- Content type: `application/json` for requests and responses; streaming/art endpoints return bytes
- Mutations with an `Origin` header are rejected if the origin host differs from `Host`
- Rate-limited failures include `Retry-After` (login, register, password, requests, reports)

Auth levels used below:

| Level | Meaning |
|---|---|
| public | no session required (`/api/health`, `/api/branding`, `/api/auth/*`) |
| user | any signed-in account |
| manager | `admin` or `manager` |
| admin | `admin` only |

## Errors and pagination

```json
{
  "error": {
    "code": "not_found",
    "message": "Nothing here but vibes.",
    "details": { "optional": "context" }
  }
}
```

Always check the HTTP status first. Common codes: `bad_request`, `unauthorized`, `forbidden`,
`not_found`, `conflict`, `rate_limited`, `invalid_credentials`, `scan_in_progress`,
`transcode_unavailable`, `maintenance`, `csrf`, `invalid_rules`, `last_admin`, `internal_error`,
`ingest_in_progress`, `already_organized`, `item_ignored`, `organize_failed`, `no_match`, `bad_provider`.

Paginated list endpoints return:

```json
{ "items": [], "total": 0, "page": 1, "pageSize": 48 }
```

`page` starts at 1. `pageSize` is clamped per endpoint (usually 200; plays/tracks can be higher).
Boolean query flags accept `1`, `true`, `yes`, `on`.

## Auth

| Method | Path | Auth | Body / notes |
|---|---|---|---|
| GET | `/auth/me` | public | `200 { authenticated:false, allowSignups, serverName }` or `{ authenticated:true, user, serverName }` |
| POST | `/auth/login` | public | `{ username, password, pin? }` → sets cookie, returns `{ ok, user }` |
| POST | `/auth/logout` | user | destroys the current session |
| POST | `/auth/register` | public | `{ username, password, displayName?, invite? }`; respects `allowSignups` / `requireInvite` |
| GET | `/auth/invites/check/:code` | public | `{ valid: boolean }` |
| POST | `/auth/pin` | user | `{ pin: "1234" \| null }` (4–8 digits, hashed) |
| GET | `/auth/sessions` | user | own sessions with `current` flag |
| DELETE | `/auth/sessions/:id` | user | revoke own session; current session also clears the cookie |

Login rate limit: 10 attempts / 5 minutes / IP. Register: 5 / hour / IP.

```bash
curl -c slop.cookies -H 'content-type: application/json' \
  -d '{"username":"admin","password":"slop123"}' \
  http://localhost:3100/api/auth/login
```

Use `-b slop.cookies` on every subsequent request. A `401` means the cookie is absent/expired; a
`403` with `csrf` means your proxy changed the `Host` without preserving `Origin`.

The numeric IDs used in examples below come from the generated demo library. On your instance, take
real IDs from `/api/browse` or `/api/media/:id` responses.

## System

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/health` | public | `{ ok, name, version, env, startedAt, node, uptimeSeconds, sseClients, db, maintenance }` |
| GET | `/branding` | public | server name, tagline, accent, feature flags, version, demo mode |
| GET | `/stats` | user | counts by kind, total items/bytes, libraries, users, server info |
| GET | `/activity` | admin | recent streams, SSE client count, start time (`?limit=1..100`) |
| GET | `/events` | user | SSE stream (see below) |

## Libraries

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/libraries` | user | `{ items: LibraryDTO[] }` with item counts/bytes/`exists` |
| GET | `/libraries/folders?path=` | manager | directory browser; absolute path, directories only, symlinks skipped |
| GET | `/libraries/:id` | user | `{ item }` |
| GET | `/libraries/:id/items?page&pageSize&kind&sort` | user | top-level rows; sort `title\|added\|year\|rating\|runtime\|random` |
| GET | `/libraries/:id/stats` | user | counts, bytes, hidden count, last scan, recent items |
| POST | `/libraries` | manager | `{ name, kind, path, scanSchedule?, settings? }` → `201` |
| PATCH | `/libraries/:id` | manager | same fields; path revalidated; no duplicate paths |
| DELETE | `/libraries/:id` | manager | DB rows + cached art; source files untouched; rejects mid-scan |
| POST | `/libraries/:id/scan` | manager | `202 { ok, jobId }`; `409 scan_in_progress` with `details.jobId` if busy |
| POST | `/libraries/scan-all` | manager | `202 { ok, jobIds, skipped }` |

Kinds: `movies`, `shows`, `music`, `photos`, `mixed`. Schedules: `manual`, `hourly`, `daily`, `weekly`.
Paths must be absolute directories and cannot be the app's data/cache/temp roots.

## Media

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/media/:id` | user | `{ item, show?, season?, seasons, episodes, tracks, albums, subtitles, related, nextEpisode?, artist?, album? }` |
| GET | `/media/:id/children?season&page&pageSize` | user | seasons, episodes, albums, or tracks depending on kind |
| GET | `/media/:id/subtitles` | user | `{ items, total }` |
| PATCH | `/media/:id` | manager | title, description, year, rating, tagline, contentRating, metadataLocked, genres[], tags[], people[] |
| DELETE | `/media/:id` | admin | hide by default; `?hard=1` removes DB rows + art (never files) |
| POST | `/media/:id/refresh` | manager | re-probe, local metadata, art; `{ ok, warnings, item }` |
| GET | `/media/:id/matches?query&kind&year&limit` | manager | `{ ok, targetId, kind, query, year, providers, candidates }`; manual search across configured providers |
| POST | `/media/:id/match` | manager | `{ provider?, providerId?, query?, title?, year? }` or legacy `{ id \| tmdbId \| query }`; resolves, applies metadata/art |

`people` entries: `{ name, role?, character? }`. Genres/tags cap at 20 items. `metadataLocked: true`
prevents scans/refreshes from overwriting manual edits.

## Ingestion

Manager/admin only (`/api/ingest`, `requireAuth` + `requireManager`). Browse/player endpoints never expose
ingest items to normal users. See [Ingestion](INGESTION.md) for concepts and naming.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/ingest/sources` | — | `{ items: IngestSourceDTO[] }` with destination preview and per-status counts |
| POST | `/ingest/sources` | `{ name, kind, path, libraryId?, action?, autoMatch?, minConfidence?, holdUnmatched?, recursive?, settleSeconds?, enabled? }` | `201 { ok, item }`. Absolute existing dir; unique; not the data root, DB file, or cache/temp trees; no source↔library overlap |
| GET | `/ingest/sources/:id` | — | `{ item }` |
| PATCH | `/ingest/sources/:id` | same fields, partial | Non-empty patch; revalidates path/kind/library |
| DELETE | `/ingest/sources/:id` | — | `{ ok, sourceId, removedItems, files:'untouched, obviously' }`; never deletes files |
| POST | `/ingest/sources/:id/scan` | — | `{ ok, jobId, sourceId }`; one ingest job at a time |
| POST | `/ingest/scan-all` | — | `{ ok, jobId }`; processes all **enabled** sources |
| GET | `/ingest/items?status&sourceId&q&page&pageSize` | — | `{ items, total, page, pageSize, counts }`; page 1/25 default, max 200; q ≤200 |
| GET | `/ingest/items/:id` | — | `{ item, providers }`; item includes `media` when mapped |
| POST | `/ingest/items/:id/search` | `{ query? }` | `{ ok, item, candidates, providers }`; manual provider search; music/photos return empty |
| POST | `/ingest/items/:id/match` | `{ provider, providerId }` or `{ title, year? }` (+ show `season?`, `episode?`, `episodeTitle?`, `overview?`) | `{ ok, item, destPath, mediaId, libraryId, message }`; organizes and scans immediately |
| POST | `/ingest/items/:id/organize` | — | Organize with parsed fields; same response shape |
| POST | `/ingest/items/:id/ignore` | — | `{ ok, item }`; file untouched |
| POST | `/ingest/items/:id/retry` | — | `{ ok, item, outcome }`; resets pending and reprocesses |
| GET | `/ingest/providers` | — | `{ providers: ProviderStatus[] }` with `configured`, `enabled`, `keyless`, `kinds`, `hosts`, `note`; never keys |
| GET | `/ingest/stats` | — | counts, source totals, watcher `{ enabled, intervalSeconds, activeJobId }`, recent organized/errors, providers |

Source defaults: `action:'move'`, `autoMatch:true`, `minConfidence:0.5`, `holdUnmatched:true`,
`recursive:true`, `settleSeconds:15`, `enabled:true`. `kind` is `movies|shows|music|photos`;
`action` is `move|copy|hardlink|symlink`; `minConfidence` is 0–1; `settleSeconds` is an integer 0–3600.
`libraryId` must exist and accept the kind (`shows` needs a `shows` library; the other kinds accept their
own kind or `mixed`).

Ingest errors: missing source/item `404 not_found`; bad path/body/provider `400 bad_request`;
duplicate path, organized/ignored guard, or active job `409` (`ingest_in_progress` includes
`details.jobId`); provider returned nothing `422 no_match`; transfer/destination failure
`422 organize_failed`. An organized item cannot be matched/organized/ignored/retried again.

Provider keys/toggles are settings (admin): `tmdbApiKey`, `tvdbApiKey`, `omdbApiKey` (strings; empty
clears), `tvmazeEnabled`, `imdbEnabled`, `autoMatch`, `ingestWatch`, `ingestIntervalSeconds` (integer
5–3600). Keyless providers default off. Manual search needs the provider configured/enabled; automatic
search additionally needs `autoMatch` and the source `autoMatch` flag. Keys are redacted from
`settings.changed`; they are visible to admins via `GET /api/admin/settings` and never logged or
included in instance exports.

## Browse, search, home

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/browse` | user | filtered top-level list |
| GET | `/browse/home` | user | `{ hero, rows, continueWatching, recentlyAdded, genres, collections, stats }` |
| GET | `/browse/search?q=` | user | `{ query, items, groups, total }`; empty `q` returns empty groups |
| GET | `/browse/filters` | user | `{ genres, years:[min,max], libraries, tags, contentRatings }` |
| GET | `/browse/random` | user | `{ item }`; movies/shows/videos only |
| GET | `/browse/genres/:genre` | user | `{ genre, items, total, page, pageSize }` |

`GET /api/browse` query parameters:

| Param | Values |
|---|---|
| `kind` | comma list; aliases `movies`, `shows`, `episodes`, `albums`, `tracks`, … |
| `includeChildren` | `1` to allow seasons/episodes/tracks |
| `libraryId`, `genre`, `tag`, `person`, `contentRating` | filters |
| `yearFrom`, `yearTo` | 1800–2200 |
| `q` | ≤120 chars; title/original title/description/genre/cast |
| `favorites`, `watched`, `unwatched`, `inProgress` | booleans |
| `sort` | `title`, `added`, `year`, `rating`, `runtime`, `random` |
| `order` | `asc` / `desc` |
| `page`, `pageSize` | pagination (max 200) |

`groups` keys: `movies`, `shows`, `episodes`, `people`, `albums`, `artists`, `tracks`, `photos`,
`videos`, `genres`. People entries are `{ name, role, count, mediaId, mediaTitle, mediaKind }`;
genres are `{ name, count }`.

```bash
curl -b slop.cookies \
  'http://localhost:3100/api/browse?kind=movies&sort=rating&order=desc&pageSize=5'
```

## Artwork

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/art/:mediaId` | user | manifest of available kinds/URLs |
| GET | `/art/:mediaId/:kind` | user | image bytes; generated SVG fallback; private cache |
| POST | `/art/:mediaId/:kind` | manager | raw image body (`image/*`, ≤20 MB); writes cache and index; publishes `media.changed` |
| DELETE | `/art/:mediaId/:kind` | manager | removes cache file + art row |

Kinds: `poster`, `backdrop`, `thumb`, `banner`, `logo`, `art`, `avatar`, `disc`. Art URLs are exposed
in `MediaDTO.art` and can be used directly as `<img src>` (cookies are same-origin).

## Progress and state

Mounted at three prefixes:

- `/api/progress` — writes, reads, state, stats
- `/api/continue` — resume rail
- `/api/history` — watched/progressed list

| Method | Path | Auth | Notes |
|---|---|---|---|
| PUT | `/progress/:mediaId` | user | `{ positionSeconds, durationSeconds?, finished?, episodeId? }` |
| GET | `/progress/:mediaId` | user | `{ progress, state, durationSeconds }` |
| DELETE | `/progress/:mediaId` | user | clears the resume position |
| PUT | `/progress/:mediaId/state` | user | `{ favorite?, watched?, rating? }` (rating 0–10 or `null`) |
| POST | `/progress/:mediaId/favorite` | user | toggles favorite → `{ ok, favorite }` |
| GET | `/progress/stats` | user | total seconds/minutes/hours, plays, favorites, finished counts, top genres, streaks |
| GET | `/continue?limit=` | user | in-progress items, episode-aware, one entry per show |
| GET | `/history?page&pageSize&kind` | user | watched/progressed items |
| GET | `/progress/continue`, `/progress/history` | user | identical to the `/api/continue` / `/api/history` mounts |

A title is auto-finished at 90% or within the last 30 seconds (when duration ≥ 60s). Finishing also
sets `watched=1`.

```bash
curl -b slop.cookies -X PUT -H 'content-type: application/json' \
  -d '{"positionSeconds":12,"durationSeconds":41}' \
  http://localhost:3100/api/progress/1
```

## Streaming

All require `user`. The media row must be playable (`movie`, `episode`, `video`, `track`).

| Method | Path | Notes |
|---|---|---|
| GET | `/stream/:id/info` | playback decision, codecs, tracks, subtitles, transcode availability, `hlsUrl`, `directUrl`, `reasons[]` |
| GET | `/stream/:id` | byte-range file response (`206`), correct MIME, `ETag`, `Accept-Ranges` |
| GET | `/stream/:id/progress` | resume point for the current user |
| POST | `/stream/:id/progress` | heartbeat `{ positionSeconds, durationSeconds?, finished?, ended?, mode?, sessionId?, bytesSent?, client? }` |
| GET | `/stream/:id/subtitles` | subtitle list |
| GET | `/stream/:id/subtitles/:subId.vtt` | WebVTT conversion (cached) |
| GET | `/stream/:id/hls/master.m3u8?audio&subtitle&burn&start&psid` | create/reuse an HLS session; seeks restart the same session at `start`. `psid` is a per-tab playback id |
| GET | `/stream/:id/hls/:sessionId/:file` | playlist/segment bytes; filename strictly validated |
| POST | `/stream/:id/hls/release` | body `{ psid }`; release every session owned by this playback tab (send on unload) |
| DELETE | `/stream/:id/hls/:sessionId` | stop a session (owner or manager) |
| GET | `/hwaccel` | admin only; live probe of working encoders/devices plus rejections and SoC notes (`?refresh=1` re-probes) |

`info` query flags: `force=1` / `forceTranscode=1`, `audio=<index>`, `subtitle=<id>`, `burn=1`,
`start=<seconds>`. Mode is `direct`, `remux` (video copied into fMP4 HLS; audio re-encoded only
when needed), or `transcode`. `transcode.hardware` reports the selected encoder and
`transcode.hwaccel.available` lists every encoder that passed a real smoke encode. Saturation
returns `429`; missing ffmpeg returns `503 transcode_unavailable`.

## Collections

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/collections` | user | paginated; counts, cover art; seeds pinned defaults on first read |
| POST | `/collections` | user | `{ name, description?, kind:'manual'\|'smart', rules?, pinned?, sortOrder? }` |
| GET | `/collections/:id` | user | collection + evaluated `items` |
| PATCH | `/collections/:id` | creator/manager | name, description, rules, pinned, sortOrder |
| DELETE | `/collections/:id` | creator/manager | |
| POST | `/collections/:id/items` | creator/manager | `{ mediaIds:[...] }` (manual only) |
| DELETE | `/collections/:id/items/:mediaId` | creator/manager | |
| PUT | `/collections/:id/items` | creator/manager | reorder `{ mediaIds:[...] }` |

Smart rules:

```json
{
  "match": "all",
  "rules": [
    { "field": "kind", "op": "eq", "value": "movie" },
    { "field": "rating", "op": "gte", "value": 8 },
    { "field": "addedWithinDays", "op": "lte", "value": 30 }
  ]
}
```

Fields/operators: `kind` (`eq|neq|in`), `genre`/`tag` (`eq|neq|in|contains`), `person`
(`eq|neq|contains`), `year` (`eq|neq|gt|gte|lt|lte|in`), `rating` (`eq|neq|gt|gte|lt|lte`),
`libraryId` (`eq|neq|in`), `addedWithinDays` (`eq|lt|lte|gt|gte`), `titleContains`
(`eq|contains`). Max 20 rules, max 500 results. Results are evaluated at read time.

```bash
curl -b slop.cookies -X POST -H 'content-type: application/json' -d '{
  "name": "API Certified Cinema",
  "description": "Created by the API docs example.",
  "kind": "smart",
  "rules": {
    "match": "all",
    "rules": [
      { "field": "kind", "op": "eq", "value": "movie" },
      { "field": "rating", "op": "gte", "value": 8 }
    ]
  }
}' http://localhost:3100/api/collections
```

## Playlists

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/playlists?mine&kind&page&pageSize` | user | public lists + own; admins see all |
| POST | `/playlists` | user | `{ name, description?, kind:'mixed'\|'video'\|'audio'\|'photo', isPublic? }` |
| GET | `/playlists/:id` | user | visible list + `items` |
| PATCH | `/playlists/:id` | creator/admin | name, description, kind, isPublic |
| DELETE | `/playlists/:id` | creator/admin | |
| POST | `/playlists/:id/duplicate` | user | clones name/kind/visibility and items |
| POST | `/playlists/:id/items` | creator/admin | `{ mediaIds:[...] }` |
| DELETE | `/playlists/:id/items/:mediaId` | creator/admin | |
| PUT | `/playlists/:id/items` | creator/admin | reorder supplied ids; omitted items keep relative order after them |

Kinds accept: `video` → movies/episodes/videos, `audio` → tracks, `photo` → photos, `mixed` →
video + audio (photos are not mixed). Max 500 items.

## Requests, reports

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/requests?mine&status&page&pageSize` | user | own by default; managers see all unless `mine=1` |
| GET | `/requests/stats?mine` | user | counts by status + `allowRequests` |
| POST | `/requests` | user | `{ title, kind:'movie'\|'show'\|'music'\|'other', year?, note? }` |
| PATCH | `/requests/:id` | manager | `{ status, reviewNote? }`; transitions pending→approved/rejected/fulfilled, approved→fulfilled |
| DELETE | `/requests/:id` | owner (pending) / admin | |
| POST | `/requests/reports` | user | `{ reason, mediaId? , title? }` (one of mediaId/title required) |
| GET | `/requests/reports/mine` | user | own reports, paginated |

Request and report creation are limited to 10/hour/user.

## Watch parties

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/parties?mediaId&page&pageSize` | user | active public parties |
| POST | `/parties` | user | `{ name, mediaId }` → `201` party |
| GET | `/parties/:id` | user | party, media, members, host flag |
| POST | `/parties/:id/join` | user | max 20 members |
| POST | `/parties/:id/state` | host/admin | `{ position?, paused? }`; publishes `party.sync` |
| POST | `/parties/:id/leave` | member | host leaving ends the party |
| DELETE | `/parties/:id` | host/admin | ends the party |

`position` is clamped to the media runtime. Parties respect `allowParties`.

## Users / profile

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/users/me` | user | profile + `hasPin`, `activeSessions`, `stats` |
| PATCH | `/users/me` | user | `{ displayName?, avatarHue?, preferences? }`; no role escalation |
| POST | `/users/me/password` | user | `{ current, next }`; revokes other sessions |
| GET | `/users/me/export` | user | downloadable JSON of own state |
| DELETE | `/users/me` | user | `{ password }`; refuses last admin; clears cookie |

Preferences allowlist: `theme` (`slop|dark|light|midnight`), `autoPlayNext`, `reduceMotion`,
`spoilerBlur`, `memes` (booleans), `cardDensity` (`cozy|compact`), `defaultSubtitle`,
`defaultAudio` (strings ≤40 chars).

## Music

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/music` | user | `{ recentTracks, recentlyPlayed, recentlyAdded, artists, albums, playlists, genres, stats }` |
| GET | `/music/artists?sort&page&pageSize&q` | user | artist list with counts |
| GET | `/music/artists/:id` | user | `{ item, albums, topTracks }` |
| GET | `/music/albums?artistId&sort&page&pageSize&q` | user | album list |
| GET | `/music/albums/:id` | user | `{ item, artist, tracks, trackCount }` |
| GET | `/music/tracks?albumId&artistId&genre&q&sort&page&pageSize` | user | flat tracks (default page size 100, max 500) |
| GET | `/music/tracks/:id` | user | `{ item, album, artist }` |
| GET | `/music/recently-played?limit=1..100` | user | tracks from progress |
| GET | `/music/genres` | user | genre list with counts |

Sort values are validated per entity (`title`, `year`, `added`, `rating`, `duration`, `random`,
depending on the list). Tracks are playable through `/api/stream/:id`.

## Photos

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/photos?folder&from&to&sort&page&pageSize` | user | photo list (default 60, max 300) |
| GET | `/photos/timeline` | user | `{ groups:[{ key, month, year, label, count, cover }], total }` |
| GET | `/photos/folders` | user | folder groups with cover/count/library |
| GET | `/photos/folders/items?path=&libraryId=` | user | items in a relative folder (`''` = root) |
| GET | `/photos/folders/root/items` | user | library-root items |
| GET | `/photos/folders/:folderPath/items` | user | URL-encoded relative folder |
| GET | `/photos/:id` | user | photo + neighbors + detail |
| GET | `/photos/:id/file?download=1` | user | original bytes with range support |
| HEAD | `/photos/:id/file` | user | headers only |

Folder paths are relative (no leading `/`, no `..`). Timeline months use media dates when available,
otherwise the row's added date.

## Jobs

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/jobs?status&type&page&pageSize` | manager | job board + status counts; non-managers get `403` |
| GET | `/jobs/active` | user | own/accessible active jobs |
| GET | `/jobs/:id` | owner/manager | non-managers get a redacted payload/result |
| POST | `/jobs/:id/cancel` | owner/manager | queued/running only |
| DELETE | `/jobs/history?olderThanDays=3` | admin | removes finished jobs older than N days |

Statuses: `queued`, `running`, `done`, `error`, `cancelled`. Types: `scan`, `ingest`, `match`, `art`,
`probe`, `cleanup`. Queue limits: 3 jobs globally, 1 per type. Stale jobs are marked `error` on boot.

## Admin

Every route below also requires the admin role (`/api/admin` is gated twice).

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/overview` | server/memory/disk, DB stats, counts, active streams, logs, jobs, storage, top media, watch stats |
| GET | `/admin/settings` | full settings, including stored provider keys (admin only) |
| PATCH | `/admin/settings` | allowlisted keys; publishes `settings.changed` with TMDB/TVDB/OMDb keys emptied |
| GET | `/admin/logs?level&scope&q&olderThanDays&page&pageSize` | logs + byLevel + scopes |
| DELETE | `/admin/logs` | same filters in body/query |
| GET | `/admin/logs/export?limit=1..50000` | NDJSON download |
| GET | `/admin/users?q&role&sort&order&page&pageSize` | users + `byRole` |
| POST | `/admin/users` | `{ username, password, role, displayName? }` |
| PATCH | `/admin/users/:id` | `{ role?, disabled?, displayName?, pin? }` |
| DELETE | `/admin/users/:id` | not self, not last admin |
| POST | `/admin/users/:id/reset-password` | `{ password? }`; blank generates one and returns it |
| GET | `/admin/invites` | paginated invites |
| POST | `/admin/invites` | `{ role?:'user'\|'manager', ttlHours?:1..720 }` |
| DELETE | `/admin/invites/:id` | |
| GET | `/admin/reports?status&page&pageSize` | `{ items, total, byStatus }` |
| PATCH | `/admin/reports/:id` | `{ status:'open'\|'resolved'\|'dismissed', notes? }` |
| GET | `/admin/requests?status&kind&q&page&pageSize` | admin alias |
| PATCH | `/admin/requests/:id` | `{ status, reviewNote? }` |
| GET | `/admin/storage` | media/cache/DB/disk breakdown |
| POST | `/admin/maintenance` | `{ action:'optimize'\|'vacuum'\|'clear-cache'\|'regenerate-art'\|'reindex', targets?, mediaId? }` |
| GET | `/admin/privacy` | live outbound/cookie/hash/data audit |
| GET | `/admin/export` | instance metadata JSON (TMDB/TVDB/OMDb keys redacted) |
| POST | `/admin/import` | imports settings, libraries, collections, playlists only |

## SSE events

```bash
curl -N -b slop.cookies http://localhost:3100/api/events
```

```
event: scan.progress
data: {"libraryId":1,"libraryName":"Movies","status":"running","progress":0.42,"message":"Scanned …","active":1,"processed":12,"total":28}

event: media.changed
data: {"libraryId":1,"libraryName":"Movies","added":3,"updated":0,"skipped":25,"removed":0}
```

| Event | Who receives it | Payload |
|---|---|---|
| `scan.progress` | all users | library id/name, status, progress 0..1, message, processed/total |
| `job.update` | admins only | full job DTO (paths/errors included) |
| `media.changed` | all users | library/media id, added/updated/removed counts, or an edit/art/match reason |
| `ingest.progress` | all signed-in clients (admin UI consumes it) | `{ sourceId?, processed, total, message, status }`; statuses include `discovering`, `processing`, `review`, `done`, `cancelled` |
| `ingest.item` | all signed-in clients (admin UI consumes it) | `{ itemId, status, sourceId }` after processing/organizing/ignoring |
| `ingest.source` | all signed-in clients (admin UI consumes it) | `{ sourceId, removed:true }` after source deletion |
| `settings.changed` | all users | changed keys, settings with `tmdbApiKey`/`tvdbApiKey`/`omdbApiKey` empty, `hasTmdbKey`/`hasTvdbKey`/`hasOmdbKey` |
| `party.sync` | all users (clients filter by `partyId`) | party id, media id, position, paused, updatedAt, or `ended:true` |
| `stream.started` / `stream.ended` | the stream's user (and admins) | stream/user/media ids, mode, position, duration/finished |

The server sends `: keepalive` every 25 seconds. Use `EventSource` same-origin so the session cookie is
included; there is no token in the URL. Behind a reverse proxy, disable response buffering for this
endpoint.

## Quick integration recipe

1. `POST /api/auth/login` with a cookie jar.
2. `GET /api/browse/home` for rails, or `GET /api/browse?kind=movies` for a list.
3. (Optional) `POST /api/ingest/scan-all` as a manager, then resolve review items; organized files are scanned into a library automatically.
4. `GET /api/stream/:id/info` to decide direct vs HLS.
5. `PUT /api/progress/:id` every ~10 seconds while playing; `POST /api/stream/:id/progress` for the
   server-side stream/activity record.
6. `GET /api/events` for changes; refresh affected views instead of polling.
