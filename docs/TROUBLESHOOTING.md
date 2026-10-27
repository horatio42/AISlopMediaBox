# Troubleshooting

Start here: the evidence is usually in one of three places.

```bash
docker compose ps
docker compose logs --tail=200 aislopmediabox
curl -fsS http://localhost:3100/api/health
```

Application logs live in SQLite and are viewable/exportable in **Admin → Logs**. Set `LOG_LEVEL=debug`
for noisy detail while debugging, then put it back.

## Container is unhealthy or restart-looping

**Check the healthcheck first.** The image probes `/api/health` every 30s with a 120s start period. On
first boot, demo generation can take a minute; a `starting` health status is normal. `unhealthy` after
that is not.

```bash
docker inspect --format '{{json .State.Health}}' aislopmediabox
docker compose exec aislopmediabox node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>r.text()).then(console.log)"
```

Common causes:

- **`/data` permissions.** The entrypoint chowns `/data` to `PUID:PGID`, then drops privileges. If the
  volume is on NFS/root-squash, chown can fail silently. Check `docker compose logs` for `EACCES`.
- **Port already in use.** See below.
- **Database locked by another process.** Do not run a host `node src/server.ts` against the same
  `./data` as the container. One writer, one SQLite.
- **Out of disk.** SQLite writes fail hard when the volume is full. Check `df -h ./data`.
- **Wrong architecture/native module.** `better-sqlite3` is rebuilt in the image. If you built on a
  different platform and copied the image, rebuild instead.

## Port 3100 is already in use

```bash
ss -ltnp | grep ':3100'
```

Either stop the conflicting process or change the **host** side of the compose mapping:

```yaml
ports:
  - "8080:3100"
```

Then `docker compose up -d` and open `http://localhost:8080`. Inside the container the app still listens
on 3100.

## Media not detected

Work down this list; each step eliminates a whole class of problems.

1. **Is the file inside the container?**

   ```bash
   docker compose exec aislopmediabox ls -la /media
   docker compose exec aislopmediabox find /media -maxdepth 3 -type f | head
   ```

   If your host files are not visible, the compose volume is wrong. `./media:/media:ro` means host
   `./media`; do not enter the host path in the library form.

2. **Did you use the container path?** The library must be `/media/...`, not
   `/home/you/media/...`. The path browser only sees the container filesystem.

3. **Does the library kind match?** A `movies` library ignores audio and images. A `music` library
   ignores video. Use `mixed` if a folder genuinely contains several types.

4. **Is the file extension supported?** Video: `mkv mp4 m4v avi webm mov wmv flv mpg mpeg ts m2ts`.
   Audio: `mp3 flac m4a aac ogg opus wav wma alac aiff aif`. Images: `jpg jpeg png webp gif avif bmp`.
   No RAW or TIFF formats.

5. **Is the name in a skipped folder?** Dot-folders and NAS junk (`@eaDir`, `#recycle`, `.Trash`, …)
   are ignored by design.

6. **Can the process read it?** Match `PUID`/`PGID` to the owner:

   ```bash
   docker compose exec aislopmediabox id
   docker compose exec aislopmediabox stat -c '%U %G %a %n' /media/YourFolder
   ```

   Permission errors appear as warnings in **Admin → Logs** during a scan.

7. **Did the scan actually run?** **Admin → Libraries → Scan now**, then watch **Admin → Jobs**. A
   successful scan reports added/updated/skipped counts. Zero items with zero errors usually means
   wrong path or wrong kind.

Naming rules are in [Media naming](MEDIA-NAMING.md). If filenames are ugly but files exist, a scan
still indexes them; titles may just be wrong until you edit them.

## Ingestion: files do not arrive or organize

Check the source card on **Admin → Ingestion** first: last run, result summary, counts, destination, and
per-item status are all there. Then work down this list.

1. **Is the file in the exact source path?** Sources use container paths (`/data/ingest/movies`,
   `/media/Movies`), not host paths. `docker compose exec aislopmediabox ls -la /data/ingest/movies`.
2. **Did it settle?** Files modified within the source's settle seconds (default 15) are skipped until
   they stop changing. Active `.part`/`.tmp`/`.crdownload` files are skipped by name too.
3. **Is the kind/extension right?** A `movies`/`shows` source takes video; `music` takes audio; `photos`
   takes images. See [Ingestion → What gets discovered](INGESTION.md#what-gets-discovered).
4. **Recursive off?** Subfolders are ignored. Season/album folders need recursive discovery.
5. **Source paused?** The watcher and **Scan all** skip disabled sources. **Scan now** still runs a single
   paused source.
6. **Watcher off or interval long?** Settings → Ingestion watcher. Manual **Scan now** works regardless.
7. **Readable by `PUID:PGID`?** `docker compose exec aislopmediabox id` and `stat` the file. Discovery
   warnings appear in **Admin → Logs** and the source result.
8. **Review queue instead of organized?** That is the confidence threshold doing its job. See below.
9. **No new job on an empty folder?** Expected: the watcher only queues when discovery finds new/changed
   files or pending rows. A second manual scan while a job is active returns `409 ingest_in_progress`
   with the running job id.

### A review item will not resolve

- **No candidates:** the provider is not configured/enabled. Keys live in Settings; keyless TVmaze/IMDb
  must be explicitly toggled. Manual search ignores `autoMatch` but still needs an eligible provider.
- **Candidates are wrong:** search with a more specific title/year, or use the manual title/year fields.
  Manual match never contacts the network.
- **Manual organize fails:** the title is required; year must be `1800–2200`; show season `0–999`,
  episode `0–9999`. Fix the form values; the server rejects out-of-range numbers.
- **Already organized / ignored guard:** an organized item cannot be matched again. Retry an ignored item
  (or use **Organize with this**, which resets it) before organizing.

### Read-only source with `move`

`move` uses rename (or copy + unlink across filesystems) and cannot remove a file from a read-only mount.
Edit the source and choose `copy`, `hardlink`, or `symlink`. `copy`/`symlink` only need write access to
the destination library. `hardlink` can fall back to a copy, with a note on the item.

### `Source file disappeared` or playback stopped for a symlinked item

The inbox file was moved/deleted outside the app. A symlink destination is not a copy; removing the
source breaks playback. Retry cannot recover it. Restore the file, or re-ingest with `copy`, or ignore
the row. Deleting an ingestion source or item never deletes files by itself.

### Destination collisions and odd names

The organizer never overwrites: an existing destination gets ` (2)`, ` (3)`, … A title with slashes or
`..` is sanitized into one safe segment and cannot escape the library root. If a provider title is
unwieldy, edit it in the review form before organizing.

### Source rejected or disappears

- `must be absolute` / `does not exist` / `must be a directory`: create it and use the container path.
- `cannot live inside the cache/temp directory`, `cannot be the app data root`, `cannot be the database
  file`: choose a media/inbox folder instead.
- `Source and destination library must not contain each other`: pull the source out of the library tree
  (or choose another destination).
- `already source #N`: a source with that exact path exists; edit it.
- `Library "X" is movies; it cannot receive shows`: choose a kind-compatible library or Auto.

### Wrong destination library

Auto picks the first matching library of that kind, or creates `Ingested Movies/Shows/Music/Photos`
under `MEDIA_DIR` with a `daily` schedule. Set an explicit destination on the source if you want a
different library. Kind compatibility is enforced (`shows` requires a `shows` library; other kinds allow
their own kind or `mixed`).

### Drops are organized but no media row appears

Check the destination path on the item and whether the library scan finished. If another scan was
active, indexing is deferred (`Indexing deferred: scan N is running`); it will be picked up by the next
scan/schedule. Permission errors on the destination library appear as scan warnings.

## Permission denied / scans cannot read files

- The entrypoint runs as `PUID:PGID` after chowning `/data`. Set these to the owner of your media:

  ```bash
  id -u
  id -g
  ```

- On a NAS/SMB/NFS mount, the container uid must have read permission. Read-only mounts are fine for
  scanning and for ingestion with `copy`/`symlink`; the scanner never writes to media. Ingestion
  destinations must be writable, and `move` also needs write/delete permission on the source folder.
- `sudo chown -R 1000:1000 data` fixes the common “root-owned data after running as root” case.
- Do not make the entire media tree world-writable. Grant group/other read or run as the owner.

## Transcoding fails or stutters

**Symptom:** player shows “Transcoding unavailable” or `503 transcode_unavailable`.

```bash
docker compose exec aislopmediabox ffmpeg -version
docker compose exec aislopmediabox ffprobe -version
```

If ffmpeg is missing, you are running a custom image or host install. The shipped image includes it.
If you set `FFMPEG_PATH`/`FFPROBE_PATH`, verify those paths exist in the container.

**Symptom:** direct play works, one file always transcodes.

That is expected for MKV and some codecs. The badge tooltip (`Σ` stats panel) lists the exact reason:
container, video codec, audio codec, forced burn-in, or alternate audio. MP4/MOV with H.264 + AAC is the
safe direct-play combo.

**Symptom:** `429` / “transcoder is busy”.

The server caps concurrent HLS sessions (`TRANSCODE_CONCURRENCY`, default 2). Wait for idle sessions
to expire (90s) or raise the cap if the CPU can take it. Check **Admin → Dashboard → active streams**.

**Symptom:** stuttering, buffering, high CPU.

- Lower `MAX_TRANSCODE_HEIGHT` (e.g. 720).
- Use a faster preset: `ultrafast`/`superfast`/`veryfast` (default).
- Reduce concurrent streams.
- Hardware acceleration is autodetected; see the next section if it is not being used.
- Direct play is nearly free, and remux copies video without re-encoding; those are your friends.

**Symptom:** HLS plays locally but stalls behind a proxy.

Disable proxy buffering for the app (especially `/api/events` SSE and HLS segments) and increase read
timeouts. See [Deploy → Reverse proxy](DEPLOY.md#reverse-proxy--https).

**Symptom:** subtitles do not appear in transcode.

Bitmap subtitles (PGS/VOBSUB) must be burned in, which forces a transcode. Text subtitles are converted
to WebVTT and served as tracks. If the file has no subtitle streams and no sidecars, there is nothing to
show.

## Hardware acceleration is not detected

**Check what the server sees:** **Admin → Settings → Playback & transcoding** prints every encoder
that passed a real smoke encode, or call `GET /api/hwaccel` as an admin. `?refresh=1` re-probes after
you hot-plug a GPU or install drivers.

The output is always H.264 for browser compatibility. Autodetection probes NVENC, QSV, VAAPI,
RKMPP, V4L2-M2M, Vulkan Video, AMF, and VideoToolbox, then falls back to a hardware encoder with
software decode, then software x264. A failed probe is reported with its ffmpeg error instead of
silently disappearing.

- **Docker:** pass the device nodes and the host render/video groups. Compose example:
  ```yaml
  devices:
    - /dev/dri:/dev/dri
  group_add:
    - "989"   # getent group render
    - "44"    # getent group video
  ```
  For NVIDIA, install `nvidia-container-toolkit` and use `gpus: all` / the NVIDIA runtime. For
  RK3588, also pass `/dev/mpp_service`.
- **VAAPI (AMD/Intel):** the image bundles `libva` + Mesa VA drivers. Multi-GPU hosts (iGPU + dGPU)
  usually need an explicit `hwAccelDevice` such as `/dev/dri/renderD129`; the probe maps `amdgpu`
  to the `radeonsi` libva driver and `i915`/`xe` to `iHD` automatically. If Intel hardware still
  shows no VAAPI/QSV, install `intel-media-va-driver` in the image or use a host ffmpeg.
- **NVIDIA:** the Debian ffmpeg in the image may not include NVENC. If `/dev/nvidiactl` exists but
  the report says “no working NVENC”, point `FFMPEG_PATH` at an ffmpeg built with NVENC
  (`jellyfin-ffmpeg` is the usual choice) and restart.
- **Raspberry Pi 4:** `h264_v4l2m2m` needs the V4L2 encoder device (usually `/dev/video11`) exposed
  to the container. Without it, output is software x264.
- **Raspberry Pi 5:** mainline ffmpeg has no usable H.264 hardware encoder; hardware HEVC decode does
  not help an H.264 HLS output. Expect software x264, or a 720p ceiling.
- **Orange Pi 5 / RK3588:** install an ffmpeg built with `--enable-rkmpp` (`jellyfin-ffmpeg`) and
  pass `/dev/mpp_service`. Debian's ffmpeg does not ship `h264_rkmpp`.
- **Orange Pi 6 / CIX P1:** no mainline ffmpeg encoder yet; software x264 is the honest path.

**Seeking feels slow or jumps:** this build restarts the same transcode session at the seek offset
instead of spawning a new one, and throttles ffmpeg once it is `TRANSCODE_THROTTLE_SECONDS` (default
120) ahead. If seeks land on keyframes in remux mode, that is the source GOP, not a clock bug.
Lower `HLS_SEGMENT_SECONDS` for faster startup; raise `TRANSCODE_THROTTLE_SECONDS` if you want a
larger forward buffer for scrubbing.

## Subtitles missing or wrong language

- External files must match the video basename: `Movie.en.srt`, `Movie.en.forced.srt`,
  `S01E02 - Title.de.srt`. A generic `movie.srt` only works when the folder has one video.
- Extension must be `srt`, `vtt`, `ass`, or `ssa`.
- Language comes from a 2–3 letter token; without one it uses `DEFAULT_LANGUAGE` (default `en`).
- Embedded text subtitles need ffprobe to have found them. **Refresh** the item and re-check the `CC`
  menu.
- An unsupported text encoding can produce garbage. Convert to UTF-8 before scanning.
- `.ass` styling is converted to WebVTT; complex karaoke/positioning may be simplified.
- Burn-in always requires ffmpeg and a transcode.

## Locked out of the admin account

`ADMIN_USER` / `ADMIN_PASSWORD` only create the first user when the database has **zero users**.
Changing the env var later does nothing.

Options, best first:

1. **Another admin exists:** ask them to use **Admin → Users → Reset password** (leave the field blank
   for a generated password).
2. **You still have a session:** Profile → Change password requires the current one, so this only helps
   if you know it.
3. **No other admin:** restore a backup, or use the app's own hashing code to set a new password. With
   the container running:

   ```bash
   docker compose exec aislopmediabox node --input-type=module -e "
     import { openDatabase } from './src/db.ts';
     import { hashPassword } from './src/lib/passwords.ts';
     const db = openDatabase();
     const info = db.prepare(\"UPDATE users SET password_hash = ?, disabled = 0 WHERE username = 'admin'\").run(hashPassword('new-password-here'));
     console.log('updated', info.changes);
   "
   ```

   Replace the username/password. This opens the same SQLite database in a second process; WAL handles
   concurrent access. Back up `/data` first if you are cautious.

4. **Last resort:** move `./data/aislop.db*` aside and restart. This creates a fresh admin from
   `ADMIN_USER`/`ADMIN_PASSWORD`, but **loses all state**. Back up first.

## Login loops, “cross-origin request blocked”, or cookies do not stick

- `SECURE_COOKIES=1` requires **HTTPS**. On plain HTTP the browser will not send the cookie. Set it to
  `0` for local HTTP tests.
- Behind a proxy, preserve the original `Host` header. The server compares `Origin` host to `Host` for
  cookie-auth mutations.
- With `TRUST_PROXY=1`, the proxy must send `X-Forwarded-For`; otherwise rate limiting and audit IPs are
  wrong (login still works).
- `SameSite=Strict` means a login POST from another site will not carry the cookie. Log in from the app
  origin.

## Docker healthcheck says unhealthy but the UI works

The healthcheck runs **inside** the container against `127.0.0.1:3100`. If you changed the internal
`PORT` but not the healthcheck command, it will fail while the published port works. Either keep the
internal port 3100 (recommended; change only the host mapping) or override the healthcheck.

Also check start period: a huge first-boot demo generation or a very slow disk can exceed the 120s
grace window.

## Database locked / “SQLITE_BUSY”

- Only one server process may use a data directory. Multiple containers or a host dev server on the
  same bind mount will fight.
- Set the app to stop cleanly (`docker compose stop`) before copying the database.
- If the DB is stuck after a crash, stop the container, keep a copy, and restart. WAL recovers
  automatically; do not delete `-wal` unless you are restoring a backup and know the consequences.

## Artwork is missing or wrong

- Check **Settings → Generate artwork**.
- Sidecar files win: `poster.jpg`, `fanart.jpg`, `cover.jpg`. Remove the wrong sidecar and refresh.
- Generation needs ffmpeg and a readable font for text placeholders; the Docker image includes
  `fonts-dejavu-core`. Without a font, generated art is still valid but less texty.
- **Admin → Storage → Clear cache** with the `images` target deletes art rows too; regenerate after.
- Upload a poster in **Admin → Media → Edit** if automation keeps choosing something cursed.

## Disk usage keeps growing

| Growth | Where | Fix |
|---|---|---|
| Your media | `/media` | Expected |
| Generated art | `/data/cache/images` | Clear cache (images) or accept it |
| HLS sessions | `/data/cache/transcode` | Idle sessions expire after 90s; clear cache |
| Converted subtitles | `/data/cache/subtitles` | Clear cache |
| Logs | SQLite `logs` table | Admin → Logs → delete/export, or set `LOG_LEVEL=warn` |
| Database free pages | SQLite | Maintenance → Optimize / Vacuum |
| Backups | wherever you put them | Prune old archives |

## Scans are slow or hammering the CPU

- ffprobe runs at `SCAN_CONCURRENCY` (default 4). Lower it on small boxes.
- Large libraries take time proportional to file count; unchanged files are skipped via mtime + size.
- Scheduled scans are checked every 15 minutes; a `daily` library still only scans when due.
- Do not run multiple scans of the same library; the queue rejects overlap.

## Everything is on fire and I want a clean slate

Back up first, then:

```bash
docker compose down
mv data data.broken
docker compose up -d
```

You lose users, progress, libraries, and settings. Your mounted `/media` is untouched. Copy specific
files back from `data.broken` only if you know what you are doing.
