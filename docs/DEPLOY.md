# Deploy

One container, one volume, no sidecars. This page covers the boring parts that keep it alive:
configuration, volumes, permissions, HTTPS, backups, upgrades, and resources.

## Compose

The repo's `docker-compose.yml` is the whole deployment:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f aislopmediabox
```

Stop it without deleting anything:

```bash
docker compose down
```

`docker compose down -v` also removes named volumes. This project uses **bind mounts**, not named
volumes, so `-v` will not remove `./data` — but read the command before running it anyway.

## Ports

The container listens on `3100`; compose publishes it to host port `${SLOP_PORT:-3100}`.

```bash
echo 'SLOP_PORT=8080' >> .env
docker compose up -d
```

Then open `http://localhost:8080`. Only the host side changes; the app always listens on port 3100
*inside* the container. If you bypass compose, use `-p 8080:3100` with `docker run`.

## Volumes and layout

```yaml
volumes:
  - ./data:/data          # database, demo media, caches, logs — persistent
  - ./media:/media:ro     # optional: your own files, read-only
```

| Container path | Contents | Back up? |
|---|---|---|
| `/data/aislop.db` (+ `-wal`, `-shm`) | Users, libraries, media index, progress, playlists, settings, logs | **Yes** |
| `/data/ingest` | Default ingestion drop folders (`movies`, `tv`, `music`, `photos`) | Optional (your inbox files) |
| `/data/media` | Demo library generated on first boot; default ingestion destinations | Optional |
| `/data/cache/images` | Generated/uploaded art | No (regenerable) |
| `/data/cache/transcode` | Ephemeral HLS sessions | No |
| `/data/cache/subtitles` | Converted WebVTT | No |
| `/data/cache/temp`, `cache/logs` | Scratch and log files | No |
| `/media` | Your source media, read-only | You already have it |

The scanner never writes to `/media`. Libraries, hidden rows, and cached art only touch the database
and the art cache. **Ingestion is the exception**: it writes organized files into a destination library
(under `/data/media` or another writable library path). Its source can be `/media`, but a `move` action
cannot delete from a read-only mount — use `copy`, `hardlink`, or `symlink` there. Deleting an ingestion
source or queue row removes database rows only, never source files.

## Environment variables

All values are read at boot. `docker-compose.yml` uses `${VAR:-default}` substitution, so Docker
Compose automatically loads a `.env` file next to it:

```bash
cp .env.example .env
# edit ADMIN_PASSWORD, SLOP_PORT, PUID/PGID, MEDIA_HOST_DIR, provider keys, …
docker compose up -d
```

`SLOP_PORT` changes only the **host** port; the container always listens on 3100 internally. The
container paths (`DATA_DIR=/data`, `MEDIA_DIR=/data/media`) are fixed by the image so backups stay
predictable.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3100` | HTTP port inside the container |
| `HOST` | `0.0.0.0` | Bind address inside the container |
| `DATA_DIR` | `/data` (local: `./data`) | Database and cache root |
| `MEDIA_DIR` | `$DATA_DIR/media` | Default media root / demo library root |
| `ADMIN_USER` | `admin` | First admin username — **first boot only** |
| `ADMIN_PASSWORD` | `slop123` | First admin password — **first boot only** |
| `SEED_DEMO` | `1` | Entrypoint generates demo media when no database exists |
| `DEMO_MODE` | `1` | Server auto-creates demo libraries if there are none |
| `SECURE_COOKIES` | `0` | Add `Secure` to the session cookie (set `1` behind HTTPS) |
| `TRUST_PROXY` | `0` | Trust `X-Forwarded-For` from one proxy hop |
| `SESSION_DAYS` | `30` | Session lifetime |
| `MAX_TRANSCODE_HEIGHT` | `1080` | Output height ceiling for transcodes |
| `TRANSCODE_PRESET` | `veryfast` | x264 preset |
| `TRANSCODE_CONCURRENCY` | `2` | Max simultaneous transcode sessions; extra requests get `429` |
| `HLS_SEGMENT_SECONDS` | `4` | HLS segment length; shorter starts/seeks faster, shorter GOPs cost a little quality |
| `TRANSCODE_HWACCEL` | `auto` | `auto`, `none`, or an explicit encoder: `nvenc`, `qsv`, `vaapi`, `amf`, `rkmpp`, `v4l2m2m`, `vulkan`, `videotoolbox`. Each candidate is smoke-encoded before use |
| `TRANSCODE_HWACCEL_DEVICE` | *(empty)* | Optional device override, e.g. `/dev/dri/renderD129` on a mixed-GPU host (`TRANSCODE_VAAPI_DEVICE` is accepted as an alias) |
| `TRANSCODE_THROTTLE_SECONDS` | `120` | Pause ffmpeg once it is this far ahead of the client; `0` disables throttling |
| `SCAN_CONCURRENCY` | `4` | Parallel ffprobe jobs while scanning |
| `MEDIA_HOST_DIR` | `./media` | Host folder mounted **read-only** at `/media`; point a library or ingestion source at a child path |
| `TMDB_API_KEY` | *(empty)* | **Optional.** TMDB metadata provider. Off by default |
| `TVDB_API_KEY` | *(empty)* | **Optional.** TheTVDB v4 provider (settings key wins over env) |
| `OMDB_API_KEY` | *(empty)* | **Optional.** OMDb (IMDb-backed) provider (settings key wins over env) |
| `FFMPEG_PATH` | `ffmpeg` | Explicit ffmpeg binary |
| `FFPROBE_PATH` | `ffprobe` | Explicit ffprobe binary |
| `DEFAULT_LANGUAGE` | `en` | Fallback subtitle language when the filename has no language tag |
| `APP_VERSION` | `1.0.0` | Version string shown in branding/UI |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `TZ` | `Etc/UTC` | Timezone for logs and displayed dates |
| `PUID` / `PGID` | `1000` | Owner applied to `/data`; the server runs as this uid/gid |
| `TRANSCODE_IDLE_SECONDS` | `90` | Kill idle transcode sessions (not in `.env.example`) |

The provided `docker-compose.yml` forwards `TMDB_API_KEY`, `TVDB_API_KEY`, and `OMDB_API_KEY` from
`.env`. You can also enter keys in **Admin → Settings** (settings keys take precedence over environment
fallbacks). Keyless providers (TVmaze, IMDb suggestions) have no environment variables; enable them in
**Admin → Settings → Metadata providers & privacy**. They are off by default.

Changing `ADMIN_USER` or `ADMIN_PASSWORD` after the database exists has no effect on existing users.
Use the profile/password UI or **Admin → Users → Reset password**.

## Media mounts and ingestion

Two volumes are separate on purpose:

- `/data` is writable and persistent: database, cache, demo media, and the default drop folders
  `/data/ingest/{movies,tv,music,photos}`.
- `/media` is your media mount. The compose example makes it read-only. Set `MEDIA_HOST_DIR` to the
  host folder you want there:

  ```bash
  echo 'MEDIA_HOST_DIR=/srv/media/Movies' >> .env
  docker compose up -d
  ```

  Then use **`/media`** (the container path), never `/srv/media/Movies`, in libraries and ingestion
  sources. The exact media folder is intentional; do not mount or point a source at a parent tree that
  also contains unrelated libraries or app data.

Ingestion actions and mounts:

| Source mount | `move` | `copy` | `hardlink` | `symlink` |
|---|---|---|---|---|
| Writable (e.g. `/data/ingest`) | works | works | works on same filesystem; copy fallback otherwise | works |
| Read-only (e.g. `/media:ro`) | **fails** (cannot unlink) | works | often copy fallback | works; absolute link to source |

In every case the destination library must be writable. Symlinks break if the source file is later
removed. Never point a source at the app data root, the SQLite file, or the cache/temp trees; the API
rejects those and also rejects a source that contains or is contained by its destination library.
Details: [Ingestion](INGESTION.md) and [Troubleshooting → Ingestion](TROUBLESHOOTING.md#ingestion-files-do-not-arrive-or-organize).

Permissions: the container runs as `PUID:PGID`; it needs read on the source and write on the destination.
For a writable custom inbox, grant both. For a read-only media mount, read is enough with `copy`/
`symlink`.

## PUID/PGID and permissions

The image starts as root, fixes ownership of `/data`, then drops privileges with `gosu`:

```text
PUID=1000 PGID=1000
```

Match these to the user that owns your bind-mounted folders:

```bash
id -u
id -g
```

If your media lives on a NAS or another user's home directory, add read permission for that
uid/gid, or set `PUID`/`PGID` to the owner. Typical failure mode: scans complete with zero items and
`EACCES` warnings in **Admin → Logs**.

Do not `chmod 777` your whole media tree. Fix ownership or group membership instead.

## Reverse proxy + HTTPS

The box speaks plain HTTP and expects a proxy in front of it if it leaves localhost.

### Caddy

```caddyfile
media.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3100
}
```

Set these in the service environment:

```yaml
environment:
  SECURE_COOKIES: "1"
  TRUST_PROXY: "1"
```

Caddy handles certificates and forwards the original `Host`, which matters because the server
rejects cookie-authenticated mutations whose `Origin` host differs from the request `Host`.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name media.example.com;

  ssl_certificate     /etc/letsencrypt/live/media.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Server-Sent Events (/api/events) must not be buffered.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }
}
```

Also set `SECURE_COOKIES=1` and `TRUST_PROXY=1`. If the page loads but login silently fails over
HTTPS, check that the proxy preserves `Host` and that you are not mixing `http://` and `https://`
origins.

## Backups

### The simple, correct backup (stop first)

SQLite runs in WAL mode. Copying the `.db` file while the app is writing can produce a torn backup.
Stop the container, copy the whole `data` directory, then start again:

```bash
docker compose stop
tar -czf "aislop-data-$(date +%F).tar.gz" data
docker compose start
```

### Online backup, if you have the SQLite CLI on the host

```bash
sqlite3 data/aislop.db ".backup 'data/aislop-backup.db'"
```

The container image does not include `sqlite3`; run this on the host or install it there.

### Restore

```bash
docker compose down
mv data data.old
tar -xzf aislop-data-2026-10-26.tar.gz
sudo chown -R 1000:1000 data   # match PUID/PGID
docker compose up -d
```

Keep `data.old` until the restored instance answers `/api/health` and you have logged in.

### What is not in a metadata export

**Admin → Privacy → Export instance metadata** downloads a JSON snapshot of settings, users,
libraries, media rows, collections, and playlists. It deliberately:

- redacts provider keys (TMDB/TVDB/OMDb),
- does not include media bytes,
- does not include the art cache,
- does not include user passwords (hashes are not exported).

It is useful for migration/inspection, **not** a substitute for the `/data` backup.

## Upgrades

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
```

Your `data` directory is preserved. There is no separate migration binary: the database schema is
applied with `CREATE TABLE IF NOT EXISTS` on boot, and the app stores a `schema_version` in `meta`.
Back up before upgrading, especially if you run a fork with local patches.

To roll back, check out the previous commit, rebuild, and restore the matching backup if the schema
changed.

## Healthcheck and logs

The image defines:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

Check it:

```bash
docker compose ps
docker inspect --format '{{.State.Health.Status}}' aislopmediabox
curl -fsS http://localhost:3100/api/health
```

Logs:

```bash
docker compose logs -f --tail=200 aislopmediabox
```

Application logs are also stored in SQLite and viewable/exportable in **Admin → Logs**. They are not
rotated automatically; clear old entries from that page.

## Resource use

Measured on the demo showcase instance (10 films, 2 shows, 2 albums, 10 photos):

- **Idle server RSS:** ~145 MB (Node + SQLite). Art, scans, and transcoding add on top.
- **Database:** ~300 KB for ~50 media rows; mostly independent of media bytes.
- **Art cache:** generated JPEGs at 700 px posters / 1280 px backdrops. Can grow with large libraries.
- **Playback:** direct play costs almost nothing server-side. Transcoding spawns ffmpeg processes and
  is CPU-bound; the default ceiling is 1080p and 2 concurrent sessions.
- **Disk:** your media; caches are disposable.

If the box feels sluggish during scans, lower `SCAN_CONCURRENCY` or schedule scans at night. If
transcodes stutter, lower `MAX_TRANSCODE_HEIGHT` or `TRANSCODE_CONCURRENCY`.

## Maintenance actions

**Admin → Storage** offers:

| Action | Effect |
|---|---|
| Optimize | `PRAGMA optimize` + `ANALYZE` |
| Vacuum | Reclaims SQLite free pages; can briefly lock the database |
| Clear cache | Removes transcode, subtitle, and temp caches (not art unless selected) |
| Regenerate art | Re-runs art generation for media |
| Reindex | Re-probes metadata for all media |

Do not run **Vacuum** while a scan or stream is active if you can avoid it. See the admin UI for the
exact confirmation text.
