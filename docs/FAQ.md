# FAQ

Short answers. Long answers live in the linked docs.

## Is this a real media server or a joke?

Both. It indexes and streams real files, resumes playback, transcodes, supports users/roles, scans
libraries, and has an actual test suite. The copy, demo library, and origin story are shitposts. It is
proudly **100% AI slop** in the sense that AI heavily assisted the code and content under human
direction.

## Is it a drop-in Plex/Jellyfin replacement?

No. It is a separate server with a smaller feature surface. It handles the core loop — movies, shows,
music, photos, playback, users — and skips the ecosystem (apps, remote access service, DVR, plugins,
trailers, hardware transcoding, SSO). Running it next to Plex is fine.

## Do I need internet?

Not at runtime. The box makes zero outbound calls by default and serves no external assets. The Docker
**build** needs network access for Debian/npm packages. Kodi-style NFO metadata and filename inference
work offline. Metadata providers (TMDB/TVDB/OMDb keys, keyless TVmaze/IMDb toggles) are opt-in only.

## Do I need a TMDB key?

No. Local NFO and filename matching work without it. A key is optional and adds online metadata/art.
TheTVDB and OMDb keys are independent options; TVmaze and IMDb suggestions are keyless but off until you
toggle them. Nothing is contacted unless you opt in. See
[Privacy → Metadata providers](PRIVACY.md#metadata-providers-and-hosts).

## Can it play 4K / HDR / Dolby Vision?

It can serve any file your browser can direct-play. Otherwise it transcodes with **software x264**,
scaled to `MAX_TRANSCODE_HEIGHT` (1080p by default). There is no GPU/NVENC/QSV path and no dedicated
HDR tone-mapping pipeline, so HDR→SDR output may look flat. For big remuxes, direct play or a
remux-friendly MP4 is the smooth path.

## Does it delete or modify my files?

Scans only read. Deleting a library, media row, or ingestion source removes database records and cached
art; it does not delete source files. The one write path is **ingestion**: organizing a drop file
renames/moves it into a library by default, or copies/hardlinks/symlinks it if you choose that action.
The organizer never overwrites an existing destination; it adds ` (2)`. Symlinked entries depend on the
original file staying put. The compose example mounts `/media` read-only, so use `copy`/`symlink` for it.

## Multiple users?

Yes: `admin`, `manager`, `user`, with invites, optional profile PINs, per-user favorites/progress/
playlists, and session revocation. There are **no per-library ACLs**; every signed-in user can see all
indexed media.

## Why can't I sign up?

Signups are closed by default (`allowSignups: false`) and invite-gated (`requireInvite: true`). An admin
must issue an invite or create the account in **Admin → Users**.

## How do I reset a password?

- Signed in: **Profile → Password** (current + new).
- Another admin: **Admin → Users → Reset password** (blank field generates one).
- Locked out and no other admin: [Troubleshooting → locked out](TROUBLESHOOTING.md#locked-out-of-the-admin-account).

There is no email recovery because there is no email.

## Why `admin` / `slop123`?

Demo defaults. Change the password immediately. `ADMIN_USER`/`ADMIN_PASSWORD` only apply when the
database has no users.

## Can I disable the meme copy?

Yes. **Settings → Memes** (server-wide) or **Profile → Meme copy** (per-user). The UI remains usable;
the copy just becomes dry.

## Is there a mobile app?

No native apps. The web UI is responsive with a mobile bottom nav, and the player supports PiP/fullscreen
where the browser does. There is also a TV mode with arrow-key navigation.

## AirPlay / Chromecast?

No dedicated cast integration. Use browser tab casting, PiP, or OS-level screen mirroring. HLS playback
works in Chromium/Firefox via the vendored hls.js and natively in Safari.

## What formats are supported?

- Video: `mkv mp4 m4v avi webm mov wmv flv mpg mpeg ts m2ts`
- Audio: `mp3 flac m4a aac ogg opus wav wma alac aiff aif`
- Images: `jpg jpeg png webp gif avif bmp`
- Subtitles: `srt vtt ass ssa` (external), plus embedded text subtitles

Direct play only happens for browser-safe combinations; everything else transcodes. Details:
[Media naming](MEDIA-NAMING.md).

## RAW photos?

No. RAW formats are not in the image extension allowlist.

## Can I keep my existing folder structure?

Usually yes. The scanner accepts `Movie (Year)`, `Show/Season 01/S01E02`, and
`Artist/Album/NN - Track` layouts. See [Media naming](MEDIA-NAMING.md) for exact patterns. Ingestion is
the exception: it intentionally renames/moves files into a canonical layout. Use a plain library scan
if you want your existing structure left alone.

## Can it auto-organize downloads?

Yes. Add a drop folder (or use `/data/ingest/...`), and ingestion discovers settled files, uses NFO/
filename data plus any enabled providers, and organizes confident matches into a library. Ambiguous
files wait in a review queue where you can search providers or type a title/year. Music/photos are
organized locally; provider matching is movie/show only. [Ingestion](INGESTION.md).

## What happens if two ingested files want the same name?

Nothing is overwritten. The second destination gets ` (2)` before the extension, then ` (3)`, etc. The
review queue and item notes show the final path.

## Why did my file go to review instead of organizing?

Its confidence was below the source's threshold (default 50%) and "Hold unmatched in review" is on.
That happens with no year/known NFO, odd filenames, or no enabled provider. Pick a provider candidate or
enter a title/year. Lower the threshold if you would rather organize parsed names automatically.

## Can it import my Plex/Jellyfin database?

No. It reads Kodi-style NFO and sidecar art, so a library already organized for Kodi/Plex usually
imports cleanly by scanning. Watch history and users do not transfer.

## Does it work over NFS/SMB?

Mount the share on the Docker host, bind-mount it into the container, and make sure `PUID`/`PGID` can
read it. NFS root-squash often breaks the entrypoint's `chown /data`; point `DATA_DIR` at a local disk
and mount media read-only.

## Why is transcoding using so much CPU?

It is software x264. Lower the height, use a faster preset, reduce concurrent streams, or direct-play
compatible files. `TRANSCODE_CONCURRENCY` defaults to 2.

## Why did a scan mark things as missing?

A full scan hides rows whose paths it did not see. If the library path disappeared or permissions broke,
files look gone. Fix the path/permissions and rescan; hidden rows return because scans upsert by path.
Scan warnings and counts are in **Admin → Jobs**.

## Can I schedule scans?

Yes: `manual`, `hourly`, `daily`, `weekly` per library, checked every 15 minutes. There is also a
startup scan for stale libraries when `scanOnStart` is enabled. Ingestion has its own watcher: enable
**Settings → Watch drop folders** and set the interval (default 30 seconds).

## Are watch parties peer-to-peer?

No. The host's play/pause/seek state is stored in SQLite and broadcast over SSE. Everyone streams from
your server independently and follows the host's position. Max 20 attendees.

## Can I run it behind a reverse proxy?

Yes. See [Deploy → Reverse proxy](DEPLOY.md#reverse-proxy--https). Preserve `Host`, disable buffering for
SSE, and set `SECURE_COOKIES=1` + `TRUST_PROXY=1` for HTTPS.

## How do I back up?

Stop the container and archive `./data` (or use SQLite's `.backup`). Details and restore steps:
[Deploy → Backups](DEPLOY.md#backups).

## What is the license?

MIT. See [LICENSE](../LICENSE).

## Why is the codebase called slop if it has tests?

Because self-deprecation is cheaper than marketing. The suite runs real HTTP against a real server, the
CI typechecks and builds the image, and the screenshots are captured from the running app. Slop can be
load-bearing.
