#!/usr/bin/env node
/**
 * AISlopMediaBox demo library generator.
 *
 * Synthesizes a tiny-but-real media library with ffmpeg/ffprobe only:
 *   movies/  ~10 720p clips (Kodi NFO + poster.jpg + fanart.jpg per movie)
 *   shows/   2 shows x 2 seasons x 3 episodes (tvshow.nfo + episode NFOs + art)
 *   music/   1 artist x 2 albums x 4 m4a tracks (embedded tags + cover.jpg)
 *   photos/  8 meme stills + a photos/family/ album subfolder
 *
 * Original shitpost titles only. No network calls, no npm deps.
 * Idempotent: a manifest under <media>/.demo-manifest.json records every file,
 * so reruns are a no-op unless files vanished or the content version changed.
 *
 * Usage:
 *   node scripts/demo-content.mjs [--force] [--quiet] [--data DIR] [--media DIR]
 *
 * Env: DATA_DIR (default ./data), MEDIA_DIR (default $DATA_DIR/media), DEMO_FONT.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = '.demo-manifest.json';
const VIDEO_W = 1280;
const VIDEO_H = 720;
const VIDEO_FPS = 24;

const PALETTES = [
  ['0x09080d', '0x7b5cff', '0xc8ff3d'],
  ['0x11051f', '0xff4d9d', '0x7b5cff'],
  ['0x04120f', '0xc8ff3d', '0x1fd1c8'],
  ['0x1a0b02', '0xff8a3d', '0xff4d9d'],
  ['0x050a1f', '0x3d8bff', '0xc8ff3d'],
  ['0x140214', '0xff4d9d', '0xffd23d'],
  ['0x001019', '0x1fd1c8', '0x7b5cff'],
  ['0x0d0d0d', '0xc8ff3d', '0xff4d9d'],
  ['0x0f0510', '0x7b5cff', '0x3d8bff'],
  ['0x120d00', '0xffd23d', '0xff8a3d'],
];

const MOVIES = [
  {
    title: 'The Last Brain Cell',
    year: 2024,
    duration: 32,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    source: 'testsrc2',
    palette: 0,
    genres: ['Sci-Fi', 'Comedy'],
    rating: 8.7,
    tagline: 'One neuron. Zero thoughts. Full send.',
    plot:
      'After the great doomscroll of 2024, one lonely neuron wakes up inside a skull-shaped studio apartment and must send the group chat a single coherent thought. It fails, beautifully. The sequel is a screenshot.',
    director: 'Dee P. Scroll',
    cast: ['Mona Pane', 'Cortex Carl', 'The Group Chat'],
    premiered: '2024-03-14',
  },
  {
    title: 'Touch Grass',
    year: 2022,
    duration: 24,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 2,
    genres: ['Comedy', 'Horror'],
    rating: 7.9,
    tagline: 'The township made him go outside. Big mistake.',
    plot:
      'A shut-in is legally required by the township to touch one (1) blade of grass. What he finds there cannot be posted, mostly because the upload fails on 4G. A cautionary tale about leaving the house.',
    director: 'Fern Outside',
    cast: ['Guy Indoors', 'A Very Normal Lawn', 'The Sun (uncredited)'],
    premiered: '2022-06-01',
  },
  {
    title: 'Absolute Cinema',
    year: 2025,
    duration: 41,
    file: 'mkv',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 5,
    genres: ['Drama', 'Comedy'],
    rating: 9.1,
    tagline: 'Four hours of applause. His knees were not ready.',
    plot:
      'A film critic gives a four-hour standing ovation to a microwave instruction manual. Around hour three his knees file a formal complaint. The manual wins Best Adapted Screenplay.',
    director: 'A. Cinephile',
    cast: ['Roger Ebert-Fan', 'The Microwave', 'A Chipped Mug'],
    premiered: '2025-01-17',
  },
  {
    title: 'It Insists Upon Itself',
    year: 1999,
    duration: 45,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 7,
    genres: ['Drama', 'Mystery'],
    rating: 6.4,
    tagline: 'A ceiling fan with opinions about the audience.',
    plot:
      'A black-and-white shot of a ceiling fan for ninety minutes, except the fan has opinions about the audience and will not stop sharing them. Screening includes a mandatory intermission and a light lecture.',
    director: 'Bartholomew Pretentious',
    cast: ['Ceiling Fan (lead)', 'A Chair', 'Interpretive Dust'],
    premiered: '1999-11-12',
  },
  {
    title: 'L + Ratio, The Reckoning',
    year: 2023,
    duration: 28,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    source: 'testsrc2',
    palette: 1,
    genres: ['Action', 'Thriller'],
    rating: 7.2,
    tagline: 'He was one reply away from retirement.',
    plot:
      'A retired reply guy is pulled back in for one last quote tweet. His block list is six thousand names deep and growing. The final boss is a bot with a blue checkmark and a link to a podcast.',
    director: 'Quote Tweet Tarantino',
    cast: ['Reply Guy', 'Ratio Bot 3000', 'The Quote Tweet'],
    premiered: '2023-08-09',
  },
  {
    title: 'No Thoughts, Head Empty',
    year: 2021,
    duration: 36,
    file: 'mkv',
    vcodec: 'mpeg4',
    acodec: 'mp3',
    palette: 3,
    genres: ['Fantasy', 'Comedy'],
    rating: 8.3,
    tagline: 'The elevator music is doing the thinking now.',
    plot:
      'A wizard swaps his brain for elevator music and somehow his DPS goes up. Peer review calls it peak. Critics call it a lifestyle. The soundtrack is the same four notes for the entire runtime.',
    director: 'Mage Mid Music',
    cast: ['Wizard (formerly smart)', 'Elevator Music', 'A Clipboard'],
    premiered: '2021-04-20',
  },
  {
    title: 'Skill Issue',
    year: 2024,
    duration: 30,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 4,
    genres: ['Sports', 'Comedy'],
    rating: 7.6,
    tagline: 'They lost to a golden retriever with a controller.',
    plot:
      'An esports team loses a best-of-five to a golden retriever who only presses A. The post-match interview is forty minutes of cope and one very good boy. Sponsorship offers pour in for the dog.',
    director: 'Bench Warmer',
    cast: ['Pro Player', 'A Golden Retriever', 'The Coach (asleep)'],
    premiered: '2024-07-07',
  },
  {
    title: 'Cope and Seethe',
    year: 1998,
    duration: 38,
    file: 'mkv',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 9,
    genres: ['Thriller', 'Mystery'],
    rating: 7.4,
    tagline: 'Two moderators. One bunker. Zero dial tone.',
    plot:
      'Two rival forum moderators share a bunker during the great dial-up outage of 1998. Only one can have the last word in a thread nobody else can load. The tension is palpable and the modem is screaming.',
    director: 'Dial Tone De Palma',
    cast: ['Mod One', 'Mod Two', 'A 56k Modem'],
    premiered: '1998-10-30',
  },
  {
    title: 'Peak Fiction',
    year: 2025,
    duration: 34,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 6,
    genres: ['Adventure', 'Fantasy'],
    rating: 9.4,
    tagline: 'The final boss was a calendar invite all along.',
    plot:
      'A hero ascends the mountain of unread notifications to retrieve the one true reply. Along the way he fights 4,012 unopened emails and a recurring meeting titled "sync?". The ending is genuinely moving, which is embarrassing.',
    director: 'Notification Nemesis',
    cast: ['The Hero', 'Inbox Zero (mythical)', 'Calendar Invite'],
    premiered: '2025-02-28',
  },
  {
    title: 'Goated on the Timeline',
    year: 2020,
    duration: 26,
    file: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    palette: 8,
    genres: ['Western', 'Comedy'],
    rating: 6.9,
    tagline: 'The sheriff asked for a source. He had none.',
    plot:
      'A lone poster drifts into a dusty town with nothing but a cropped screenshot and a dream. The sheriff asks for the source. Our hero has no source. A tense standoff follows, resolved by a very long quote chain.',
    director: 'Screenshot Eastwood',
    cast: ['Lone Poster', 'Sheriff Repost', 'A Cropped Screenshot'],
    premiered: '2020-05-05',
  },
];

const SHOWS = [
  {
    title: 'The Slopening',
    year: 2023,
    file: 'mkv',
    palette: 1,
    genres: ['Anthology', 'Comedy', 'Horror'],
    rating: 8.1,
    tagline: 'Greenlit by a committee of vibes.',
    plot:
      'An anthology of things that absolutely should not have been greenlit, hosted by a brain cell in a tiny hat. Every episode is a new low point with a laugh track that was recorded against its will.',
    seasons: [
      {
        number: 1,
        episodes: [
          {
            title: 'Pilot (Derogatory)',
            duration: 22,
            rating: 7.8,
            plot: 'The host introduces a show about introducing shows. The committee approves it by accident and refuses to rescind the approval.',
          },
          {
            title: 'The Algorithm Sent Me Here',
            duration: 25,
            rating: 8.4,
            plot: 'A recommendation engine develops a crush on a viewer and starts scheduling their entire life. The viewer just wanted one cooking video.',
          },
          {
            title: 'Nobody Asked for Season Two',
            duration: 27,
            rating: 8.9,
            plot: 'Renewed against all reason, the anthology returns with an episode about returning with an episode. The meta levels are load-bearing now.',
          },
        ],
      },
      {
        number: 2,
        episodes: [
          {
            title: 'Return of the Group Chat',
            duration: 24,
            rating: 7.5,
            plot: 'The group chat becomes self-aware and immediately starts a sidebar about the group chat. Nobody can find the mute button.',
          },
          {
            title: 'The Patch Notes Are a Threat',
            duration: 26,
            rating: 8.2,
            plot: 'A patch note promises "improved vibes" and delivers an existential crisis with a changelog. Six hundred players leave a thumbs up.',
          },
          {
            title: 'Series Finale (Please Clap)',
            duration: 29,
            rating: 9.0,
            plot: 'The show ends in a twelve-minute applause break the crew did not authorize. The brain cell takes off its tiny hat and says nothing.',
          },
        ],
      },
    ],
  },
  {
    title: 'Keeping Up with the Algorithms',
    year: 2024,
    file: 'mp4',
    palette: 4,
    genres: ['Reality', 'Comedy'],
    rating: 7.7,
    tagline: 'One router. Six influencers. Zero coping mechanisms.',
    plot:
      'Six influencers share one router and zero coping mechanisms. The wifi password is "based". Every episode ends with a sponsored apology and a link in the bio that definitely works.',
    seasons: [
      {
        number: 1,
        episodes: [
          {
            title: 'Influencer in the Wild',
            duration: 23,
            rating: 7.1,
            plot: 'The housemates discover the backyard and immediately film a three-part series about touching a tree. The tree does not sign a release form.',
          },
          {
            title: 'My Boyfriend Is a Bot (Not Clickbait)',
            duration: 25,
            rating: 8.0,
            plot: 'One housemate introduces her new boyfriend, who is a customer support chatbot. He brings flowers and a 14-page terms of service.',
          },
          {
            title: 'The Sponsorship Arc',
            duration: 28,
            rating: 8.6,
            plot: 'A sponsor demands the entire cast say the product name forty times per scene. The resulting episode is legally a jingle.',
          },
        ],
      },
      {
        number: 2,
        episodes: [
          {
            title: 'We Went to Therapy (Sponsored)',
            duration: 24,
            rating: 7.3,
            plot: 'Group therapy is interrupted by a discount code for a mattress company. The therapist asks everyone to comment, subscribe, and breathe.',
          },
          {
            title: 'The Comment Section Awakens',
            duration: 26,
            rating: 8.2,
            plot: 'The comment section gains sentience and starts critiquing the housemates from inside the app. Top comment: "skill issue".',
          },
          {
            title: 'Unsubscribed',
            duration: 30,
            rating: 8.8,
            plot: 'The router finally dies and the housemates must speak to each other with no analytics. The finale is 47 minutes of silence and one genuine hug.',
          },
        ],
      },
    ],
  },
];

const MUSIC = {
  artist: 'DJ Neural Net',
  genres: ['Synthwave', 'Slopstep'],
  albums: [
    {
      title: 'Loss Function Love Songs',
      year: 2022,
      genre: 'Synthwave',
      palette: 0,
      tracks: [
        { title: 'Attention Is All You Need (But Not From You)', freq: 261.63, duration: 12 },
        { title: 'Overfitting on Your Love', freq: 293.66, duration: 11 },
        { title: 'Gradient Descent Into Madness', freq: 329.63, duration: 13 },
        { title: 'Loss Function Lullaby', freq: 349.23, duration: 10 },
      ],
    },
    {
      title: 'GPU Fan Goes Brrr',
      year: 2024,
      genre: 'Slopstep',
      palette: 1,
      tracks: [
        { title: 'GPU Fan Goes Brrr', freq: 392.0, duration: 12 },
        { title: '3090 Degrees of Separation', freq: 440.0, duration: 11 },
        { title: 'Hallucinated Boyfriend', freq: 466.16, duration: 13 },
        { title: 'Context Window Widening', freq: 523.25, duration: 10 },
      ],
    },
  ],
};

const PHOTOS = [
  { name: '01 - me when the wifi drops.jpg', text: 'me when the wifi drops', width: 1600, height: 900, palette: 0 },
  { name: '02 - average enjoyer.jpg', text: 'average fan vs average enjoyer', width: 900, height: 1600, palette: 1 },
  { name: '03 - no thoughts head empty.jpg', text: 'no thoughts head empty', width: 1600, height: 900, palette: 2 },
  { name: '04 - POV you touched grass.jpg', text: 'POV: you touched grass', width: 900, height: 1600, palette: 3 },
  { name: '05 - this is fine.jpg', text: 'this is fine (server is on fire)', width: 1600, height: 900, palette: 4 },
  { name: '06 - brain exe.jpg', text: 'brain.exe stopped responding', width: 900, height: 1600, palette: 5 },
  { name: '07 - certified bruh moment.jpg', text: 'certified bruh moment', width: 1600, height: 900, palette: 6 },
  { name: '08 - it insists upon itself.jpg', text: 'it insists upon itself', width: 900, height: 1600, palette: 7 },
];

const FAMILY_PHOTOS = [
  { name: '01 - family reunion wifi works.jpg', text: 'family reunion, but the wifi works', width: 1600, height: 900, palette: 8 },
  { name: '02 - grandma said based.jpg', text: 'grandma said based', width: 900, height: 1600, palette: 9 },
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { force: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') out.force = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--data') out.data = argv[++i];
    else if (arg.startsWith('--data=')) out.data = arg.slice('--data='.length);
    else if (arg === '--media') out.media = argv[++i];
    else if (arg.startsWith('--media=')) out.media = arg.slice('--media='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.data || process.env.DATA_DIR || 'data');
const mediaDir = path.resolve(args.media || process.env.MEDIA_DIR || path.join(dataDir, 'media'));
const quiet = args.quiet;

function log(...parts) {
  if (!quiet) console.log('[demo]', ...parts);
}

function fail(message) {
  console.error(`[demo] ERROR: ${message}`);
  process.exit(1);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runFfmpeg(argv, label) {
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const result = spawnSync(ffmpegBin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...argv], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label}: could not run ffmpeg (${result.error.message})`);
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n').slice(-4).join(' | ');
    throw new Error(`${label}: ffmpeg exited ${result.status}${stderr ? ` — ${stderr}` : ''}`);
  }
}

function ffEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line.length) line = word;
    else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Locate a usable TTF/OTF for drawtext. Returns null when the box has no fonts. */
function findFont() {
  if (process.env.DEMO_FONT === 'none') return null;
  if (process.env.DEMO_FONT && fs.existsSync(process.env.DEMO_FONT)) return process.env.DEMO_FONT;
  try {
    const probe = spawnSync('fc-match', ['-f', '%{file}', 'sans-serif:style=Bold'], { encoding: 'utf8' });
    const candidate = String(probe.stdout || '').trim();
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch {
    /* fc-match is not installed; fall through */
  }
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/noto/NotoSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    'C:\\Windows\\Fonts\\arialbd.ttf',
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

const fontFile = findFont();
let tmpDir = null;

function txt(name, content) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aislop-demo-'));
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Build drawtext filters from line specs. Each line gets its own textfile so
 * punctuation, colons and quotes can never break the ffmpeg filtergraph.
 */
function overlayFilters(lines) {
  if (!fontFile || !lines.length) return [];
  return lines.map((line, index) => {
    const file = txt(`line-${index}.txt`, line.text);
    const parts = [
      `fontfile=${ffEscape(fontFile)}`,
      `textfile=${ffEscape(file)}`,
      `fontsize=${line.size || 48}`,
      `fontcolor=${line.color || 'white'}`,
      'line_spacing=12',
      'expansion=none',
    ];
    if (line.box) {
      parts.push('box=1', `boxcolor=${line.boxColor || '0x000000@0.45'}`, `boxborderw=${line.boxBorder || 24}`);
    }
    if (line.shadow) parts.push('shadowcolor=0x000000@0.6', 'shadowx=3', 'shadowy=3');
    parts.push(`x=${line.x || '(w-text_w)/2'}`, `y=${line.y || '(h-text_h)/2'}`);
    if (line.alpha !== undefined) parts.push(`alpha=${line.alpha}`);
    return `drawtext=${parts.join(':')}`;
  });
}

function gradientSource(width, height, duration, paletteIndex, type = 'linear') {
  const [c0, c1, c2] = PALETTES[paletteIndex % PALETTES.length];
  return `gradients=s=${width}x${height}:r=${VIDEO_FPS}:d=${duration}:c0=${c0}:c1=${c1}:c2=${c2}:nb_colors=3:type=${type}:speed=0.015:seed=${paletteIndex + 7}`;
}

/** Render a single still JPEG (poster/fanart/cover/photo/meme). */
function generateStill({ out, width, height, paletteIndex, lines = [], pattern = false, quality = 5 }) {
  mkdirp(path.dirname(out));
  const filters = overlayFilters(lines);
  const source = pattern || !fontFile ? `testsrc2=s=${width}x${height}:r=1:d=1` : gradientSource(width, height, 1, paletteIndex, 'radial');
  const argv = ['-f', 'lavfi', '-i', source, '-frames:v', '1'];
  if (filters.length) argv.push('-vf', filters.join(','));
  argv.push('-q:v', String(quality), '-pix_fmt', 'yuvj420p', out);
  runFfmpeg(argv, `still ${path.basename(out)}`);
}

function generateVideo({
  out,
  duration,
  paletteIndex,
  source = 'gradients',
  vcodec = 'h264',
  acodec = 'aac',
  frequency = 220,
  title,
  year,
  genre,
  comment,
}) {
  mkdirp(path.dirname(out));
  const videoSource =
    source === 'testsrc2'
      ? `testsrc2=s=${VIDEO_W}x${VIDEO_H}:r=${VIDEO_FPS}:d=${duration}`
      : gradientSource(VIDEO_W, VIDEO_H, duration, paletteIndex);
  const argv = [
    '-f', 'lavfi', '-i', videoSource,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=${duration}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-t', String(duration),
  ];
  if (vcodec === 'mpeg4') {
    argv.push('-c:v', 'mpeg4', '-q:v', '9', '-pix_fmt', 'yuv420p');
  } else {
    argv.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '48');
  }
  if (acodec === 'mp3') argv.push('-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1');
  else argv.push('-c:a', 'aac', '-b:a', '64k', '-ac', '1');
  argv.push('-metadata', `title=${title}`, '-metadata', `date=${year}`, '-metadata', `genre=${genre}`);
  if (comment) argv.push('-metadata', `comment=${comment}`);
  if (out.endsWith('.mp4') || out.endsWith('.m4a')) argv.push('-movflags', '+faststart');
  argv.push(out);
  runFfmpeg(argv, `video ${path.basename(out)}`);
}

function generateAudio({ out, duration, frequency, title, artist, album, track, year, genre }) {
  mkdirp(path.dirname(out));
  const argv = [
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=${duration}`,
    '-t', String(duration),
    '-c:a', 'aac', '-b:a', '96k', '-ac', '1',
    '-metadata', `title=${title}`,
    '-metadata', `artist=${artist}`,
    '-metadata', `album_artist=${artist}`,
    '-metadata', `album=${album}`,
    '-metadata', `track=${track}`,
    '-metadata', `date=${year}`,
    '-metadata', `genre=${genre}`,
    '-movflags', '+faststart',
    out,
  ];
  runFfmpeg(argv, `audio ${path.basename(out)}`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function writeFile(out, content) {
  mkdirp(path.dirname(out));
  fs.writeFileSync(out, content, 'utf8');
}

function movieNfo(movie) {
  const unique = `slop-${movie.year}-${slugify(movie.title)}`;
  const genres = movie.genres.map((genre) => `  <genre>${xmlEscape(genre)}</genre>`).join('\n');
  const cast = movie.cast
    .map((name, index) => `  <actor>\n    <name>${xmlEscape(name)}</name>\n    <role>${xmlEscape(index === 0 ? 'Lead' : 'Supporting')}</role>\n    <order>${index}</order>\n  </actor>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>${xmlEscape(movie.title)}</title>
  <originaltitle>${xmlEscape(movie.title)}</originaltitle>
  <sorttitle>${xmlEscape(movie.title)}</sorttitle>
  <plot>${xmlEscape(movie.plot)}</plot>
  <tagline>${xmlEscape(movie.tagline)}</tagline>
  <year>${movie.year}</year>
  <premiered>${movie.premiered}</premiered>
  <runtime>${Math.max(1, Math.round(movie.duration / 60))}</runtime>
  <rating>${movie.rating.toFixed(1)}</rating>
  <votes>1337</votes>
  <mpaa>PG-13</mpaa>
${genres}
  <director>${xmlEscape(movie.director)}</director>
${cast}
  <studio>AISlop Originals</studio>
  <uniqueid type="slopdb" default="true">${unique}</uniqueid>
  <uniqueid type="tmdb">0</uniqueid>
  <thumb aspect="poster">poster.jpg</thumb>
  <fanart>
    <thumb>fanart.jpg</thumb>
  </fanart>
</movie>
`;
}

function tvShowNfo(show) {
  const genres = show.genres.map((genre) => `  <genre>${xmlEscape(genre)}</genre>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>${xmlEscape(show.title)}</title>
  <plot>${xmlEscape(show.plot)}</plot>
  <tagline>${xmlEscape(show.tagline)}</tagline>
  <year>${show.year}</year>
  <rating>${show.rating.toFixed(1)}</rating>
  <season>-1</season>
  <episode>-1</episode>
  <status>Continuing</status>
${genres}
  <studio>AISlop Originals</studio>
  <uniqueid type="slopdb" default="true">slop-show-${show.year}-${slugify(show.title)}</uniqueid>
  <thumb aspect="poster">poster.jpg</thumb>
  <fanart>
    <thumb>fanart.jpg</thumb>
  </fanart>
</tvshow>
`;
}

function episodeNfo(show, season, episode, index) {
  const runtime = Math.max(1, Math.round(episode.duration / 60));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${xmlEscape(episode.title)}</title>
  <showtitle>${xmlEscape(show.title)}</showtitle>
  <plot>${xmlEscape(episode.plot)}</plot>
  <season>${season.number}</season>
  <episode>${index + 1}</episode>
  <year>${show.year}</year>
  <rating>${episode.rating.toFixed(1)}</rating>
  <runtime>${runtime}</runtime>
  <uniqueid type="slopdb" default="true">slop-ep-${show.year}-${slugify(show.title)}-s${season.number}e${index + 1}</uniqueid>
</episodedetails>
`;
}

function srt(cues) {
  return cues
    .map((cue, index) => {
      const stamp = (seconds) => {
        const ms = Math.round((seconds % 1) * 1000);
        const total = Math.floor(seconds);
        const hh = String(Math.floor(total / 3600)).padStart(2, '0');
        const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const ss = String(total % 60).padStart(2, '0');
        return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
      };
      return `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

const pad2 = (value) => String(value).padStart(2, '0');

function movieBase(movie) {
  return `${movie.title} (${movie.year})`;
}

function movieDir(movie) {
  return path.join('movies', movieBase(movie));
}

function movieVideoRel(movie) {
  return path.join(movieDir(movie), `${movieBase(movie)}.${movie.file}`);
}

function showDir(show) {
  return path.join('shows', show.title);
}

function seasonDir(show, season) {
  return path.join(showDir(show), `Season ${pad2(season.number)}`);
}

function episodeBase(season, index) {
  return `S${pad2(season.number)}E${pad2(index + 1)} - ${season.episodes[index].title}`;
}

function episodeRel(show, season, index) {
  return path.join(seasonDir(show, season), `${episodeBase(season, index)}.${show.file}`);
}

function albumDir(album) {
  return path.join('music', MUSIC.artist, album.title);
}

function trackBase(index, track) {
  return `${pad2(index + 1)} - ${track.title}`;
}

function expectedRelPaths() {
  const files = [];
  MOVIES.forEach((movie, index) => {
    const dir = movieDir(movie);
    files.push(movieVideoRel(movie));
    files.push(path.join(dir, `${movieBase(movie)}.nfo`));
    files.push(path.join(dir, 'movie.nfo'));
    files.push(path.join(dir, 'poster.jpg'));
    files.push(path.join(dir, 'fanart.jpg'));
    if (index === 0) files.push(path.join(dir, `${movieBase(movie)}.en.srt`));
  });
  SHOWS.forEach((show, showIndex) => {
    const root = showDir(show);
    files.push(path.join(root, 'tvshow.nfo'));
    files.push(path.join(root, 'poster.jpg'));
    files.push(path.join(root, 'fanart.jpg'));
    show.seasons.forEach((season, seasonIndex) => {
      files.push(path.join(seasonDir(show, season), `season${pad2(season.number)}-poster.jpg`));
      season.episodes.forEach((_episode, index) => {
        files.push(episodeRel(show, season, index));
        files.push(path.join(seasonDir(show, season), `${episodeBase(season, index)}.nfo`));
        if (showIndex === 0 && seasonIndex === 0 && index === 0) {
          files.push(path.join(seasonDir(show, season), `${episodeBase(season, index)}.en.srt`));
        }
      });
    });
  });
  files.push(path.join('music', MUSIC.artist, 'artist.jpg'));
  MUSIC.albums.forEach((album) => {
    files.push(path.join(albumDir(album), 'cover.jpg'));
    album.tracks.forEach((track, index) => {
      files.push(path.join(albumDir(album), `${trackBase(index, track)}.m4a`));
    });
  });
  PHOTOS.forEach((photo) => files.push(path.join('photos', photo.name)));
  FAMILY_PHOTOS.forEach((photo) => files.push(path.join('photos', 'family', photo.name)));
  return files;
}

function manifestMatches(expected) {
  if (args.force) return false;
  const manifestPath = path.join(mediaDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  if (manifest.version !== MANIFEST_VERSION || typeof manifest.files !== 'object' || manifest.files === null) return false;
  for (const rel of expected) {
    const recorded = manifest.files[rel];
    if (!recorded || typeof recorded.size !== 'number') return false;
    try {
      const stat = fs.statSync(path.join(mediaDir, rel));
      if (!stat.isFile() || stat.size !== recorded.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Remove files recorded in a previous manifest that are no longer part of the demo set. */
function cleanupStaleGenerated(expected) {
  const manifestPath = path.join(mediaDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return 0;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return 0;
  }
  if (!manifest || typeof manifest.files !== 'object' || manifest.files === null) return 0;
  const keep = new Set(expected);
  let removed = 0;
  const parents = new Set();
  for (const rel of Object.keys(manifest.files)) {
    if (keep.has(rel)) continue;
    const absolute = path.resolve(mediaDir, rel);
    if (!absolute.startsWith(mediaDir + path.sep)) continue;
    try {
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
        fs.unlinkSync(absolute);
        removed += 1;
        parents.add(path.dirname(absolute));
      }
    } catch {
      /* a stale file we cannot delete is not worth failing generation over */
    }
  }
  for (let dir of parents) {
    while (dir.startsWith(mediaDir + path.sep) && dir !== mediaDir) {
      try {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
  if (removed) log(`removed ${removed} stale fixture file(s) from a previous run`);
  return removed;
}

function walkFiles(dir, root, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, root, acc);
    else if (entry.isFile()) acc.push(path.relative(root, absolute));
  }
  return acc;
}

/* ------------------------------------------------------------------ */
/* generation                                                          */
/* ------------------------------------------------------------------ */

function generateMovie(movie, index) {
  const dir = path.join(mediaDir, movieDir(movie));
  const base = movieBase(movie);
  const videoPath = path.join(mediaDir, movieVideoRel(movie));
  log(`movie ${index + 1}/${MOVIES.length}: ${base} [${movie.vcodec}/${movie.acodec} ${movie.file}]`);

  generateVideo({
    out: videoPath,
    duration: movie.duration,
    paletteIndex: movie.palette,
    source: movie.source || 'gradients',
    vcodec: movie.vcodec,
    acodec: movie.acodec,
    frequency: 180 + index * 31,
    title: base,
    year: movie.year,
    genre: movie.genres[0],
    comment: movie.tagline,
  });

  const nfo = movieNfo(movie);
  writeFile(path.join(dir, `${base}.nfo`), nfo);
  writeFile(path.join(dir, 'movie.nfo'), nfo);

  generateStill({
    out: path.join(dir, 'poster.jpg'),
    width: 600,
    height: 900,
    paletteIndex: movie.palette,
    lines: [
      { text: 'AISLOP ORIGINAL', size: 18, color: '0xc8ff3d', y: 'h*0.09' },
      { text: wrapText(movie.title.toUpperCase(), 18), size: 58, color: 'white', y: 'h*0.32', box: true, boxColor: '0x000000@0.45' },
      { text: wrapText(movie.tagline, 26), size: 22, color: '0xffffff', y: 'h*0.60', shadow: true },
      { text: `${movie.year}  •  ${movie.genres.join(' / ')}`, size: 18, color: '0xc8ff3d', y: 'h*0.72' },
    ],
  });

  generateStill({
    out: path.join(dir, 'fanart.jpg'),
    width: 1280,
    height: 720,
    paletteIndex: movie.palette,
    lines: [
      { text: 'CERTIFIED SLOP', size: 20, color: '0xc8ff3d', x: 'w*0.06', y: 'h*0.10' },
      { text: wrapText(movie.title, 26), size: 64, color: 'white', x: 'w*0.06', y: 'h*0.45', box: true, boxColor: '0x000000@0.40' },
      { text: movie.tagline, size: 26, color: '0xffffff', x: 'w*0.06', y: 'h*0.68', shadow: true },
    ],
  });

  if (index === 0) {
    writeFile(
      path.join(dir, `${base}.en.srt`),
      srt([
        { start: 1.0, end: 4.5, text: 'The last brain cell logs on for the final time.' },
        { start: 5.0, end: 9.0, text: 'Somewhere, a group chat waits for a coherent thought.' },
        { start: 9.5, end: 14.0, text: 'It sends: "lol". The credits roll immediately.' },
      ]),
    );
  }
}

function generateShow(show, showIndex) {
  const root = path.join(mediaDir, showDir(show));
  log(`show ${showIndex + 1}/${SHOWS.length}: ${show.title} (${show.seasons.length} seasons)`);

  writeFile(path.join(root, 'tvshow.nfo'), tvShowNfo(show));
  generateStill({
    out: path.join(root, 'poster.jpg'),
    width: 600,
    height: 900,
    paletteIndex: show.palette,
    lines: [
      { text: 'AISLOP ORIGINAL SERIES', size: 16, color: '0xc8ff3d', y: 'h*0.09' },
      { text: wrapText(show.title.toUpperCase(), 16), size: 56, color: 'white', y: 'h*0.32', box: true, boxColor: '0x000000@0.45' },
      { text: wrapText(show.tagline, 26), size: 22, color: '0xffffff', y: 'h*0.62', shadow: true },
      { text: `${show.year}  •  ${show.genres.join(' / ')}`, size: 17, color: '0xc8ff3d', y: 'h*0.74' },
    ],
  });
  generateStill({
    out: path.join(root, 'fanart.jpg'),
    width: 1280,
    height: 720,
    paletteIndex: show.palette,
    lines: [
      { text: 'PEAK TELEVISION (ALLEGEDLY)', size: 20, color: '0xc8ff3d', x: 'w*0.06', y: 'h*0.10' },
      { text: wrapText(show.title, 24), size: 66, color: 'white', x: 'w*0.06', y: 'h*0.44', box: true, boxColor: '0x000000@0.40' },
      { text: show.tagline, size: 26, color: '0xffffff', x: 'w*0.06', y: 'h*0.70', shadow: true },
    ],
  });

  show.seasons.forEach((season, seasonIndex) => {
    const dir = path.join(mediaDir, seasonDir(show, season));
    generateStill({
      out: path.join(dir, `season${pad2(season.number)}-poster.jpg`),
      width: 600,
      height: 900,
      paletteIndex: (show.palette + season.number + 2) % PALETTES.length,
      lines: [
        { text: `SEASON ${season.number}`, size: 24, color: '0xc8ff3d', y: 'h*0.12' },
        { text: wrapText(show.title, 16), size: 52, color: 'white', y: 'h*0.40', box: true, boxColor: '0x000000@0.45' },
        { text: `${season.episodes.length} episodes of pure slop`, size: 20, color: '0xffffff', y: 'h*0.68' },
      ],
    });

    season.episodes.forEach((episode, index) => {
      const base = episodeBase(season, index);
      const videoPath = path.join(mediaDir, episodeRel(show, season, index));
      log(`  ${base}`);
      generateVideo({
        out: videoPath,
        duration: episode.duration,
        paletteIndex: (show.palette + season.number + index) % PALETTES.length,
        vcodec: 'h264',
        acodec: 'aac',
        frequency: 240 + showIndex * 40 + seasonIndex * 20 + index * 13,
        title: base,
        year: show.year,
        genre: show.genres[0],
        comment: episode.plot.slice(0, 160),
      });
      writeFile(path.join(dir, `${base}.nfo`), episodeNfo(show, season, episode, index));
      if (showIndex === 0 && seasonIndex === 0 && index === 0) {
        writeFile(
          path.join(dir, `${base}.en.srt`),
          srt([
            { start: 1.0, end: 4.0, text: 'Wait. Is this show about making a show?' },
            { start: 4.5, end: 8.0, text: 'The committee greenlit it by accident. Nobody can stop it now.' },
            { start: 8.5, end: 13.0, text: 'Somewhere a laugh track plays against its will.' },
          ]),
        );
      }
    });
  });
}

function generateMusic() {
  const artistRoot = path.join(mediaDir, 'music', MUSIC.artist);
  log(`music: ${MUSIC.artist} (${MUSIC.albums.length} albums)`);
  generateStill({
    out: path.join(artistRoot, 'artist.jpg'),
    width: 600,
    height: 600,
    paletteIndex: 2,
    lines: [
      { text: 'CERTIFIED BANGERS ONLY', size: 16, color: '0xc8ff3d', y: 'h*0.12' },
      { text: wrapText(MUSIC.artist.toUpperCase(), 18), size: 52, color: 'white', y: 'h*0.42', box: true, boxColor: '0x000000@0.45' },
      { text: MUSIC.genres.join(' / '), size: 20, color: '0xffffff', y: 'h*0.66' },
    ],
  });

  MUSIC.albums.forEach((album) => {
    const dir = path.join(mediaDir, albumDir(album));
    log(`  album: ${album.title} (${album.tracks.length} tracks)`);
    generateStill({
      out: path.join(dir, 'cover.jpg'),
      width: 600,
      height: 600,
      paletteIndex: album.palette,
      lines: [
        { text: 'AISLOP RECORDS', size: 15, color: '0xc8ff3d', y: 'h*0.10' },
        { text: wrapText(album.title.toUpperCase(), 16), size: 42, color: 'white', y: 'h*0.38', box: true, boxColor: '0x000000@0.45' },
        { text: `${MUSIC.artist}  •  ${album.year}`, size: 18, color: '0xffffff', y: 'h*0.64' },
      ],
    });
    album.tracks.forEach((track, index) => {
      generateAudio({
        out: path.join(dir, `${trackBase(index, track)}.m4a`),
        duration: track.duration,
        frequency: track.freq,
        title: track.title,
        artist: MUSIC.artist,
        album: album.title,
        track: index + 1,
        year: album.year,
        genre: album.genre,
      });
    });
  });
}

function photoLines(photo) {
  const landscape = photo.width > photo.height;
  return [
    { text: wrapText(photo.text, landscape ? 26 : 15), size: landscape ? 64 : 58, color: 'white', y: 'h*0.42', box: true, boxColor: '0x000000@0.50', boxBorder: 26 },
    { text: 'certified slop', size: 22, color: '0xc8ff3d', y: 'h*0.78', shadow: true },
  ];
}

function generatePhotos() {
  log(`photos: ${PHOTOS.length} + ${FAMILY_PHOTOS.length} family`);
  [...PHOTOS, ...FAMILY_PHOTOS].forEach((photo, index) => {
    const rel = index < PHOTOS.length ? path.join('photos', photo.name) : path.join('photos', 'family', photo.name);
    generateStill({
      out: path.join(mediaDir, rel),
      width: photo.width,
      height: photo.height,
      paletteIndex: photo.palette,
      lines: photoLines(photo),
      quality: 6,
    });
  });
}

function generateAll(expected) {
  const started = Date.now();
  mkdirp(mediaDir);
  if (args.force) log('--force: regenerating every fixture');
  cleanupStaleGenerated(expected);
  generateMusic();
  generatePhotos();
  MOVIES.forEach((movie, index) => generateMovie(movie, index));
  SHOWS.forEach((show, index) => generateShow(show, index));

  const files = walkFiles(mediaDir, mediaDir).filter((rel) => rel !== MANIFEST_NAME);
  const entries = {};
  let totalBytes = 0;
  for (const rel of files) {
    const size = fs.statSync(path.join(mediaDir, rel)).size;
    entries[rel] = { size };
    totalBytes += size;
  }
  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    generator: 'scripts/demo-content.mjs',
    files: entries,
    totalBytes,
  };
  fs.writeFileSync(path.join(mediaDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`done: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${seconds}s`);
  log(`media root: ${mediaDir}`);
  return { files: files.length, totalBytes };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  if (args.help) {
    console.log('Usage: node scripts/demo-content.mjs [--force] [--quiet] [--data DIR] [--media DIR]');
    console.log('Env: DATA_DIR, MEDIA_DIR, DEMO_FONT');
    return;
  }
  const expected = expectedRelPaths();
  if (!args.force && manifestMatches(expected)) {
    log(`media library already generated (${expected.length} files) at ${mediaDir}`);
    log('pass --force to rebuild every fixture');
    return;
  }
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const hasFfmpeg = spawnSync(ffmpegBin, ['-version'], { encoding: 'utf8' }).status === 0;
  if (!hasFfmpeg) fail('ffmpeg is required. Install it or set FFMPEG_PATH / put it on PATH.');
  log(`generating demo library under ${mediaDir}${fontFile ? '' : ' (no font found: drawtext text disabled)'}`);
  generateAll(expected);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
