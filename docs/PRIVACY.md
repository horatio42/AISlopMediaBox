# Privacy

Short version: the box does not phone home. Long version: here is exactly what is stored, what leaves,
and what the threat model actually covers. Metadata providers — TMDB, TheTVDB, OMDb, TVmaze, and IMDb
suggestions — are all opt-in and off by default.

## Zero outbound by default

The server makes **no outbound network requests** unless you configure a metadata provider. There is no
telemetry, analytics, crash reporting, update check, external font, CDN asset, or third-party script.

You can verify this from the running instance:

```bash
curl -b slop.cookies http://localhost:3100/api/admin/privacy
```

It returns live values:

```json
{
  "zeroOutbound": true,
  "telemetry": false,
  "analytics": false,
  "externalFonts": 0,
  "cdnAssets": 0,
  "thirdPartyScripts": 0,
  "outboundEndpoints": []
}
```

`zeroOutbound` is true when no TMDB/TVDB/OMDb key is configured and both keyless toggles (TVmaze, IMDb
suggestions) are off. It is the live answer, not a marketing constant: anything that can dial out appears
in `outboundEndpoints` with its host, provider, and modes (`manual`, plus `scan` when automatic matching
is eligible).

The UI enforces the same posture:

- CSP: `default-src 'self'`, `img-src 'self' data: blob:`, `media-src 'self' blob:`,
  `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`.
- `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
- All frontend assets (including `hls.js`) are served from this repo/container. Generated placeholder
  art is local SVG/data URLs. Remote provider posters are not rendered by the CSP; review cards use local
  placeholder art instead.

The Docker **build** downloads Debian packages and npm dependencies, like any image build. That is a
build-time action, not runtime telemetry, and it happens on your machine/CI.

## Metadata providers and hosts

Five providers can be enabled. Keyed providers activate when a key exists; keyless providers activate
only when their toggle is explicitly on. Both default to **off**.

| Provider | Configuration | Kinds | Hosts | Notes |
|---|---|---|---|---|
| TMDB | `TMDB_API_KEY` env or **Settings → TMDB API key** | movie, show | `api.themoviedb.org` (API), `image.tmdb.org` (art) | existing metadata client |
| TheTVDB | `TVDB_API_KEY` env or **Settings → TVDB v4 API key** | movie, show | `api4.thetvdb.com` (API), `artworks.thetvdb.com` (art) | token cached in memory; compose forwards the env var from `.env` |
| OMDb | `OMDB_API_KEY` env or **Settings → OMDb API key** | movie, show | `www.omdbapi.com` (API), `m.media-amazon.com` (art) | IMDb-backed details; compose forwards the env var from `.env` |
| TVmaze | **Settings → Use TVmaze (keyless)** (`tvmazeEnabled`, default `false`) | show | `api.tvmaze.com` (API), `static.tvmaze.com` (art) | no key |
| IMDb suggestions | **Settings → Use IMDb suggestions** (`imdbEnabled`, default `false`) | movie, show | `v2.sg.media-imdb.com` (API), `m.media-amazon.com` (art) | unofficial keyless suggestion endpoint; can change without notice |

Gating:

- A provider is **configured** with a key, or for keyless providers structurally configured; keyless
  providers still need their toggle.
- **Manual** provider/match searches are explicit admin actions. They contact configured/enabled
  providers even when the global `autoMatch` switch is off.
- **Automatic** matching during scans/ingestion requires the global `autoMatch` setting **and** the
  per-source `autoMatch` toggle, plus a configured/enabled provider.
- Keyless providers are never called while their toggle is off. Disabling a provider stops both manual
  and automatic use.
- `GET /api/ingest/providers` (manager) and **Admin → Ingestion** show status, kinds, and hosts, never
  keys. `GET /api/admin/privacy` additionally reports `keySource` (`env`/`settings`/`none`) and the
  toggle state.

What leaves: the title/query/year or provider id you (or an automatic scan) search for, and your
server's IP. No username, email, password, watch progress, library listing, or file path is sent to a
provider.

Keys:

- Keys entered in Settings are stored as plaintext strings in the local SQLite database (there is no
  vault). Emptying the setting clears it; environment keys resolve as a fallback and are not persisted.
- Visible only to admins via `GET /api/admin/settings`.
- Redacted (`''`) from `settings.changed` SSE broadcasts, audit change values (`[set]`/`[cleared]`),
  and instance metadata exports.
- Never logged. Provider request URLs/keys are not written to logs.
- Clearing every key and turning both keyless toggles off returns the box to `zeroOutbound: true`.

Local NFO parsing, filename inference, ffmpeg art extraction, and all playback work without any provider.

## Cookies

| Property | Value |
|---|---|
| Name | `slop_session` |
| Contents | random 32-byte session id (base64url), not user data |
| `HttpOnly` | yes |
| `SameSite` | `Strict` |
| `Secure` | only when `SECURE_COOKIES=1` (set this behind HTTPS) |
| `Path` | `/` |
| Lifetime | `SESSION_DAYS` (default 30), server also stores expiry |

Sessions live in SQLite and are deleted on logout, password change (all other sessions), admin
password reset, or disabling the account. Expired sessions are swept hourly. Cookies are never placed
in URLs or logs.

## Passwords and PINs

- Passwords and profile PINs use **scrypt**: `N=16384, r=8, p=1`, 64-byte key, 16-byte random salt,
  stored as `scrypt$<salt-hex>$<hash-hex>`.
- Verification uses `crypto.timingSafeEqual`.
- Passwords are never logged, exported, or broadcast.
- Rate limits: login 10/5min/IP, registration 5/hour/IP, password change 6/15min/user.
- There is no email-based recovery. Losing the last admin means restoring a backup or editing the
  database.

## Where data lives

Everything persistent is under `DATA_DIR` (default `/data` in Docker, `./data` from source):

| Path | Contents | Notes |
|---|---|---|
| `/data/aislop.db` | Users, sessions, libraries, media index, progress, favorites, playlists, collections, requests, reports, logs, settings | Plain SQLite (WAL), **not encrypted at rest** |
| `/data/cache/images` | Generated/uploaded art | Regenerable |
| `/data/cache/subtitles` | Converted WebVTT | Regenerable |
| `/data/cache/transcode` | Transient HLS sessions | Auto-cleaned after 90s idle |
| `/data/cache/logs` | Spooled log files if any | Local only |
| `/data/ingest` | Drop folders for ingestion | Writable; host `./data/ingest` |
| `/data/media` | Demo media / default library root | Generated locally; ingestion destinations may write here |
| Your mount (`/media`) | Your source files | Read-only in the compose example; ingestion sources can point here |

Logs are stored in SQLite and include request paths, status codes, user ids, IPs (login/audit), and
job/admin actions. Passwords, tokens, cookies, and file contents are not logged.

## User data export and deletion

**Export (self-service)**

- Profile → **Export my data** downloads JSON: favorites, watched, ratings, progress, collections,
  playlists, requests, reports, sessions.
- `GET /api/users/me/export` is the endpoint behind it.

**Deletion (self-service API)**

```bash
curl -b slop.cookies -X DELETE -H 'content-type: application/json' \
  -d '{"password":"your-password"}' \
  http://localhost:3100/api/users/me
```

The last enabled admin cannot self-delete. The current UI describes account deletion as an admin
action; the API supports self-deletion as above.

**Deletion (admin)**

**Admin → Users → Delete** removes the account. What happens to related data:

| Data | After user deletion |
|---|---|
| Sessions, favorites/watched/ratings, progress, party memberships | Deleted (cascade) |
| Playlists and collections created by the user | **Kept**, `created_by` becomes null; they remain visible/listed as orphaned |
| Requests and reports | **Kept**, `user_id` becomes null; shown as deleted user |
| Stream rows | Kept for history, `user_id` becomes null |

This is deliberate so shared playlists and moderation history do not vanish when an account does. If
you need full erasure, delete those rows too or restore from a pre-deletion backup.

**Instance metadata export** (`GET /api/admin/export`) contains users without password hashes and
redacts TMDB/TVDB/OMDb keys. It is not a database backup and does not include media bytes or art.

## Threat model: what this is not

AISlopMediaBox is a **single-household media server**, not a hardened multi-tenant SaaS.

**Covered-ish:**

- Session cookies are HttpOnly/SameSite=Strict; cross-origin mutations are rejected by an
  `Origin`/`Host` check.
- CSP blocks external scripts/assets; no inline scripts are used.
- Authorization is enforced server-side per route (`user`, `manager`, `admin`); hiding a button is not
  the control.
- Password hashing and rate limits raise the cost of credential attacks.
- Media paths are resolved from database rows only; clients cannot request arbitrary filesystem paths.
- Transcode segment filenames are strictly validated and confined to the session directory.
- Inputs (paths, rules, ids, uploads) are validated and bounded.

**Not covered:**

- **No encryption at rest.** Anyone with the disk or `/data` can read the SQLite database, including
  password hashes and watch history.
- **No 2FA**, no SSO, no email verification, no account recovery.
- **No per-user media ACLs.** Any signed-in user can browse/play everything indexed. Use separate
  accounts for household members, not for adversarial tenants.
- **Reverse proxy/TLS is your responsibility.** Session cookies are only `Secure` if you set
  `SECURE_COOKIES=1`. Exposing port 3100 directly to the internet is a bad idea.
- **The server trusts its admin.** Admins can browse directories on the host (inside the container),
  export metadata, edit media, and run maintenance. An admin compromise is game over.
- **Logs/IPs are visible to admins** and are not anonymized.
- **Any enabled metadata provider sees queries and your IP.** TMDB, TVDB, OMDb, TVmaze, and IMDb
  suggestions are the only possible third parties; all are opt-in.
- **Ingestion can modify files.** A source with the `move` action relocates drop files into a library
  (cross-device: copy + unlink). `copy`, `hardlink`, and `symlink` do not delete the inbox file. Deleting
  a source or queue row deletes database rows only. Providers never receive file paths.
- **Backups are plaintext.** Protect the archive like the database.
- Browser extensions, compromised client devices, and OS-level attackers are out of scope.

For internet exposure: put it behind HTTPS (Caddy/nginx), keep the admin password strong, avoid
port-forwarding the raw HTTP port, and keep the container and dependencies updated.
