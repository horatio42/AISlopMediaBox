# Using the box

The app is a single-page interface. The sidebar is the map; the player is the point. Copy is
meme-flavored, but every control does a real thing.

## Signing in

- **Local account:** username + password. Sessions last 30 days by default (`SESSION_DAYS`).
- **Invites:** signups are closed by default. An admin issues a code in **Admin → Users → Generate
  invite**; enable **Allow signups** in **Admin → Settings** for the registration form to appear.
- **Profile PIN:** an optional 4–8 digit second lock for shared TVs. Set it in **Profile → Profile
  PIN**. The server asks for it after a correct password.
- **Log out / revoke devices:** **Profile → Active sessions** lists each session with device, IP,
  timestamps, and a revoke button.

## Drop folders and the review queue

If you would rather hand files to the app than point a library at a folder, use ingestion:

1. Drop a movie, episode, album, or photo into `./data/ingest/movies`, `./data/ingest/tv`,
   `./data/ingest/music`, or `./data/ingest/photos` on the host. Managers/admins can also add a source
   for any existing absolute folder, including a read-only `/media` mount.
2. Let the watcher run (default every 30 seconds), or press **Admin → Ingestion → Scan now / Scan all**.
3. Files the app can identify are organized into a library and appear in Browse/search automatically.
   Files it cannot identify confidently wait in **Review queue**, where you can search providers, pick a
   candidate, or enter a title/year yourself. **Ignore** leaves the file alone; **Retry** re-runs it.

The default action is `move`; `copy`, `hardlink`, and `symlink` are per-source choices. A symlink plays
only while the original drop file exists. Deleting a source or ignoring an item removes database rows,
not files. Full workflow: [Ingestion](INGESTION.md).

## Home and navigation

The home page leads with a rotating hero (“tonight’s slop”) built from real library items, then rails:

| Rail | Contents |
|---|---|
| Continue watching | Unfinished movies/episodes with a resume position |
| Recently added | Newest indexed items across movies, shows, albums, videos, photos |
| Movies / Shows / Music | Top-level items, newest first |
| Collections | Media inside manual collections, newest first |
| Because You Like … | Based on your most-watched genre (or the library’s most common genre if you are new) |
| Certified Bangers | Highly rated movies/shows, randomly ordered |

The header has:

- **Search** (`/` focuses it). Searches titles, original titles, descriptions, genres, cast, albums,
  artists, and tracks, grouped by type.
- **🎲 Random** opens a random movie/show/video that respects the current filters.
- **◐ Theme** cycles the local theme.
- **📺 TV mode** switches to larger focus targets; `/tv` is a real route. Arrow keys move focus,
  Enter activates.
- **Sidebar:** Home, Movies, Shows, Music, Photos, Collections, Playlists, Requests, Admin (if allowed).
- **Mobile:** bottom navigation replaces the sidebar; the search box stays in the top bar.
- **Reduced motion** is honored via the OS setting; your profile can also turn meme copy off.

## Browsing and filters

`/browse/:kind` supports `movies`, `shows`, `videos`, `albums`, `artists`, `tracks`, `photos`.
The filter bar is written into the URL, so filtered views are linkable.

Available controls:

- **Genre**, **year**, **content rating**, **library**
- **Favorites**, **watched**, **unwatched**, **in progress** (mutually exclusive except favorites)
- **Sort:** title, added, year, rating, runtime, random; ascending/descending
- **Search within the view** and **Surprise me**

Active filters appear as removable chips; **Reset filters** clears everything. Clicking a genre chip on
the home page opens the matching movie filter.

## Item details

Movie pages show backdrop, poster, tagline, description, year, runtime, rating, genres, and cast.
Show pages add a season picker and episode list with per-episode progress indicators. Album/artist
pages show tracks and related albums.

Actions:

- **Play / Resume** — for shows, picks the next unwatched or in-progress episode.
- **♥ Favorite** and **Mark watched** toggle per-user state.
- **Edit metadata** (admin/manager) — title, description, year, rating, tagline, content rating,
  genres, metadata lock. The admin console adds poster upload, refresh, and provider matching
  (TMDB/TVDB/OMDb/TVmaze/IMDb candidates); tags and cast/crew are API-level fields.
- **Refresh** (Admin → Media, per row) re-probes the file and regenerates local art; the API is
  `POST /api/media/:id/refresh`.
- **Related** rail uses shared genres.

## The player

`/watch/:id` is a full-screen custom player.

- **Direct Play** badge means the browser can decode the file as-is (MP4/MOV/WebM with safe codecs).
- **Remuxing** means the container was the only problem: video is copied without re-encoding, and
  audio is converted only when the browser cannot take the source codec.
- **Transcoding** means the server is producing HLS with ffmpeg (an unsupported codec, alternate
  audio track, or burned-in subtitles). The badge tooltip explains why.
- **Seeking** inside a transcode restarts the same ffmpeg session at the new offset instead of
  creating a new one. Scrub back and forth as much as you like; the concurrency cap is per viewer,
  not per seek. Press `s` in the player to see the active encoder and mode.
- **Resume prompt** appears when a position exists; choose resume, start over, or dismiss.
- **Next episode** autoplay is on by default; change it in **Profile → Playback**.
- **Subtitles:** `CC` lists external and embedded text tracks. Selecting “burn in” forces a transcode
  for bitmap/unsupported subtitles.
- **Audio:** `AUD` switches tracks when the file has more than one. Switching usually starts a new
  transcode session.
- **Stats:** `Σ` (or `s`) shows mode, codecs, resolution, bitrate, buffer, dropped frames, and reasons.
- **PiP:** `⧉` where the browser supports it.
- **Playback speed:** `1×` menu.

Keyboard shortcuts (when focus is not in a text field):

| Key | Action |
|---|---|
| `Space` / `K` | Play/pause |
| `←` / `→` | Seek −10s / +10s |
| `↑` / `↓` | Volume up/down |
| `F` | Fullscreen |
| `M` | Mute |
| `C` | Cycle subtitles |
| `S` | Stream statistics |
| `Esc` | Close menu/panel, exit fullscreen, or back to details |

On the seek bar itself, `←`/`→` nudge 5 seconds, `PageUp`/`PageDown` 30 seconds, `Home`/`End` jump to
the ends.

Progress saves every 10 seconds while playing, on tab hide, and on exit. A title counts as finished at
90% or within the last 30 seconds.

## Music

`/music` has tabs: **Overview**, **Albums**, **Artists**, **Tracks**. The overview includes recently played and recently added rails.

- Click an album or artist to open a sheet with play/queue actions.
- A persistent mini-player appears at the bottom: play/pause, previous/next, seek, shuffle, repeat,
  volume, queue, and “add to playlist”.
- Queue, shuffle, and repeat mode are remembered for the browser session (session storage).
- Media Session metadata appears in OS media keys/notifications where supported.
- Track playback uses byte-range streaming, so seeking works without transcoding.

## Photos

`/photos` shows a month-grouped masonry timeline with folder chips.

- Click any tile to open the lightbox.
- Lightbox controls: previous/next, zoom, info panel, download, slideshow toggle, close (`Esc`).
- Keyboard: `←`/`→` navigate, `Z` toggles zoom, `I` toggles the info panel, `S` toggles slideshow, `Esc` closes.
- Folder chips filter to a folder relative to the library root.
- Originals are served unchanged through `/api/photos/:id/file`, with HTTP range support.

## Collections

Collections are curated piles. Two kinds:

- **Manual** — add/remove items and reorder them.
- **Smart** — rules evaluated live at read time; nothing is copied or stale.

Smart rule fields the UI exposes: `kind`, `genre`, `year`, `rating`, `tag`, `person`, `libraryId`,
`addedWithinDays`, `titleContains`. Combine with **all** or **any**. Rule values are validated by the
server; bad rules are rejected, not silently ignored.

Four pinned collections are seeded on first read: **Certified Bangers** (manual, initially empty),
**Recently Added** (last 30 days), **Absolute Cinema** (rating ≥ 8), and **The Vault** (year < 2000).
Admins/managers can edit or delete them.

Collection pages show the evaluated item list, rule descriptions, and a **Play all** action for
playable items.

## Playlists

Playlists are ordered, user-owned queues. Kinds:

| Kind | Accepts |
|---|---|
| `video` | movies, episodes, videos |
| `audio` | tracks |
| `photo` | photos |
| `mixed` | movies, episodes, videos, tracks (not photos) |

- Create from **Playlists → New playlist**; choose public/private (public lists are visible to all
  signed-in users).
- Add media from item pages or the playlist page; reorder with ↑/↓; remove with ✕.
- **Duplicate** clones the list and its items.
- Cap: 500 items per playlist. Only the creator (or an admin) can edit or delete it.

## Requests and reports

- **Requests** (`/requests`) lets signed-in users ask for a title (`movie`, `show`, `music`, `other`)
  with an optional year/note. Your own list shows status: pending, approved, rejected, fulfilled.
- Admins/managers see all requests, can review them, leave a review note, and move
  pending → approved/rejected/fulfilled. Approved requests can later be fulfilled.
- Requests can be disabled in **Admin → Settings → Allow requests**.
- **Report content** opens a local moderation report against an item (or by title). Reports go to
  **Admin → Moderation**; no email or external service is involved.
- Rate limits: 10 new requests and 10 reports per hour per user.

## Watch parties

- Start one from `/party/new`: pick a playable movie/episode, name it, and create.
- The party page shows the members (max 20), now-playing card, and a copyable invite link.
- **Copy invite link** points at the player in party mode. The host's play/pause/seek state is
  published to `/api/parties/:id/state` and fans out over `party.sync` SSE. Attendees follow within a
  few seconds.
- Only the host (or an admin) can drive state; anyone in the party can leave. The host leaving ends it.
- Parties can be disabled in **Admin → Settings → Allow parties**.

## Profile and preferences

**Profile** covers:

- Display name and avatar hue.
- Theme: Slop (lime), Dark, Midnight, Daylight.
- Playback: autoplay next episode, default subtitle language, default audio preference.
- Interface: card density, spoiler blur for episode descriptions, meme copy on/off.
- Password change (revokes other sessions), profile PIN, active sessions.
- **Export my data** (JSON) and **Log out**.
- Account deletion is exposed as an admin action in the UI; the API also supports self-deletion with
  password confirmation. See [Privacy](PRIVACY.md).

## TV mode and mobile

- **TV mode** enlarges cards and focus rings. Use arrow keys to move, Enter to open, Backspace/browser
  back to return.
- **Mobile** (narrow screens) switches to a bottom nav with Home, Movies, Shows, Music, Photos, and
  More. The player and photo lightbox are touch-friendly; pinch/zoom behavior follows the browser.
- Both modes share the same API and per-user state.

## Search tips

- Search is case-insensitive and literal (`%`/`_` are escaped).
- It matches title, original title, description, genre, and cast/crew names.
- Results are grouped into movies, shows, episodes, people, albums, tracks, and genres.
- Press `/` anywhere outside a text field to focus the search box; `Esc` clears/blurs it.
