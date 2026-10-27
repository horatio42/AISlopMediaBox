# Testing

The test suite runs real HTTP against a real server process with a temporary data directory. No mocks
of SQLite, Express, or streams — if the app is broken, tests fail for real reasons.

## Requirements

- Node.js **24** (the app runs TypeScript via type stripping; no build step)
- `ffmpeg` and `ffprobe` on `PATH` for media/probe/transcode tests
- A C toolchain only if `better-sqlite3` needs rebuilding on your platform (`python3`, `make`, `g++`)

## Local commands

```bash
npm ci
npm run typecheck
npm test
```

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src`, `scripts`, `test` |
| `npm test` | `node --test` over `test/*.test.ts`, each starting its own server/data dir |
| `npm run dev` | `node --watch` on `src/server.ts` |
| `npm run seed` | generate demo content, ensure libraries, optionally queue scans |
| `npm run demo` | generate only the demo media fixtures |
| `npm run screenshots` | Playwright screenshots against a running instance |

`test/helpers.ts` starts servers on ephemeral ports with `DATA_DIR` under the OS temp directory,
waits for `/api/health`, logs in, and cleans up. Tests use `node:test` and `assert/strict`.

**Use generated fixtures for ingestion tests.** If you manually exercise an ingestion source against
real media, point it at the exact media directory (for example `/media/Movies`), never at a parent
tree such as `/media` or a home-directory mount that contains other data. This avoids accidental scans,
moves, or review-queue noise outside the folder you meant.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and pull requests:

1. checkout + Node 24 with npm cache
2. `npm ci --no-audit --no-fund --foreground-scripts && npm rebuild better-sqlite3`
3. `npm run typecheck`
4. install `ffmpeg` (Ubuntu apt)
5. `npm test`
6. `docker build -t aislopmediabox:ci .`

If CI fails at the Docker build but tests pass, the usual causes are missing native build tools or a
new file not copied by the Dockerfile.

## Manual smoke test

This is the fastest way to validate a checkout without touching your real library:

```bash
DATA_DIR=test/tmp/smoke MEDIA_DIR=test/tmp/smoke/media PORT=3999 node scripts/demo-content.mjs --quiet
DATA_DIR=test/tmp/smoke MEDIA_DIR=test/tmp/smoke/media PORT=3999 node src/server.ts &
DATA_DIR=test/tmp/smoke SEED_URL=http://127.0.0.1:3999 PORT=3999 node scripts/seed.ts
```

Then:

```bash
curl -fsS http://127.0.0.1:3999/api/health
curl -c /tmp/slop-smoke.cookies -H 'content-type: application/json' \
  -d '{"username":"admin","password":"slop123"}' \
  http://127.0.0.1:3999/api/auth/login
curl -b /tmp/slop-smoke.cookies 'http://127.0.0.1:3999/api/browse?kind=movies&pageSize=3'
curl -b /tmp/slop-smoke.cookies 'http://127.0.0.1:3999/api/jobs?pageSize=5'
curl -b /tmp/slop-smoke.cookies 'http://127.0.0.1:3999/api/stream/1/info'
```

Checklist:

- [ ] `/api/health` returns `ok: true`, `db: true`
- [ ] Login sets `slop_session`
- [ ] Movies list contains scanned items with real IDs
- [ ] Scan jobs finish `done` (allow up to a minute)
- [ ] `stream/info` reports `directPlay` and a reason list
- [ ] Home has a Continue Watching rail after `PUT /api/progress/:id`
- [ ] Admin overview/storage/privacy load for the admin, 403 for a normal user
- [ ] `/api/events` with a session cookie (`curl -N -b /tmp/slop-smoke.cookies http://127.0.0.1:3999/api/events`) stays open and emits `: keepalive`; without a cookie it returns `401`

Stop the server with `Ctrl+C`; remove `test/tmp/smoke` when done.

## Screenshot harness

`scripts/screenshots.mjs` captures the docs screenshots from a **running, seeded** instance. It uses
the real API to discover:

- a direct-playable movie (for `player.png`),
- a transcode-only movie (MKV/non-native, for `player-transcode.png`),
- the first show, album, smart collection, and playlist.

```bash
SLOP_URL=http://127.0.0.1:4400 node scripts/screenshots.mjs
```

Environment: `SLOP_URL` (default `http://localhost:3999`), `SLOP_USER` (`admin`), `SLOP_PASSWORD`
(`slop123`). Output: `docs/screenshots/*.png`. It logs a warning if a file is under 30 KB, which
usually means a blank page.

The harness also captures `admin-ingest.png` from **Admin → Ingestion** and, when review items exist,
`admin-ingest-review.png` of the queue. For a deterministic demo inbox:

```bash
# Same DATA_DIR as the server; writes two tiny generated fixtures into its movies drop folder,
# configures that source to copy + hold unmatched, scans, and seeds review candidates via IMDb.
SLOP_INGEST_DEMO=1 SLOP_INGEST_IMDB=1 SLOP_INGEST_ONLY=1 \
  DATA_DIR=test/tmp/showcase SLOP_URL=http://127.0.0.1:4400 \
  node scripts/screenshots.mjs
```

`SLOP_INGEST_DEMO=1` is opt-in and writes only generated fixtures under `DATA_DIR/ingest` (override
with `SLOP_INGEST_DIR`). It requires the screenshot process and server to share the same host
`DATA_DIR` (a source-run showcase, not a Docker container whose `/data` path differs).
`SLOP_INGEST_IMDB=1` turns on the keyless IMDb suggestions toggle on that throwaway instance so
candidate cards are real; leave it off for a fully local capture.
`SLOP_INGEST_ONLY=1` captures only the ingestion screenshots, leaving the existing gallery untouched.
These paths never point at real user media.

If Chromium is missing:

```bash
npx playwright install chromium
```

### Fresh showcase instance

Useful when you need deterministic screenshots with demo content and social state:

```bash
# 1. Generate the demo library (local ffmpeg only)
DATA_DIR=test/tmp/showcase MEDIA_DIR=test/tmp/showcase/media \
  node scripts/demo-content.mjs --quiet

# 2. Start the server
DATA_DIR=test/tmp/showcase MEDIA_DIR=test/tmp/showcase/media PORT=4400 node src/server.ts &

# 3. Create libraries and queue scans
DATA_DIR=test/tmp/showcase SEED_URL=http://127.0.0.1:4400 PORT=4400 node scripts/seed.ts

# 4. Wait for jobs to finish, then capture
SLOP_URL=http://127.0.0.1:4400 node scripts/screenshots.mjs
```

By default the harness does not create the demo state (favorites, playlists, requests, parties); the
ingestion fixture above is the opt-in exception. For social state, log in and use the API as admin before
capturing:

```bash
curl -c /tmp/show.cookies -H 'content-type: application/json' \
  -d '{"username":"admin","password":"slop123"}' \
  http://127.0.0.1:4400/api/auth/login

# partial progress -> Continue Watching
curl -b /tmp/show.cookies -X PUT -H 'content-type: application/json' \
  -d '{"positionSeconds":10,"durationSeconds":41}' \
  http://127.0.0.1:4400/api/progress/1

# favorite + watched
curl -b /tmp/show.cookies -X PUT -H 'content-type: application/json' \
  -d '{"favorite":true}' http://127.0.0.1:4400/api/progress/1/state

# playlist
curl -b /tmp/show.cookies -X POST -H 'content-type: application/json' \
  -d '{"name":"Friday Night Slop","kind":"mixed","isPublic":true}' \
  http://127.0.0.1:4400/api/playlists
```

The checked-in screenshots were captured from a fresh instance initialized with this sequence plus a
few favorites, a partial progress point, and one playlist. Ingestion screenshots were captured from a
separate fresh showcase instance with generated inbox fixtures. Keep fixture data generated by
`scripts/demo-content.mjs`/`ffmpeg` only — no copyrighted media.

Never point screenshot/test ingestion setup at a real media library. If you must smoke-test against
real files, use one explicit directory (not its parent), and prefer the read-only `/media` mount plus
`copy`/`symlink`.

## Demo fixtures

`scripts/demo-content.mjs` synthesizes everything with ffmpeg. It writes a manifest and is
idempotent: rerunning without `--force` exits early, which makes boots and CI fast.

Flags:

```bash
node scripts/demo-content.mjs --help
# Usage: node scripts/demo-content.mjs [--force] [--quiet] [--data DIR] [--media DIR]
# Env: DATA_DIR, MEDIA_DIR, DEMO_FONT
```

`scripts/seed.ts` creates the Movies/Shows/Music/Photos libraries (matched by path), then logs in with
`ADMIN_USER`/`ADMIN_PASSWORD` and queues a scan per library when the server is reachable.

Flags/env:

```bash
node scripts/seed.ts --help
# Usage: node scripts/seed.ts [--no-scan] [--force-content]
# Env: DATA_DIR, MEDIA_DIR, PORT (default 3100), SEED_URL, ADMIN_USER, ADMIN_PASSWORD
```

`--no-scan` only prepares libraries. `--force-content` regenerates every fixture (slow). The seed is
safe to rerun; existing libraries are reused.

## What the suite covers

Tests are organized by domain, not by file count:

| File | Focus |
|---|---|
| `core.test.ts` | health, security headers, auth cookies, sessions, malformed JSON, 404s |
| `browse-media.test.ts` | filters, sorting, search, detail graphs, metadata edits, hiding |
| `libraries.test.ts` | library CRUD, path validation, folder browser, scans/jobs |
| `ingest.test.ts` | default sources + source validation/CRUD, discovery/NFO/sidecar organization, provider/local confidence, review queue flows, copy/hardlink/symlink/move semantics, collision/path sanitization, provider status/privacy toggles, show/music/photo organization, watcher idempotence, ingest→browse/search/stream integration |
| `playback.test.ts` | direct play, range requests, HLS/session safety, subtitles, resume |
| `social.test.ts` | collections, smart rules, playlists, requests, reports, parties |
| `music-photos.test.ts` | music overview/lists/playback, photo timeline/folders/files |
| `requests-profile.test.ts` | request review flow, profiles, preferences, exports |
| `playlists-parties.test.ts` | playlist/party behavior and permissions |
| `admin.test.ts`, `admin-jobs.test.ts` | admin gates, settings, users, invites, logs, maintenance, export/import |
| `integration.test.ts` | cross-domain flows against a fully seeded instance |

Exact counts change as the suite grows; run `npm test` for the current list.

## Troubleshooting the harness

- **Blank or tiny PNGs:** the view did not finish loading. Increase the waits in
  `scripts/screenshots.mjs` or check `pageerror` warnings it prints.
- **No transcode screenshot:** the server has no non-direct-playable movie; add an MKV to a test
  library or accept the skip.
- **Login failed:** the instance was started with different `ADMIN_*` env vars, or the DB already has
  an admin with another password. Pass `SLOP_USER`/`SLOP_PASSWORD`.
- **Port already in use:** stop the previous server or pick another `PORT`; the harness only reads
  `SLOP_URL`.
