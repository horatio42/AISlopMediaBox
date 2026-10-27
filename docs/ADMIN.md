# Admin guide

The control room lives at `/admin`. It is a separate page with a hash router:
`/admin#dashboard`, `#libraries`, `#ingest`, `#media`, `#users`, `#requests`, `#moderation`, `#jobs`,
`#logs`, `#storage`, `#settings`, `#privacy`.

Only users with the **admin** role can open it. Managers can still edit media metadata from the
normal app, manage ingestion sources/review items, and call manager-level APIs (`/api/ingest/*`,
library/media routes), but they do not get the admin console or admin-only routes.

## Roles

| Role | Can do |
|---|---|
| `admin` | Everything: users, invites, settings, library CRUD, scans, metadata, moderation, logs, storage, exports, maintenance |
| `manager` | Curate: create/edit/delete libraries, start scans, manage ingestion sources/items, edit/refresh media and upload art, review title requests through the API; cannot hide/delete media, review reports, access `/admin`, or call admin-only endpoints |
| `user` | Browse, play, favorite/rate, make collections/playlists, request titles, report content, join parties |

Only an admin can promote/demote roles. The last enabled admin cannot be demoted, disabled, or
deleted. Deleting yourself is refused; ask another admin.

## Users and invites

**Users** table actions:

- **Create user** — username (2–32 chars, letters/numbers/`.`/`-`/`_`), password (6–200 chars),
  display name, role.
- **Role change** — `user`, `manager`, `admin`. Demoting an admin requires another enabled admin.
- **Disable/Enable** — disabling revokes all of that user's sessions.
- **Reset password** — leave the field blank to generate a random 12-character password (shown once in
  the dialog). Resetting revokes all sessions for that user.
- **Delete** — removes the account and cascades sessions; media state/progress rows are removed with
  it. The last admin is protected.

**Invites** are optional gate codes:

```text
Admin → Users → Generate invite → role (user/manager) + TTL hours (1–720)
```

Invite codes are single-use and expire. They only matter when **Settings → Access → Require invite**
is on. Admins can always create accounts directly. Check an invite from the login page with
`/api/auth/invites/check/:code` or by pasting it into the registration form.

There is **no email**: no password reset mail, no invitations sent, no notifications leave the box.

## Libraries

**Add library** asks for:

| Field | Notes |
|---|---|
| Name | 1–120 chars; shown in navigation/filters |
| Kind | `movies`, `shows`, `music`, `photos`, `mixed` |
| Path | **Absolute path inside the container**, must exist, be a readable directory |
| Scan schedule | `manual`, `hourly`, `daily`, `weekly` |
| Settings | Optional small JSON-ish object limited to scalar/array values; scan settings live here |

The path browser (`GET /api/libraries/folders`) lists directories, their subfolder count, and a
bounded media-file count. It skips symlinks and dotfiles. The app refuses to use its own `/data` root
or cache directories as a library.

**Delete library** removes the library row, its media rows (cascade), and cached art. Source files
under the library path are never modified. A library cannot be deleted mid-scan. Ingestion may create
**Ingested Movies/Shows/Music/Photos** libraries (`MEDIA_DIR/ingested-<kind>`, daily schedule) when a
source has no explicit destination and no matching library exists; they behave like any other library.

## Ingestion

**Admin → Ingestion** (`/admin#ingest`, manager API at `/api/ingest/*`) is the drop-folder pipeline:

- **Sources** — per-kind watched folders, destination library, action (`move`/`copy`/`hardlink`/
  `symlink`), confidence threshold, hold-unmatched, auto-match, recursive, settle seconds, enabled.
  Four defaults exist under `/data/ingest/{movies,tv,music,photos}`. Paths must be absolute existing
  directories, outside app data/cache/temp roots, unique, and non-overlapping with the destination
  library. Creating/editing/deleting a source never touches source files.
- **Providers** — live registry of TMDB, TVDB, OMDb, keyless TVmaze, and keyless IMDb suggestions with
  configured/enabled state and every outbound host. Keys/toggles are edited in Settings.
- **Scan now / Scan all** — queues one `ingest` job. A second request while an ingest job is active
  returns `409 ingest_in_progress` with the running `jobId`.
- **Review queue** — items below their source's confidence threshold. Search providers, pick a candidate,
  enter a manual title/year (plus season/episode for shows), organize with parsed fields, ignore, or retry.
  Ignore never touches the file. Organized items are settled and cannot be reorganized until retried.
- **Recent activity** — organized/error/ignored items with destination path, mapped media id, error text,
  and retry.

The full workflow, naming rules, file-action trade-offs, and provider gating are in
[Ingestion](INGESTION.md). Watching and thresholds are global settings (below) plus per-source values.

## Scanning and jobs

- **Scan now** on a library → `202 { jobId }`; **Scan all** queues every library whose path exists and
  is not already scanning.
- Only one scan runs at a time (the queue allows one job per type, max three jobs globally).
- Progress streams over SSE (`scan.progress` for the banner, `job.update` for admins) and is persisted
  in the job row.
- A scan walks recursively, skips junk/dot folders, probes each file with ffprobe (concurrency
  `SCAN_CONCURRENCY`, default 4), upserts by absolute path, skips unchanged files (`mtime` + size),
  and writes metadata/art/subtitles.
- A full scan hides database rows whose files disappeared. If the library's settings include
  `"removeMissing": true`, those rows (and their cached art) are deleted instead.
- One bad file produces a warning, not a failed scan. The job result includes warnings and counts.
- **Cancel** marks the job cancelled; the scanner checks the flag between batches.
- On restart, any `queued`/`running` job is marked `error` with “Server restarted mid-job”. Nothing
  resumes automatically.

Job types: `scan`, `ingest`, `match`, `art`, `probe`, `cleanup`. **Jobs** filters by status/type and shows
progress, message, elapsed time, and actions. **Clear history** deletes finished jobs older than the
selected window (default three days).

Schedules are checked every 15 minutes. Start-up scanning is controlled by **Settings → scanOnStart**.

A missing library path pauses its scheduled scans and logs a warning; it does not delete the library.

## Media management

**Admin → Media** shows every row, including seasons, episodes, artists, albums, tracks, photos, and
loose videos. Filter by kind, library, genre, and search; sort and page.

Per-row actions:

- **Edit** — title, description, year, rating, tagline, content rating, genres, metadata lock, and
  poster upload/remove. `tags` and `people` (cast/crew) are supported by the PATCH API but are not in
  the current edit form; set them with a script/curl.
- **Refresh** — re-probe the file, re-run local metadata, and regenerate art (`POST
  /api/media/:id/refresh`).
- **Provider match** — find candidates from any configured provider (`GET /api/media/:id/matches`) or
  match by `{ provider, providerId }` / `{ query }`. The legacy `{ id }`/`{ tmdbId }`/`{ query }` form
  still assumes TMDB and returns `matched: false`, `reason: tmdb_not_configured` without a TMDB key.
- **Hide** — sets `hidden=1`; disappears from browse/search/home but the row and file remain and a
  rescan can bring it back.
- **Delete row** (`?hard=1`) — removes the database row (and descendants for containers) plus cached
  art. **Never deletes the source file.**
- **Bulk hide** — sequential hide calls for selected rows.

**Metadata lock** stops scans and refreshes from overwriting your edits. Turning it off allows the
scanner to write metadata again. Art uploads are stored in `/data/cache/images`; removing art deletes
only the cache entry.

Show/season/episode relationships come from the scanner. Editing a show does not rename its folder.

## Requests and moderation

- **Requests** lists all requests with status/counts. Review pending → approved/rejected/fulfilled;
  approved → fulfilled. Review notes are visible to the requester. Mapping lives in
  `src/routes/requests.ts`.
- **Moderation** lists user reports against media or by title. Statuses: `open`, `resolved`,
  `dismissed`. Add internal notes (up to 2000 chars). Resolution records the admin and timestamp.
- Report creation is rate-limited (10/hour/user). Requests are also limited to 10/hour/user.

## Logs

- Filter by level (`debug`, `info`, `warn`, `error`), scope, free text in message/metadata, and age.
- Export current filters as NDJSON (`.jsonl`) with an optional limit up to 50,000 rows.
- Delete matching logs. Logs are stored in SQLite and are **not** rotated automatically.

Passwords, tokens, cookies, and file contents are not logged. Admin actions are audited in the
`audit` scope (user id, IP, action, changed keys).

## Settings

Settings are saved explicitly (no autosave), validated by an allowlist, and broadcast over SSE
(`settings.changed`) after save. Provider keys (`tmdbApiKey`, `tvdbApiKey`, `omdbApiKey`) are emptied in
broadcasts and instance exports.

| Key | Type / range | Effect |
|---|---|---|
| `serverName` | string 1–60 | Branding in shell/login/emails-that-do-not-exist |
| `tagline` | string ≤160 | Login screen copy |
| `accent` | `slop`, `light`, `midnight`, `goblin` | Stored accent identifier, returned by `/api/branding`; the current UI themes come from the per-user theme picker |
| `allowSignups` | boolean | Registration form availability |
| `requireInvite` | boolean | Require a valid invite to register |
| `allowRequests` | boolean | New title requests |
| `allowParties` | boolean | Creating/joining watch parties |
| `scanOnStart` | boolean | Queue scans at boot for stale libraries |
| `autoMatch` | boolean | Automatic provider enrichment during scans/ingestion for configured providers (and for keyless providers only when their toggle is on) |
| `generateArt` | boolean | Generate missing art |
| `transcodeEnabled` | boolean | Allow HLS transcoding |
| `subtitleBurnIn` | boolean | Stored switch for burn-in; burn-in still requires a client to request it (`burn=1`). There is no server-side enforcement yet |
| `maxTranscodeHeight` | integer 144–2160 | Transcode output ceiling |
| `transcodePreset` | ffmpeg preset | x264 speed/quality (mapped to NVENC presets p1–p7) |
| `hwAccel` | `auto`/`none`/encoder | Hardware acceleration preference; `auto` uses the best working probe result |
| `hwAccelDevice` | `/dev/...` or empty | Explicit render node; empty means autodetect |
| `hwAccelDecode` | boolean | Also decode on the GPU for VAAPI/QSV/CUDA, with automatic retry on software decode |
| `transcodeThrottleSeconds` | integer 0–900 | Encoder read-ahead before ffmpeg is paused (SIGSTOP); 0 disables |
| `maintenanceMode` | boolean | Non-admin users get `503 maintenance` on all non-auth APIs |
| `memes` | boolean | Meme copy in the UI |
| `telemetry` | always `false` | Server rejects anything else |
| `tmdbApiKey` | string, empty clears | Opt-in TMDB metadata (**not** redacted from the admin GET; redacted from SSE/exports) |
| `tvdbApiKey` | string, empty clears | TheTVDB v4 key; env `TVDB_API_KEY` fallback |
| `omdbApiKey` | string, empty clears | OMDb key (IMDb-backed details); env `OMDB_API_KEY` fallback |
| `tvmazeEnabled` | boolean, default off | Keyless TVmaze show lookups (explicit opt-in) |
| `imdbEnabled` | boolean, default off | Keyless unofficial IMDb suggestions (explicit opt-in) |
| `ingestWatch` | boolean, default on | Background discovery watcher for enabled ingest sources |
| `ingestIntervalSeconds` | integer 5–3600, default 30 | Watcher check interval; read fresh on each tick |

Maintenance mode is deliberately soft: `/api/health`, `/api/branding`, `/api/auth/*`, and the admin
API remain available so the admin can turn it off.

**Export instance metadata** downloads JSON with settings (provider keys redacted), users (no password hashes),
libraries, media rows, art rows, genres/tags/people, subtitles, collections, playlists, requests, and
reports. It is metadata only — not media bytes and not a backup.

**Import** accepts the same shape but only imports **settings, libraries, collections, and
playlists**. Unknown or invalid entries are skipped and reported. Library paths are re-validated.

## Storage and maintenance

**Admin → Storage** reports:

- media bytes and items by kind/library,
- image/transcode/subtitle/temp/log cache sizes,
- database/WAL size, page count, free pages,
- free disk on the data path.

**Maintenance actions:**

| Action | Behavior |
|---|---|
| Optimize | `PRAGMA optimize` + `ANALYZE`; returns bytes before/after |
| Vacuum | WAL checkpoint + `VACUUM`; returns bytes before/after |
| Clear cache | Targets `transcode`, `subtitles`, `temp` by default; `images` also deletes art rows so the index does not point at ghosts |
| Regenerate art | Queues an `art` job (all media, or one `mediaId`) |
| Reindex | Queues a `probe` job; if unavailable, queues forced rescans; if no handlers, rebuilds SQLite indexes |

All actions are audited. The UI confirms destructive ones.

## Privacy audit

**Admin → Privacy** returns live values, not marketing copy:

- `zeroOutbound` is true only when no provider key exists and both keyless toggles are off.
- If any provider is configured/enabled, it lists every host with the modes that can use it (`manual`,
  and `scan` when autoMatch makes it auto-eligible): TMDB (`api.themoviedb.org`, `image.tmdb.org`),
  TVDB (`api4.thetvdb.com`, `artworks.thetvdb.com`), OMDb (`www.omdbapi.com`, `m.media-amazon.com`),
  TVmaze (`api.tvmaze.com`, `static.tvmaze.com`), IMDb suggestions (`v2.sg.media-imdb.com`,
  `m.media-amazon.com`).
- Telemetry/analytics are always false; external fonts, CDN assets, and third-party scripts are zero.
- Cookie flags (`slop_session`, HttpOnly, SameSite=Strict, Secure when enabled), session days, scrypt
  parameters, log store, data dir, and export endpoints.

This endpoint is the honest answer to “does it phone home?”.

## Backups

- **Recommended:** back up the whole `/data` directory while the container is stopped. See
  [Deploy → Backups](DEPLOY.md#backups).
- **Per-user:** users export their own JSON from Profile.
- **Instance metadata:** Admin → Privacy export (not a database backup; no media/art/passwords).

## Security notes

- Admin APIs are `requireAuth` + `requireAdmin`, and `/admin` is a static page gated by the same API.
- Cookie-authenticated mutations check the `Origin` host against `Host`; behind a proxy, preserve
  `Host`.
- Rate limits apply to login (10/5min/IP), registration (5/hour/IP), password changes (6/15min/user),
  requests and reports (10/hour/user).
- Default credentials are a meme. Change the password before exposing the box.
- There is no 2FA, no email, and no account recovery by email. The escape hatch is another admin, or a
  database restore.
- **Honest gap:** `accent` and `subtitleBurnIn` are persisted settings but are not enforced by the
  current frontend/playback code. They are documented here so nobody assumes otherwise.
