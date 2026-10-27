# Media naming

The scanner is deliberately forgiving, but it is not psychic. This page is the contract it actually
implements: what gets scanned, how titles/years/episodes are inferred, and which sidecar files it
reads.

## Supported files

| Type | Extensions |
|---|---|
| Video | `mkv`, `mp4`, `m4v`, `avi`, `webm`, `mov`, `wmv`, `flv`, `mpg`, `mpeg`, `ts`, `m2ts` |
| Audio | `mp3`, `flac`, `m4a`, `aac`, `ogg`, `opus`, `wav`, `wma`, `alac`, `aiff`, `aif` |
| Images | `jpg`, `jpeg`, `png`, `webp`, `gif`, `avif`, `bmp` |
| Subtitles | `srt`, `vtt`, `ass`, `ssa` |
| Metadata | `.nfo` |

Folders starting with `.` are skipped, as are common NAS/service junk folders: `@eaDir`, `#recycle`,
`.git`, `.svn`, `node_modules`, `lost+found`, `$RECYCLE.BIN`, `System Volume Information`, `.Trash`,
`.Trashes`, `.stfolder`. Symlinked files/folders are followed, but visited real paths prevent loops.

Library kinds decide what is scanned: `movies` only indexes video, `shows` only video, `music` only
audio, `photos` only images, and `mixed` takes everything. A video in a music library is invisible.

## Ingestion inboxes and the organized layout

Scanned libraries are read-only. Ingestion is the writable path: it watches drop folders, renames files
into a library, then scans the result. The default inboxes are `/data/ingest/movies`,
`/data/ingest/tv`, `/data/ingest/music`, and `/data/ingest/photos` (host `./data/ingest/...`). Any
mounted absolute directory can be a source instead; a read-only `/media` mount needs the `copy`,
`hardlink`, or `symlink` action.

Inbox names can be messy or exact — the same filename/NFO inference used by scans applies. The
organized result is canonical:

```text
Movies/
└── Touch Grass (2022)/
    ├── Touch Grass (2022).mp4
    ├── Touch Grass (2022).nfo          # carried from the inbox
    ├── Touch Grass (2022).en.srt
    └── poster.jpg

Shows/
└── The Slopening/
    ├── tvshow.nfo                       # show-level sidecar from the inbox
    ├── poster.jpg
    └── Season 01/
        └── The Slopening - S01E02 - The Algorithm Sent Me Here.mkv

Music/
└── DJ Neural Net/
    └── GPU Fan Goes Brrr/
        ├── cover.jpg
        └── 01 - GPU Fan Goes Brrr.flac

Photos/
└── 2026/
    └── 01 - grandma said based.jpg
```

Naming rules:

| Kind | Canonical path |
|---|---|
| Movie | `<Title> (<Year>)/<Title> (<Year>)<ext>`; year omitted when unknown |
| Show | `<Show>/Season NN/<Show> - SxxEyy - <Episode Title><ext>` |
| Music | `<Artist>/<Album>/<NN - Title><ext>`; fallbacks `Unknown Artist`/`Unknown Album` |
| Photo | `<YYYY>/<original name>` |

- Every segment is sanitized; `/`, `\`, control characters, traversal segments, and NUL cannot escape
  the library root. Long segments are capped at 120 characters.
- Existing files are never overwritten. Collisions get ` (2)`, ` (3)`, … before the extension.
- Same-stem subtitles/NFO and recognized art sidecars are carried with the primary file. Shared
  show/album/artist sidecars are written once. If a provider/manual title contradicts a movie/show NFO,
  that NFO is intentionally not carried over.
- Read-only inbox + `move` fails. `symlink` destinations point at the absolute inbox path, so deleting
  the inbox file later breaks playback. Full trade-offs: [Ingestion → File actions](INGESTION.md#file-actions).

Ingestion sources are manager/admin-only and never delete source files when a source or queue row is
deleted. See [Ingestion](INGESTION.md).

## Movies

Any video file in a `movies` library becomes one movie. The title and year come from the filename
first, then the containing folder.

```text
Movies/
├── Touch Grass (2022).mp4
├── Absolute Cinema (2025) [1080p] [BluRay].mkv
└── The Slopening (2023)/
    └── The.Slopening.2023.WEB-DL.x264.mkv
```

All three resolve to the right title/year. Recognized junk tokens (`1080p`, `2160p`, `BluRay`,
`WEB-DL`, `x264`, `x265`, `HEVC`, `AAC`, `DTS`, `REMUX`, `PROPER`, release-group tags, and friends)
are stripped from names. Use a year in parentheses or brackets if you want it detected:

```text
Movie Title (2019).mkv        ✅ year 2019
Movie.Title.2019.1080p.mkv    ✅ year 2019
Movie Title.mkv               ⚠️ no year; edit it in Admin → Media
```

Two movies in one folder are both indexed. A generic `movie.nfo` is a candidate for every movie in
that folder, so give each file its own matching NFO when sharing a folder. The generic `movie.srt`
subtitle shortcut, on the other hand, only applies when the folder has a single video.

## Shows, seasons, episodes

```text
Shows/
└── The Slopening/
    ├── tvshow.nfo
    ├── poster.jpg
    ├── fanart.jpg
    ├── Season 01/
    │   ├── S01E01 - Pilot (Derogatory).mkv
    │   ├── S01E02 - The Algorithm Sent Me Here.mkv
    │   └── S01E02 - The Algorithm Sent Me Here.en.srt
    └── Season 02/
        ├── S02E01 - Return of the Group Chat.mkv
        └── S02E02 - The Patch Notes Are a Threat.mkv
```

- The **show** is the folder containing the season folders, e.g. `The Slopening`.
- Season folders may be `Season 01`, `Season 1`, `Series 1`, `S01`, or just `01`.
- `Specials` or `Season 0` becomes season 0.
- Episodes without a season folder are grouped into `Season 01` automatically.

Accepted episode patterns (case-insensitive, with `.`, space, `_`, or `-` separators):

```text
S01E02 - Episode Title.mkv
S01E02.Episode.Title.mkv
Show.Name.S01E02.1080p.mkv
1x02 - Episode Title.mkv
Season 1 Episode 2 - Title.mkv
```

If no title follows the episode number, the UI shows `Episode N`. Episode files do not have to live
in a folder named after the show; the show title is inferred from the folder above the season.

## Music

The sane layout is `Artist/Album/NN - Track.ext`:

```text
Music/
└── DJ Neural Net/
    ├── artist.nfo
    ├── artist.jpg                 # artist portrait (folder.jpg / poster.jpg also work)
    └── GPU Fan Goes Brrr/
        ├── album.nfo
        ├── cover.jpg
        ├── 01 - GPU Fan Goes Brrr.flac
        └── 02 - 3090 Degrees of Separation.flac
```

- **Artist** = the folder above the album folder.
- **Album** = the folder containing audio files.
- **Track number** comes from embedded tags first, then `01 -`, `1-02`, `03.`, `disc1-01`, and similar
  prefixes.
- **Title** comes from the embedded title tag first, then the filename. `01 - Artist - Track.flac`
  also parses the artist segment.
- Embedded `genre` becomes the track genre. `date`/`year` populates the year.
- A flat folder of audio directly under the library root becomes one album by **Unknown Artist**.
  Works for mixtapes; looks unhinged for a real library.

Album cover priority includes `cover.jpg/png`, `folder.jpg/png`, `poster.jpg`, and embedded art
extracted by ffmpeg. For artists, `folder.jpg`, `artist.jpg`, or a poster works.

## Photos

```text
Photos/
├── 2026-10 - Family/
│   ├── 01 - grandma said based.jpg
│   └── 02 - family reunion but the wifi works.jpg
└── misc/
    └── 2026-07 - beach.png
```

- Every image in a `photos` library becomes a photo.
- Folder paths are shown relative to the library root and are used for folder chips/filters.
- The timeline groups by month. It uses the row's release date when present; scanned photos currently
  fall back to the date they were indexed. Filename years are parsed for the title/year, not used as
  capture timestamps.
- Images are served through the app with byte-range support; originals are not re-encoded.

## NFO metadata

NFO is optional and local-only. When present, it is merged before any optional provider lookup.

| Target | Files checked |
|---|---|
| Movie/video/episode | `<basename>.nfo`, `<filename>.nfo`, `movie.nfo` (most specific first) |
| Show | `tvshow.nfo`, `show.nfo` inside the show folder |
| Season | `season.nfo` inside the season folder |
| Album | `album.nfo` inside the album folder |
| Artist | `artist.nfo` inside the artist folder |

Fields understood include:

```xml
<movie>
  <title>Touch Grass</title>
  <originaltitle>Touch Grass</originaltitle>
  <year>2022</year>
  <premiered>2022-06-01</premiered>
  <plot>A shut-in is legally required to touch one blade of grass.</plot>
  <tagline>Go outside. It is a trap.</tagline>
  <rating>7.9</rating>
  <mpaa>PG-13</mpaa>
  <runtime>24</runtime>          <!-- minutes -->
  <genre>Comedy</genre>
  <genre>Horror</genre>
  <tag>certified</tag>
  <uniqueid type="tmdb" default="true">123456</uniqueid>
  <actor><name>Guy Indoors</name><role>Lead</role></actor>
</movie>
```

`plot`/`outline`, `premiered`/`aired`/`releasedate`, `mpaa`/`certification`, and `uniqueid` are also
accepted. A malformed or oversized NFO is ignored with a warning in the log; it will not fail the scan.

## Sidecar art

Drop images next to the media (or in the show/album folder). Filenames checked include:

| Kind | Filenames |
|---|---|
| Poster | `<title>-poster.jpg/png`, `poster.jpg/png`, `folder.jpg/png`, `cover.jpg/png`, `movie.jpg` |
| Backdrop | `fanart.jpg/png`, `backdrop.jpg`, `background.jpg`, `art.jpg`, `<title>-fanart.jpg` |
| Banner | `banner.jpg/png` |
| Logo | `logo.png/jpg`, `clearlogo.png` |
| Thumb | `thumb.jpg`, `thumbnail.jpg`, `<title>-thumb.jpg` |
| Artist avatar | `folder.jpg`, `artist.jpg`, `poster.jpg` |

Season posters can be `season01-poster.jpg`, `season1-poster.jpg`, or `season 01-poster.jpg`.

Sidecar art always wins over generated frames. If there is no art, the scanner extracts a frame with
ffmpeg and the UI falls back to a generated placeholder rather than showing a broken image.

## Subtitles

External subtitle matching is based on the video's basename:

```text
S01E02 - The Algorithm Sent Me Here.mkv
S01E02 - The Algorithm Sent Me Here.en.srt          ✅ English
S01E02 - The Algorithm Sent Me Here.en.forced.srt  ✅ English, forced
S01E02 - The Algorithm Sent Me Here.en.sdh.srt     ✅ English, SDH
```

Rules:

- `<basename>.<lang>.srt` (or `.vtt`, `.ass`, `.ssa`) attaches to that video.
- Bare `<basename>.srt` uses the server's default language (`en`).
- In a one-movie folder, generic `movie.srt` / `movie.en.srt` also matches.
- Language tokens are 2–3 letters (`en`, `eng`, `de`, `jpn`); `forced`, `sdh`, `cc` are flags.
- Embedded text subtitles are discovered by ffprobe and converted to WebVTT on demand.
- Bitmap subtitles can be burned into a transcode; they cannot be rendered as a browser text track.

## Example tree, all together

```text
media/
├── Movies/
│   ├── Absolute Cinema (2025)/
│   │   ├── Absolute Cinema (2025).mkv
│   │   ├── Absolute Cinema (2025).nfo
│   │   ├── poster.jpg
│   │   ├── fanart.jpg
│   │   └── Absolute Cinema (2025).en.srt
│   └── Touch Grass (2022).mp4
├── Shows/
│   └── Keeping Up with the Algorithms/
│       ├── tvshow.nfo
│       ├── poster.jpg
│       ├── fanart.jpg
│       ├── Season 01/
│       │   ├── S01E01 - Influencer in the Wild.mkv
│       │   ├── S01E02 - My Boyfriend Is a Bot (Not Clickbait).mkv
│       │   └── S01E02 - My Boyfriend Is a Bot (Not Clickbait).en.srt
│       └── Season 02/
│           └── S02E01 - We Went to Therapy (Sponsored).mkv
├── Music/
│   └── DJ Neural Net/
│       ├── artist.nfo
│       └── Loss Function Love Songs/
│           ├── album.nfo
│           ├── cover.jpg
│           ├── 01 - Attention Is All You Need (But Not From You).flac
│           └── 02 - Overfitting on Your Love.flac
└── Photos/
    └── 2026-10 - Family/
        └── 01 - me when the wifi drops.jpg
```

If a scan finds nothing, confirm the library path is the **container** path and that its kind matches
the files. See [Troubleshooting](TROUBLESHOOTING.md#media-not-detected).
