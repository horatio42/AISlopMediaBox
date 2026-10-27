# Getting started

This guide takes you from zero to a working box. It assumes Docker; a source-based dev setup is at
the bottom.

## 1. Install

You need:

- Docker Engine with **Compose v2** (`docker compose`, not `docker-compose`)
- ~1 GB free disk for the image, demo media, and caches
- `ffmpeg` is already inside the image — do not install it on the host

From the project root:

```bash
docker compose up -d
docker compose ps
```

The container is healthy when `STATUS` shows `Up ... (healthy)` and this returns `"ok": true`:

```bash
curl -fsS http://localhost:3100/api/health
```

Open <http://localhost:3100>. The demo login is `admin` / `slop123`.

## 2. First run: what the box does by itself

On the very first boot, with the defaults in `docker-compose.yml`:

1. The entrypoint creates `/data`, `/data/media`, and the cache folders, then drops from root to
   `PUID:PGID` (default `1000:1000`).
2. Because no database exists and `SEED_DEMO=1`, it runs `scripts/demo-content.mjs`. This synthesizes
   an original demo library locally with ffmpeg — no network, about 30–60 seconds.
3. The server starts, creates `aislop.db`, the first admin account, default settings, the four
   `/data/ingest/{movies,tv,music,photos}` drop folders, and matching default ingestion sources.
4. Because `DEMO_MODE=1`, it creates **Movies**, **Shows**, **Music**, and **Photos** libraries for
   `/data/media/movies|shows|music|photos` if none exist.
5. With `scanOnStart` enabled, it queues scans. Progress appears in the scan banner and in
   **Admin → Jobs**.

The generated media is intentionally short (24–45 second films, ~10-second tracks) so a fresh box
feels alive without shipping copyrighted files.

> Want an empty box? Set `SEED_DEMO=0` and `DEMO_MODE=0` in `docker-compose.yml` before the first
> start. You can also skip the demo library and add your own immediately.

## 3. Change the admin password

Do this before the box is reachable by anyone else.

- **Profile → Password** (current + new), or
- **Admin → Users → Reset password** (generates a random password if you leave the field blank).

`ADMIN_PASSWORD` in the environment only applies when the database has **zero users**. Editing it
later will not change an existing account. See [Troubleshooting](TROUBLESHOOTING.md#locked-out-of-the-admin-account).

## 4. Demo library vs. your own media

The compose file mounts two different things:

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/data` | **Persistent state.** Database, demo media, caches, logs. Back this up. |
| `./media` | `/media` (`:ro`) | **Optional, your files.** Read-only. Never written by the app. |

To use your own files:

1. Put them under `./media` on the host (create the folder if needed).
2. In the app, go to **Admin → Libraries → Add library**.
3. Choose the kind (`movies`, `shows`, `music`, `photos`, or `mixed`) and enter the **container
   path**, e.g. `/media/Movies`, not `/home/you/.../media/Movies`.
4. Save, then press **Scan now** (or **Scan all**).

If you prefer to replace the demo library entirely, delete the four demo libraries in
**Admin → Libraries** after adding yours. Deleting a library removes database rows and cached art;
your files on disk are untouched.

### Or drop files into an inbox

The app also creates watched drop folders under `./data` (container `/data`):

| Kind | Host path | Container path |
|---|---|---|
| Movies | `./data/ingest/movies` | `/data/ingest/movies` |
| Shows | `./data/ingest/tv` | `/data/ingest/tv` |
| Music | `./data/ingest/music` | `/data/ingest/music` |
| Photos | `./data/ingest/photos` | `/data/ingest/photos` |

Drop a file, then **Admin → Ingestion → Scan now** (or wait for the watcher, default every 30 seconds).
Ingestion parses filenames/NFO, optionally asks a metadata provider, renames the file into a library, and
scans it. Files it cannot identify confidently wait in the review queue. The default action is `move`;
`copy`, `hardlink`, and `symlink` are available per source. See [Ingestion](INGESTION.md).

Want to ingest an existing folder without copying it? Set `MEDIA_HOST_DIR` to that folder, mount it
read-only at `/media`, add a source pointing at the exact container path, and choose `symlink` (or
`copy`/`hardlink`). A read-only mount cannot use `move`. Do not point a source at a parent directory
that contains unrelated libraries or app data.

More on structure and naming: [Media naming](MEDIA-NAMING.md).

## 5. Folder layout

### Runtime layout (`/data`, host `./data`)

```text
data/
├── aislop.db                # SQLite database
├── aislop.db-wal            # WAL (present while running)
├── aislop.db-shm
├── ingest/                  # watched drop folders (writable, inside /data)
│   ├── movies/
│   ├── tv/
│   ├── music/
│   └── photos/
├── media/                   # demo media / default library root
│   ├── movies/
│   ├── shows/
│   ├── music/
│   └── photos/
└── cache/
    ├── images/              # generated posters, backdrops, thumbnails
    ├── transcode/           # transient HLS sessions
    ├── subtitles/           # converted WebVTT cache
    ├── temp/
    └── logs/
```

Everything persistent is in `/data`. The cache is disposable; deleting it costs regeneration time,
not data. See [Deploy → Backup](DEPLOY.md#backups).

### Your media layout (suggested)

```text
media/
├── Movies/
│   ├── Touch Grass (2022)/
│   │   ├── Touch Grass (2022).mp4
│   │   ├── Touch Grass (2022).nfo
│   │   ├── poster.jpg
│   │   └── fanart.jpg
│   └── Absolute Cinema (2025)/
│       └── Absolute Cinema (2025).mkv
├── Shows/
│   └── The Slopening/
│       ├── tvshow.nfo
│       ├── poster.jpg
│       ├── Season 01/
│       │   ├── S01E01 - Pilot (Derogatory).mkv
│       │   └── S01E01 - Pilot (Derogatory).en.srt
│       └── Season 02/
│           └── S02E01 - Return of the Group Chat.mkv
├── Music/
│   └── DJ Neural Net/
│       ├── artist.nfo
│       └── GPU Fan Goes Brrr/
│           ├── cover.jpg
│           ├── 01 - GPU Fan Goes Brrr.flac
│           └── 02 - 3090 Degrees of Separation.flac
└── Photos/
    ├── 2026-10 - Family/
    │   └── 01 - grandma said based.jpg
    └── misc/
```

One library points at one root path and can cover everything below it, especially with the `mixed`
kind. Separate libraries produce cleaner navigation. Scan time scales with file count, not with the
number of libraries.

## 6. First library checklist

- [ ] The path exists **inside the container** (`/media/...`).
- [ ] The path is readable by `PUID:PGID` (see [Deploy → PUID/PGID](DEPLOY.md#puidpgid-and-permissions)).
- [ ] An ingestion source is readable by `PUID:PGID`; `move` also needs write access on the source and
      write access on the destination library. Use `copy`/`symlink` for read-only mounts.
- [ ] File extensions are supported: video `mkv mp4 m4v avi webm mov wmv flv mpg mpeg ts m2ts`;
      audio `mp3 flac m4a aac ogg opus wav wma alac aiff aif`; images `jpg jpeg png webp gif avif bmp`.
- [ ] The library kind matches the content. A `movies` library will not scan audio.
- [ ] The scan job finished in **Admin → Jobs** without errors.

## 7. A five-minute admin tour

| Stop | What to try |
|---|---|
| **Dashboard** | Health, library size, active streams, open reports, disk usage, storage-by-kind chart |
| **Libraries** | Add/edit/delete libraries, choose schedule (`manual`, `hourly`, `daily`, `weekly`), scan now |
| **Ingestion** | Drop-folder sources, provider status/hosts, confidence scoring, review queue, organize/ignore/retry, scan all |
| **Media** | Filter by kind/library/genre, edit title/description/year/rating/genres, upload art, refresh metadata, TMDB match, hide a row |
| **Users** | Create accounts, change roles, disable users, issue invite codes, reset passwords |
| **Requests** | Approve/reject/fulfil title requests; users can also report content |
| **Moderation** | Review open reports and resolve or dismiss them |
| **Jobs** | Watch scans, art generation, probes, cleanup; cancel a running job; clear old history |
| **Logs** | Filter by level/scope/text; export JSONL; delete old logs |
| **Settings** | Server name, tagline, signups/invites, requests/parties, scanning, transcoding, TMDB/TVDB/OMDb keys, TVmaze/IMDb toggles, ingestion watcher |
| **Privacy** | Live audit: telemetry off, zero external assets, outbound hosts, cookie flags, data dir |
| **Storage** | Per-library bytes, cache sizes, database size, free disk, maintenance actions |

## 8. Run from source (contributors)

```bash
npm install
npm run demo                       # generate demo media under ./data/media
npm run dev                        # http://localhost:3100, auto-reload
DATA_DIR=./data PORT=3100 node scripts/seed.ts   # create demo libraries + queue scans
```

Useful commands:

```bash
npm run typecheck
npm test
DATA_DIR=test/tmp/dev PORT=3999 node src/server.ts
```

The source setup defaults to `DEMO_MODE=0`, so `scripts/seed.ts` is what creates the demo libraries
and queues scans. Screenshot and fixture details live in [Testing](TESTING.md).

## Next

- Add real media → [Media naming](MEDIA-NAMING.md)
- Configure HTTPS and backups → [Deploy](DEPLOY.md)
- Learn the UI → [Using the box](USING.md)
- Something broke → [Troubleshooting](TROUBLESHOOTING.md)
