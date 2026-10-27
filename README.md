# AISlopMediaBox

`100% AI SLOP` · `SELF-HOSTED` · `ZERO TELEMETRY` · `ONE CONTAINER`

**Your media. Your server. One brain cell.**

AISlopMediaBox is a deliberately shitpost-flavored, genuinely functional personal media server:
movies, shows, music, and photos in one Node.js process, one SQLite file, and one Docker container.
No Kubernetes. No cloud. No "sign in with Discord". No telemetry. Just your files, a web UI, and
`ffmpeg` doing the heavy lifting when your browser gets picky.

Everything you see here is generated locally — the demo library is synthesized with ffmpeg on first
boot, so the screenshots are the actual product, not a Figma fantasy.

![AISlopMediaBox home screen](docs/screenshots/home.png)

## 30-second quickstart

Prerequisites: Docker with Compose v2, and about a gigabyte of free disk.

```bash
# from the folder containing docker-compose.yml
docker compose up -d
```

Open <http://localhost:3100> and log in with **`admin` / `slop123`**.

> ⚠️ **Change the password immediately.** Default credentials are a running joke, not a security
> model. On first boot only, you can set `ADMIN_PASSWORD` in `docker-compose.yml` (or a compose
> override) before starting. After the database exists, change it in **Profile → Password** or
> **Admin → Users → Reset password**.

First boot generates an original demo library (10 short films, 2 shows, 2 albums, 10 photos) inside
`./data/media` and scans it. This takes about a minute. You can opt out with `SEED_DEMO=0` and
`DEMO_MODE=0`.

Want to feed it your own downloads instead of clicking around? Drop files into
`./data/ingest/movies`, `./data/ingest/tv`, `./data/ingest/music`, or `./data/ingest/photos`, then use
**Admin → Ingestion → Scan all**. Ambiguous files wait in a review queue. Details:
[Ingestion](docs/INGESTION.md).

## What it actually does

| Area | What you get |
|---|---|
| **Movies & shows** | Libraries, recursive scans, seasons/episodes, resume points, next-episode autoplay, favorites, watched state, ratings |
| **Playback** | Direct play, remux (video copy) for MKV/H.264, HLS transcode otherwise; seek restarts the same session, encoder throttling, autodetected GPU acceleration (NVENC/QSV/VAAPI/RKMPP/V4L2/Vulkan/AMF/VideoToolbox); volume/speed, subtitles (external + embedded), audio-track switching, PiP, keyboard shortcuts |
| **Music** | Artists → albums → tracks, persistent mini-player with queue/shuffle/repeat, Media Session keys, album and artist sheets |
| **Photos** | Month-grouped timeline, folder filters, masonry grid, lightbox with zoom/info/download/slideshow |
| **Curation** | Manual collections and live **smart collections** (`genre`, `year`, `rating`, `tag`, `person`, `addedWithinDays`, …), ordered playlists, duplicate/reorder |
| **Ingestion** | Watched drop folders, NFO/sidecar parsing, provider matching (TMDB, TVDB, OMDb, keyless TVmaze, keyless IMDb suggestions), canonical rename + organize (move/copy/hardlink/symlink), confidence-gated review queue with manual/provider fixes |
| **Social** | Title requests with review workflow, moderation reports, watch parties with synchronized host state, member profiles |
| **Admin** | Dashboard, library management, ingestion sources/review queue, metadata editing and provider match, users/roles/invites, job queue, logs, storage, settings, privacy audit, metadata export |
| **Everywhere** | Responsive layout, mobile bottom nav, TV mode, arrow-key navigation, reduced-motion support |
| **Privacy** | HttpOnly `SameSite=Strict` session cookies (30-day expiry, configurable), scrypt password hashes, no external assets, CSP locked to `'self'`, zero outbound requests unless you explicitly add a provider key or enable a keyless provider toggle |

### Screenshot gallery (all real, all local)

| | |
|---|---|
| ![Movies library](docs/screenshots/movies.png) | ![Movie detail](docs/screenshots/detail.png) |
| ![Show detail](docs/screenshots/detail-show.png) | ![Video player](docs/screenshots/player.png) |
| ![Transcoding player](docs/screenshots/player-transcode.png) | ![Music overview](docs/screenshots/music.png) |
| ![Album sheet](docs/screenshots/music-album.png) | ![Photo timeline](docs/screenshots/photos.png) |
| ![Photo lightbox](docs/screenshots/photos-lightbox.png) | ![Collections](docs/screenshots/collections.png) |
| ![Playlists](docs/screenshots/playlists.png) | ![Requests](docs/screenshots/requests.png) |
| ![Admin dashboard](docs/screenshots/admin-dashboard.png) | ![Admin libraries](docs/screenshots/admin-libraries.png) |
| ![Ingestion review queue](docs/screenshots/admin-ingest-review.png) | [Full Ingestion admin page →](docs/screenshots/admin-ingest.png) |
| ![Mobile home](docs/screenshots/home-mobile.png) | ![Login](docs/screenshots/login.png) |

More: [movies](docs/screenshots/movies.png), [shows](docs/screenshots/shows.png),
[collection detail](docs/screenshots/collection-detail.png),
[playlist detail](docs/screenshots/playlist-detail.png), [profile](docs/screenshots/profile.png),
[TV mode](docs/screenshots/home-tv.png), [detail on mobile](docs/screenshots/detail-mobile.png),
[admin media](docs/screenshots/admin-media.png), [admin settings](docs/screenshots/admin-settings.png),
[admin jobs](docs/screenshots/admin-jobs.png), [admin privacy](docs/screenshots/admin-privacy.png),
[admin ingestion](docs/screenshots/admin-ingest.png),
[ingestion review queue](docs/screenshots/admin-ingest-review.png).

## How the stack fits together

```mermaid
flowchart LR
  B[Browser SPA<br/>vanilla ES modules] -->|HTTP JSON + SSE| S[Express 5<br/>Node 24]
  S -->|SQLite WAL| D[(/data/aislop.db)]
  S -->|read-only| M[/your media<br/>/media/]
  S -->|generated art, HLS, subs| C[/data/cache/]
  S -->|transcode + probe| F[ffmpeg / ffprobe]
  S -.->|optional, provider key or opt-in toggle| P[Metadata providers<br/>TMDB / TVDB / OMDb / TVmaze / IMDb]
  A[Admin console] -->|same API| S
```

- **One process.** Express serves the JSON API, media bytes, HLS, and the static frontend.
- **One database.** `better-sqlite3` in WAL mode; all state under `/data`.
- **One container.** Built on `node:24-bookworm-slim` with ffmpeg, `tini`, and `gosu` for PUID/PGID.
- **No build step.** Node 24 strips TypeScript types at runtime. The frontend is dependency-free ES modules.
- **Real-time without polling.** Scans, jobs, settings, media changes, playback, and party state arrive over `/api/events` (SSE).

## Privacy, plainly

- **No telemetry, analytics, CDNs, external fonts, or third-party scripts.** CSP is `default-src 'self'`.
- **No outbound network calls by default.** Metadata providers stay quiet until *you* add a TMDB/TVDB/OMDb
  key or explicitly enable the keyless TVmaze/IMDb toggles. The possible hosts are listed live in
  **Admin → Privacy**. Keys are never logged, broadcast over SSE, or included in metadata exports.
- **Everything persistent lives in `/data`.** Back it up by backing up one folder.
- **Your account data is exportable** from Profile; deletion is an admin action or the documented
  `DELETE /api/users/me` call. Admins can export instance metadata.
- **Threat model:** this is a home server, not a hardened multi-tenant platform. Use HTTPS and a
  reverse proxy before exposing it to the internet. See [Privacy](docs/PRIVACY.md).

## Docs

| Doc | What's in it |
|---|---|
| [Getting started](docs/GETTING-STARTED.md) | Install, first run, demo vs. your own media, folder layout, first library |
| [Deploy](docs/DEPLOY.md) | Compose, env vars, volumes, PUID/PGID, HTTPS reverse proxy, backup/restore, upgrades |
| [Media naming](docs/MEDIA-NAMING.md) | Movie/show/season/episode/music/photo conventions, NFO, sidecars, subtitles |
| [Ingestion](docs/INGESTION.md) | Drop folders, mounted sources, provider keys/toggles, confidence + review queue, organize actions, naming |
| [Using the box](docs/USING.md) | Browsing, search, playlists, requests, parties, player, music, photos, TV/mobile |
| [Admin guide](docs/ADMIN.md) | Users, roles, invites, libraries, ingestion sources/review, scans/jobs, metadata, moderation, logs, settings, backups |
| [API reference](docs/API.md) | Endpoints by domain, auth, query params, curl examples, errors, SSE events |
| [Privacy](docs/PRIVACY.md) | Cookies, hashing, data location, provider hosts/toggles, export/delete, limits |
| [Testing](docs/TESTING.md) | `npm test`, CI, manual smoke test, screenshot harness, demo fixtures |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Permissions, ffmpeg, missing media, ports, password resets, healthcheck |
| [FAQ](docs/FAQ.md) | Short answers to the questions people actually ask |
| [Architecture](docs/ARCHITECTURE.md) | Contributor contract, module ownership, internal design |

## FAQ, but short

**Is this actually AI slop?** Yes. The code, copy, demo titles, and this README were produced with AI
assistance under human direction. It is also tested, typechecked, and used. Both things are true.

**Does it phone home?** No. Check **Admin → Privacy**, which reads the live configuration. If no provider
key is configured and both keyless toggles are off, `zeroOutbound` is `true`.

**Can it play my 4K HDR remux?** It can serve it directly if your browser supports it, otherwise it
transcodes down to a configurable height (1080p by default). Transcoding is CPU-hungry; the demo
files are tiny on purpose.

**Do I need Plex/Jellyfin installed?** No. It is a separate server. You can run them side by side.

**Will it delete my files?** No. Deleting a library, media row, or ingestion source removes database
records and cached art; the app never deletes source media on its own. Ingestion is the one place that
*writes* files: its default `move` action relocates a drop file into a library (and `copy`/`hardlink`/
`symlink` do what they say). The organizer never overwrites an existing destination; collisions get
` (2)`. Scans themselves only read.

**Why is the admin password `slop123`?** Because it is a demo. Change it before the box meets a
network you do not control.

## Credits & license

- **License:** MIT (see [LICENSE](LICENSE)). Slop responsibly.
- **hls.js** is vendored at `public/vendor/hls.min.js` with its license at
  `public/vendor/hls.LICENSE`, so Chromium/Firefox can play HLS without a CDN.
- **Demo content** is original and synthesized locally by `scripts/demo-content.mjs` with ffmpeg.
  No copyrighted media ships in this repo.
- **Fonts** in the Docker image are `fonts-dejavu-core` (installed from Debian), not fetched by the app.
