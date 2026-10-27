import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { settings } from '../db.ts';
import { logger } from '../lib/logger.ts';
import type { PersonDTO } from '../types.ts';
import type { ProviderId } from './providers.ts';

/* ------------------------------------------------------------------ */
/* Filename / folder inference                                         */
/* ------------------------------------------------------------------ */

const JUNK_TOKENS: Record<string, true> = Object.fromEntries([
  '1080p', '720p', '2160p', '480p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'dolbyvision',
  'bluray', 'blu-ray', 'brrip', 'bdrip', 'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'dvdrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'ac3', 'dts', 'dd5', 'ddp5', 'atmos',
  'remux', 'proper', 'repack', 'extended', 'unrated', 'directors', 'cut', 'imax', 'multi',
  'internal', 'limited', 'complete', 'rarbg', 'yts', 'yify', 'amzn', 'nf', 'dsnp', 'hmax',
].map((token) => [token, true as const]));

const AUDIO_EXT: Record<string, true> = Object.fromEntries(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'alac', 'aiff', 'aif'].map((ext) => [ext, true as const]));
const IMAGE_EXT: Record<string, true> = Object.fromEntries(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'].map((ext) => [ext, true as const]));
const VIDEO_EXT: Record<string, true> = Object.fromEntries(['mkv', 'mp4', 'm4v', 'avi', 'webm', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts'].map((ext) => [ext, true as const]));

export type FileClass = 'video' | 'audio' | 'image' | 'subtitle' | 'nfo' | 'other';

export function classifyExtension(fileName: string): FileClass {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (VIDEO_EXT[ext]) return 'video';
  if (AUDIO_EXT[ext]) return 'audio';
  if (IMAGE_EXT[ext]) return 'image';
  if (ext === 'srt' || ext === 'vtt' || ext === 'ass' || ext === 'ssa') return 'subtitle';
  if (ext === 'nfo') return 'nfo';
  return 'other';
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function titleFromRaw(raw: string): string {
  let text = raw.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/^\[[^\]]*\]\s*/, '').replace(/\s*\[[^\]]*\]/, '');
  const tokens = text.split(' ').filter((token) => {
    const bare = token.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return bare.length > 0 && !JUNK_TOKENS[bare] && !/^\d{1,2}$/.test(bare);
  });
  const cleaned = tokens.join(' ').replace(/^[-–—\s]+|[-–—\s]+$/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
}

export interface ParsedMovieName {
  title: string;
  year: number | null;
}

/** `Movie.Title.(2019).[1080p].mkv` -> `{ title: 'Movie Title', year: 2019 }` */
export function parseMovieFilename(fileName: string): ParsedMovieName {
  const base = stripExtension(fileName).replace(/_/g, ' ').trim();
  const yearMatch = base.match(/[([.\s-](19\d{2}|20\d{2})(?=[)\].,\s-]|$)/);
  let year: number | null = null;
  let titlePart = base;
  if (yearMatch && yearMatch.index !== undefined) {
    year = Number(yearMatch[1]);
    titlePart = base.slice(0, yearMatch.index);
  }
  let title = titleFromRaw(titlePart);
  if (!title || /^[-_.\s]*$/.test(title)) title = titleFromRaw(base);
  return { title: title || 'Untitled slop', year };
}

export interface ParsedEpisodeName {
  season: number;
  episode: number;
  title: string;
}

const EPISODE_PATTERNS: RegExp[] = [
  /(?:^|[.\s_-])s(\d{1,3})[.\s_-]*e(\d{1,4})(?:[.\s_-]*(.*))?$/i,
  /(?:^|[.\s_-])(\d{1,3})x(\d{1,4})(?:[.\s_-]*(.*))?$/i,
  /(?:^|[.\s_-])season[.\s_-]*(\d{1,3})[.\s_-]*episode[.\s_-]*(\d{1,4})(?:[.\s_-]*(.*))?$/i,
];

/** `Show.Name.S01E02 - Pilot.mkv` -> `{ season: 1, episode: 2, title: 'Pilot' }` */
export function parseEpisodeFilename(fileName: string): ParsedEpisodeName | null {
  const base = stripExtension(fileName).replace(/_/g, ' ').trim();
  for (const pattern of EPISODE_PATTERNS) {
    const match = base.match(pattern);
    if (!match) continue;
    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    const rawTitle = (match[3] || '').replace(/[.\s_-]+$/g, '').replace(/^[-–—.\s]+/, '');
    const parsedTitle = titleFromRaw(rawTitle);
    return { season, episode, title: parsedTitle || `Episode ${episode}` };
  }
  return null;
}

export function parseSeasonFolder(folderName: string): { season: number | null; title: string } {
  const normalized = folderName.replace(/[._]+/g, ' ').trim();
  if (/^(specials?)$/i.test(normalized)) return { season: 0, title: 'Specials' };
  const match = normalized.match(/(?:season|series|s)\s*(\d{1,3})/i) || normalized.match(/^(\d{1,3})$/);
  if (match) {
    const season = Number(match[1]);
    if (Number.isFinite(season)) return { season, title: `Season ${String(season).padStart(2, '0')}` };
  }
  return { season: null, title: normalized };
}

export interface ParsedTrackName {
  trackNumber: number | null;
  discNumber: number | null;
  title: string;
  artist: string | null;
}

/** `01 - Artist - Track.flac`, `1-02 Title.mp3`, `03. Title.flac`, `Title.flac` */
export function parseTrackFilename(fileName: string): ParsedTrackName {
  const base = stripExtension(fileName).replace(/_/g, ' ').trim();
  let discNumber: number | null = null;
  let trackNumber: number | null = null;
  let rest = base;
  const discMatch = base.match(/^(?:d|disc)\s*(\d{1,2})[-.\s]+/i);
  if (discMatch) {
    discNumber = Number(discMatch[1]);
    rest = base.slice(discMatch[0].length);
  }
  const trackMatch = rest.match(/^(?:cd\s*\d+[-.\s]+)?(\d{1,3})[-.\s]+/i);
  if (trackMatch) {
    trackNumber = Number(trackMatch[1]);
    rest = rest.slice(trackMatch[0].length);
  }
  let artist: string | null = null;
  let title = rest;
  const dash = rest.split(/\s+-\s+/);
  if (dash.length >= 2) {
    artist = dash[0].trim() || null;
    title = dash.slice(1).join(' - ');
  }
  title = titleFromRaw(title);
  return { trackNumber, discNumber, title: title || titleFromRaw(base), artist };
}

/* ------------------------------------------------------------------ */
/* Safe minimal XML parser (NFO)                                       */
/* ------------------------------------------------------------------ */

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlNode[];
}

const MAX_XML_BYTES = 512 * 1024;
const MAX_XML_DEPTH = 40;
const MAX_XML_NODES = 5000;

function decodeEntities(value: string): string {
  // Fixed whitelist only — custom DOCTYPE entities are never expanded, which
  // rules out billion-laughs style entity explosions.
  return value.replace(/&(#x?[0-9a-fA-F]{1,7}|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return whole;
  });
}

/** Parse NFO XML into a tree. Unknown/malformed markup is ignored, never throws. */
export function parseXml(source: string): XmlNode {
  const input = source.slice(0, MAX_XML_BYTES).replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const root: XmlNode = { name: '#root', attributes: {}, text: '', children: [] };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let cursor = 0;
  while (cursor < input.length && nodes < MAX_XML_NODES) {
    const open = input.indexOf('<', cursor);
    if (open === -1) {
      const text = input.slice(cursor).trim();
      if (text) stack[stack.length - 1].text += decodeEntities(text).slice(0, 100_000);
      break;
    }
    if (open > cursor) {
      const text = input.slice(cursor, open).trim();
      if (text) stack[stack.length - 1].text += decodeEntities(text).slice(0, 100_000);
    }
    const close = input.indexOf('>', open);
    if (close === -1) break;
    const tag = input.slice(open + 1, close);
    cursor = close + 1;
    if (tag.startsWith('!--')) {
      const endComment = input.indexOf('-->', close);
      cursor = endComment === -1 ? input.length : endComment + 3;
      continue;
    }
    if (tag.startsWith('!') || tag.startsWith('?')) continue;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim().toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = body.match(/^([A-Za-z_][\w:.-]*)/);
    if (!nameMatch) continue;
    const node: XmlNode = { name: nameMatch[1].toLowerCase(), attributes: {}, text: '', children: [] };
    const attrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRegex.exec(body)) !== null) {
      node.attributes[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? '').slice(0, 2000);
    }
    nodes += 1;
    stack[stack.length - 1].children.push(node);
    if (!selfClosing && stack.length < MAX_XML_DEPTH) stack.push(node);
  }
  return root;
}

export function findXmlChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

export function findXmlChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function textOf(node: XmlNode | undefined): string {
  return node ? (node.text.replace(/\s+/g, ' ').trim()) : '';
}

export function xmlInt(node: XmlNode | undefined): number | null {
  if (!node) return null;
  const text = textOf(node);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function xmlFloat(node: XmlNode | undefined): number | null {
  if (!node) return null;
  const text = textOf(node);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------ */
/* NFO mapping                                                         */
/* ------------------------------------------------------------------ */

export interface NfoMetadata {
  title?: string;
  originalTitle?: string;
  year?: number;
  releaseDate?: string;
  description?: string;
  tagline?: string;
  rating?: number;
  contentRating?: string;
  runtimeSeconds?: number;
  genres: string[];
  tags: string[];
  people: PersonDTO[];
  provider?: string;
  providerId?: string;
}

function yearFromDate(value: string): number | null {
  const match = value.match(/(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
}

function collectGenres(root: XmlNode): string[] {
  const genres = new Set<string>();
  for (const node of root.children) {
    if (node.name === 'genre') {
      for (const piece of textOf(node).split(/[,/]/)) {
        const clean = piece.trim().slice(0, 60);
        if (clean) genres.add(clean);
      }
    }
    for (const nested of collectGenres(node)) genres.add(nested);
  }
  return [...genres].slice(0, 20);
}

function collectPeople(root: XmlNode): PersonDTO[] {
  const people: PersonDTO[] = [];
  const seen = new Set<string>();
  const add = (name: string, role: string, character?: string | null) => {
    const clean = name.trim().slice(0, 120);
    if (!clean || seen.has(`${role}:${clean}`)) return;
    seen.add(`${role}:${clean}`);
    people.push({ name: clean, role, character: character?.trim().slice(0, 200) || null });
  };
  for (const node of root.children) {
    if (node.name === 'actor') {
      add(textOf(findXmlChild(node, 'name')), 'cast', textOf(findXmlChild(node, 'role')) || null);
      if (people.length >= 50) break;
    } else if (node.name === 'director') {
      add(textOf(node), 'director');
    } else if (node.name === 'writer' || node.name === 'credits') {
      add(textOf(node), 'writer');
    }
  }
  return people.slice(0, 60);
}

/** Map a generic Kodi NFO tree to normalized metadata. */
export function metadataFromNfo(root: XmlNode, kind: 'movie' | 'show' | 'episode' | 'album' | 'artist' | 'season'): NfoMetadata {
  const body = findXmlChild(root, kind) || findXmlChild(root, 'movie') || findXmlChild(root, 'tvshow') || root;
  const yearValue = xmlInt(findXmlChild(body, 'year'));
  const dateValue = textOf(findXmlChild(body, 'premiered')) || textOf(findXmlChild(body, 'aired')) || textOf(findXmlChild(body, 'releasedate'));
  const runtime = xmlInt(findXmlChild(body, 'runtime'));
  const uniqueId = findXmlChild(body, 'uniqueid');
  const provider = uniqueId?.attributes.type?.toLowerCase();
  const rating = xmlFloat(findXmlChild(body, 'rating'));
  const result: NfoMetadata = {
    genres: collectGenres(body),
    tags: findXmlChildren(body, 'tag').map((node) => textOf(node).slice(0, 60)).filter(Boolean).slice(0, 20),
    people: collectPeople(body),
  };
  const title = textOf(findXmlChild(body, 'title'));
  if (title) result.title = title.slice(0, 300);
  const original = textOf(findXmlChild(body, 'originaltitle'));
  if (original) result.originalTitle = original.slice(0, 300);
  if (yearValue !== null) result.year = yearValue;
  else if (dateValue) {
    const parsedYear = yearFromDate(dateValue);
    if (parsedYear) result.year = parsedYear;
  }
  if (dateValue) result.releaseDate = dateValue.slice(0, 10);
  const plot = textOf(findXmlChild(body, 'plot')) || textOf(findXmlChild(body, 'outline'));
  if (plot) result.description = plot.slice(0, 5000);
  const tagline = textOf(findXmlChild(body, 'tagline'));
  if (tagline) result.tagline = tagline.slice(0, 300);
  if (rating !== null) result.rating = Math.max(0, Math.min(10, rating));
  const mpaa = textOf(findXmlChild(body, 'mpaa')) || textOf(findXmlChild(body, 'certification'));
  if (mpaa) result.contentRating = mpaa.slice(0, 20);
  if (runtime !== null && runtime > 0) result.runtimeSeconds = Math.round(runtime * 60);
  if (provider && uniqueId) {
    result.provider = provider;
    result.providerId = textOf(uniqueId).slice(0, 60);
  } else if (uniqueId) {
    result.provider = 'nfo';
    result.providerId = textOf(uniqueId).slice(0, 60);
  }
  return result;
}

export interface NfoLookup {
  file: string;
  metadata: NfoMetadata;
}

export function readNfoFile(filePath: string, kind: 'movie' | 'show' | 'episode' | 'album' | 'artist' | 'season'): NfoMetadata | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_XML_BYTES * 2) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return metadataFromNfo(parseXml(content), kind);
  } catch (error) {
    logger.warn('metadata', `Could not read NFO ${filePath}: ${(error as Error).message}`);
    return null;
  }
}

/** Candidate NFO files for a media file / folder, most specific first. */
export function nfoCandidates(targetPath: string, kind: 'movie' | 'show' | 'episode' | 'album' | 'artist' | 'season'): string[] {
  if (kind === 'show') return [path.join(targetPath, 'tvshow.nfo'), path.join(targetPath, 'show.nfo')];
  if (kind === 'season') return [path.join(targetPath, 'season.nfo')];
  if (kind === 'album') return [path.join(targetPath, 'album.nfo')];
  if (kind === 'artist') return [path.join(targetPath, 'artist.nfo')];
  const dir = path.dirname(targetPath);
  const fileName = path.basename(targetPath);
  const base = stripExtension(fileName);
  return [path.join(dir, `${base}.nfo`), path.join(dir, `${fileName}.nfo`), path.join(dir, 'movie.nfo')];
}

export function findNfo(targetPath: string, kind: 'movie' | 'show' | 'episode' | 'album' | 'artist' | 'season'): NfoLookup | null {
  for (const candidate of nfoCandidates(targetPath, kind)) {
    if (!fs.existsSync(candidate)) continue;
    const metadata = readNfoFile(candidate, kind);
    if (metadata) return { file: candidate, metadata };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* TMDB client (only ever contacted when an admin supplies a key)      */
/* ------------------------------------------------------------------ */

export type MatchKind = 'movie' | 'show';

export interface TmdbCandidate {
  provider: 'tmdb';
  providerId: string;
  kind: MatchKind;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string;
  rating: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  popularity: number;
  score: number;
}

export interface ResolvedMetadata {
  provider: ProviderId;
  providerId: string;
  kind: MatchKind;
  title: string;
  originalTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  description: string;
  tagline: string | null;
  rating: number | null;
  contentRating: string | null;
  runtimeSeconds: number | null;
  genres: string[];
  tags: string[];
  people: PersonDTO[];
  posterUrl: string | null;
  backdropUrl: string | null;
  matchScore: number;
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Configured key from settings first (admin-controlled), env as fallback. */
export function tmdbApiKey(): string {
  const stored = settings.get('tmdbApiKey');
  return (typeof stored === 'string' && stored.trim()) || config.tmdbApiKey || '';
}

export function tmdbConfigured(): boolean {
  return tmdbApiKey().length > 0;
}

/** Remote matching is opt-in twice: a key exists AND autoMatch is enabled. */
export function tmdbEnabled(): boolean {
  return tmdbConfigured() && settings.get('autoMatch') !== false;
}

function tmdbImage(p: string | null | undefined, size = 'w780'): string | null {
  return p ? `${TMDB_IMAGE_BASE}/${size}${p}` : null;
}

function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const match = String(date).match(/(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 0..1 title+year similarity. Deterministic and explainable for matchScore. */
export function scoreCandidate(
  wantedTitle: string,
  wantedYear: number | null,
  candidateTitle: string,
  candidateYear: number | null,
): number {
  const wanted = normalizeTitle(wantedTitle);
  const candidate = normalizeTitle(candidateTitle);
  let titleScore = 0;
  if (wanted && candidate) {
    if (wanted === candidate) titleScore = 1;
    else if (candidate.startsWith(wanted) || wanted.startsWith(candidate)) titleScore = 0.8;
    else if (candidate.includes(wanted) || wanted.includes(candidate)) titleScore = 0.6;
    else {
      const wantedWords = new Set(wanted.split(' '));
      const candidateWords = new Set(candidate.split(' '));
      let overlap = 0;
      for (const word of wantedWords) if (candidateWords.has(word)) overlap += 1;
      titleScore = overlap / Math.max(wantedWords.size, candidateWords.size);
    }
  }
  const yearScore = wantedYear && candidateYear ? (wantedYear === candidateYear ? 1 : Math.abs(wantedYear - candidateYear) <= 1 ? 0.4 : 0) : 0;
  return Math.round((titleScore * 0.7 + yearScore * 0.3) * 1000) / 1000;
}

interface TmdbSearchResponse {
  results?: Record<string, unknown>[];
}

async function fetchJson(url: string): Promise<unknown> {
  const key = tmdbApiKey();
  if (!key) throw new Error('TMDB key not configured');
  const separator = url.includes('?') ? '&' : '?';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  const target = key.startsWith('eyJ') ? url : `${url}${separator}api_key=${encodeURIComponent(key)}`;
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`TMDB responded ${response.status}`);
  return response.json();
}

function candidateFromResult(result: Record<string, unknown>, kind: MatchKind, wantedTitle: string, wantedYear: number | null): TmdbCandidate {
  const title = String((kind === 'movie' ? result.title : result.name) || result.original_title || result.original_name || 'Untitled');
  const original = (kind === 'movie' ? result.original_title : result.original_name) as string | undefined;
  const date = String((kind === 'movie' ? result.release_date : result.first_air_date) || '');
  const year = yearOf(date);
  const vote = typeof result.vote_average === 'number' ? result.vote_average : null;
  const popularity = typeof result.popularity === 'number' ? result.popularity : 0;
  return {
    provider: 'tmdb',
    providerId: String(result.id ?? ''),
    kind,
    title: title.slice(0, 300),
    originalTitle: original ? original.slice(0, 300) : null,
    year,
    overview: String(result.overview || '').slice(0, 5000),
    rating: vote,
    posterUrl: tmdbImage(result.poster_path as string | null, 'w780'),
    backdropUrl: tmdbImage(result.backdrop_path as string | null, 'w1280'),
    popularity,
    score: scoreCandidate(wantedTitle, wantedYear, title, year),
  };
}

/** Search TMDB. Returns [] (never throws) when unconfigured or offline. */
export async function searchTmdb(kind: MatchKind, query: string, year: number | null = null, limit = 8, manual = false): Promise<TmdbCandidate[]> {
  if (!(manual ? tmdbConfigured() : tmdbEnabled()) || !query.trim()) return [];
  const url = new URL(`${TMDB_BASE}/search/${kind === 'movie' ? 'movie' : 'tv'}`);
  url.searchParams.set('language', config.defaultLanguage || 'en-US');
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('query', query.trim().slice(0, 200));
  if (year) url.searchParams.set(kind === 'movie' ? 'year' : 'first_air_date_year', String(year));
  try {
    const payload = (await fetchJson(url.toString())) as TmdbSearchResponse;
    const candidates = (payload.results || [])
      .slice(0, 20)
      .map((result) => candidateFromResult(result, kind, query, year))
      .filter((candidate) => candidate.providerId.length > 0)
      .sort((a, b) => b.score - a.score || b.popularity - a.popularity);
    return candidates.slice(0, limit);
  } catch (error) {
    logger.warn('metadata', `TMDB search failed: ${(error as Error).message}`);
    return [];
  }
}

function pickCertification(kind: MatchKind, payload: Record<string, unknown>): string | null {
  const preferred = config.defaultLanguage.toUpperCase() === 'EN' ? 'US' : config.defaultLanguage.toUpperCase();
  if (kind === 'movie') {
    const releaseDates = payload.release_dates as { results?: { iso_3166_1?: string; release_dates?: { certification?: string }[] }[] } | undefined;
    const list = releaseDates?.results || [];
    const ordered = [...list].sort((a, b) => (a.iso_3166_1 === preferred ? -1 : 0) - (b.iso_3166_1 === preferred ? -1 : 0));
    for (const entry of ordered) {
      const cert = entry.release_dates?.find((item) => item.certification)?.certification;
      if (cert) return cert.slice(0, 20);
    }
    return null;
  }
  const contentRatings = payload.content_ratings as { results?: { iso_3166_1?: string; rating?: string }[] } | undefined;
  const list = contentRatings?.results || [];
  return (list.find((entry) => entry.iso_3166_1 === preferred) || list[0])?.rating?.slice(0, 20) || null;
}

function peopleFromCredits(credits: Record<string, unknown> | undefined): PersonDTO[] {
  const people: PersonDTO[] = [];
  const cast = (credits?.cast as { name?: string; character?: string }[] | undefined) || [];
  for (const member of cast.slice(0, 30)) {
    if (!member.name) continue;
    people.push({ name: String(member.name).slice(0, 120), role: 'cast', character: member.character ? String(member.character).slice(0, 200) : null });
  }
  const crew = (credits?.crew as { name?: string; job?: string }[] | undefined) || [];
  for (const member of crew) {
    if (!member.name) continue;
    const job = (member.job || '').toLowerCase();
    if (job === 'director') people.push({ name: String(member.name).slice(0, 120), role: 'director', character: null });
    else if (job === 'writer' || job === 'screenplay') people.push({ name: String(member.name).slice(0, 120), role: 'writer', character: null });
  }
  return people.slice(0, 60);
}

/** Fetch full TMDB details for one provider id. Returns null when unavailable. */
export async function tmdbDetails(kind: MatchKind, providerId: string, wantedTitle = '', wantedYear: number | null = null, manual = false): Promise<ResolvedMetadata | null> {
  if (!(manual ? tmdbConfigured() : tmdbEnabled())) return null;
  const url = new URL(`${TMDB_BASE}/${kind === 'movie' ? 'movie' : 'tv'}/${encodeURIComponent(providerId)}`);
  url.searchParams.set('language', config.defaultLanguage || 'en-US');
  url.searchParams.set('append_to_response', kind === 'movie' ? 'credits,release_dates' : 'credits,content_ratings,external_ids');
  try {
    const payload = (await fetchJson(url.toString())) as Record<string, unknown>;
    const title = String(payload.title || payload.name || wantedTitle || 'Untitled');
    const original = (payload.original_title || payload.original_name) as string | undefined;
    const date = String(payload.release_date || payload.first_air_date || '') || null;
    const year = yearOf(date);
    const runtime = kind === 'movie' ? Number(payload.runtime) : Number((payload.episode_run_time as number[] | undefined)?.[0]);
    const genres = ((payload.genres as { name?: string }[] | undefined) || []).map((genre) => String(genre.name || '')).filter(Boolean).slice(0, 20);
    const vote = typeof payload.vote_average === 'number' ? payload.vote_average : null;
    return {
      provider: 'tmdb',
      providerId: String(payload.id ?? providerId),
      kind,
      title: title.slice(0, 300),
      originalTitle: original ? original.slice(0, 300) : null,
      year,
      releaseDate: date ? date.slice(0, 10) : null,
      description: String(payload.overview || '').slice(0, 5000),
      tagline: payload.tagline ? String(payload.tagline).slice(0, 300) : null,
      rating: vote !== null ? Math.round(vote * 10) / 10 : null,
      contentRating: pickCertification(kind, payload),
      runtimeSeconds: Number.isFinite(runtime) && runtime > 0 ? Math.round(runtime * 60) : null,
      genres,
      tags: ((payload.keywords as { keywords?: { name?: string }[] } | undefined)?.keywords || [])
        .map((word) => String(word.name || ''))
        .filter(Boolean)
        .slice(0, 20),
      people: peopleFromCredits(payload.credits as Record<string, unknown> | undefined),
      posterUrl: tmdbImage(payload.poster_path as string | null, 'w780'),
      backdropUrl: tmdbImage(payload.backdrop_path as string | null, 'w1280'),
      matchScore: scoreCandidate(wantedTitle || title, wantedYear, title, year),
    };
  } catch (error) {
    logger.warn('metadata', `TMDB details failed: ${(error as Error).message}`);
    return null;
  }
}
