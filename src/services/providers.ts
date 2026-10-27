import { config } from '../config.ts';
import { settings } from '../db.ts';
import { logger } from '../lib/logger.ts';
import type { PersonDTO } from '../types.ts';
import { scoreCandidate, searchTmdb, tmdbConfigured, tmdbDetails } from './metadata.ts';
import type { MatchKind, ResolvedMetadata } from './metadata.ts';

export type ProviderId = 'tmdb' | 'tvdb' | 'tvmaze' | 'omdb' | 'imdb';

export interface ProviderCandidate {
  provider: ProviderId;
  providerId: string;
  kind: 'movie' | 'show';
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

export interface ProviderResolved {
  provider: ProviderId;
  providerId: string;
  kind: 'movie' | 'show';
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

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  enabled: boolean;
  requiresKey: boolean;
  keyless: boolean;
  kinds: ('movie' | 'show')[];
  hosts: string[];
  note: string;
}

export const PROVIDER_IDS: ProviderId[] = ['tmdb', 'tvdb', 'tvmaze', 'omdb', 'imdb'];

const TMDB_HOSTS = ['api.themoviedb.org', 'image.tmdb.org'];
const TVDB_HOSTS = ['api4.thetvdb.com', 'artworks.thetvdb.com'];
const TVMAZE_HOSTS = ['api.tvmaze.com', 'static.tvmaze.com'];
const OMDB_HOSTS = ['www.omdbapi.com', 'm.media-amazon.com'];
const IMDB_HOSTS = ['v2.sg.media-imdb.com', 'm.media-amazon.com'];

const TVDB_ART_HOSTS: Record<string, true> = { 'artworks.thetvdb.com': true };
const TVMAZE_ART_HOSTS: Record<string, true> = { 'static.tvmaze.com': true };
const AMAZON_ART_HOSTS: Record<string, true> = { 'm.media-amazon.com': true };

const NETWORK_TIMEOUT_MS = 8000;
const DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

/* ------------------------------------------------------------------ */
/* Small bounded caches (details/search); never unbounded              */
/* ------------------------------------------------------------------ */

interface CacheEntry<T> {
  at: number;
  value: T;
}

class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = CACHE_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.at + this.ttlMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { at: Date.now(), value });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

const tvdbDetailCache = new TtlCache<ProviderResolved>(DETAIL_CACHE_TTL_MS);
const tvmazeDetailCache = new TtlCache<ProviderResolved>(DETAIL_CACHE_TTL_MS);
const omdbDetailCache = new TtlCache<ProviderResolved>(DETAIL_CACHE_TTL_MS);
const imdbItemCache = new TtlCache<ImdbSuggestion>(DETAIL_CACHE_TTL_MS);
const imdbSearchCache = new TtlCache<ProviderCandidate[]>(SEARCH_CACHE_TTL_MS);

let tvdbToken: { fingerprint: string; value: string; expiresAt: number } | null = null;

/** Non-reversible fingerprint so a rotated key invalidates the cached token without keeping the key around. */
function keyFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `${(hash >>> 0).toString(36)}:${value.length}`;
}

/* ------------------------------------------------------------------ */
/* Keys / eligibility                                                  */
/* ------------------------------------------------------------------ */

/** Configured TVDB key from settings first, environment as fallback. */
export function tvdbApiKey(): string {
  const stored = settings.get('tvdbApiKey');
  return (typeof stored === 'string' && stored.trim()) || config.tvdbApiKey || '';
}

/** Configured OMDb key from settings first, environment as fallback. */
export function omdbApiKey(): string {
  const stored = settings.get('omdbApiKey');
  return (typeof stored === 'string' && stored.trim()) || config.omdbApiKey || '';
}

function keylessToggle(id: ProviderId): boolean {
  if (id === 'tvmaze') return settings.get('tvmazeEnabled') === true;
  if (id === 'imdb') return settings.get('imdbEnabled') === true;
  return true;
}

function providerConfigured(id: ProviderId): boolean {
  if (id === 'tmdb') return tmdbConfigured();
  if (id === 'tvdb') return tvdbApiKey().length > 0;
  if (id === 'omdb') return omdbApiKey().length > 0;
  // Keyless providers are structurally configured; their toggle decides eligibility.
  return true;
}

function providerAutoEnabled(id: ProviderId): boolean {
  if (!providerConfigured(id) || !keylessToggle(id)) return false;
  return settings.get('autoMatch') !== false;
}

function providerEligible(id: ProviderId, manual: boolean): boolean {
  if (!providerConfigured(id) || !keylessToggle(id)) return false;
  return manual || settings.get('autoMatch') !== false;
}

function providerSupports(id: ProviderId, kind: 'movie' | 'show'): boolean {
  return id !== 'tvmaze' || kind === 'show';
}

export function providerStatuses(): ProviderStatus[] {
  const autoMatch = settings.get('autoMatch') !== false;
  return [
    {
      id: 'tmdb',
      label: 'TMDB',
      configured: tmdbConfigured(),
      enabled: providerAutoEnabled('tmdb'),
      requiresKey: true,
      keyless: false,
      kinds: ['movie', 'show'],
      hosts: TMDB_HOSTS,
      note: tmdbConfigured()
        ? autoMatch
          ? 'Key configured; automatic matching enabled.'
          : 'Key configured; manual matching only (autoMatch is off).'
        : 'No TMDB key configured; set one in Admin → Settings to enable outbound lookups.',
    },
    {
      id: 'tvdb',
      label: 'TheTVDB',
      configured: tvdbApiKey().length > 0,
      enabled: providerAutoEnabled('tvdb'),
      requiresKey: true,
      keyless: false,
      kinds: ['movie', 'show'],
      hosts: TVDB_HOSTS,
      note: tvdbApiKey().length > 0
        ? autoMatch
          ? 'API key configured; automatic matching enabled.'
          : 'API key configured; manual matching only (autoMatch is off).'
        : 'No TheTVDB key configured; set one in Admin → Settings to enable outbound lookups.',
    },
    {
      id: 'tvmaze',
      label: 'TVmaze',
      configured: true,
      enabled: providerAutoEnabled('tvmaze'),
      requiresKey: false,
      keyless: true,
      kinds: ['show'],
      hosts: TVMAZE_HOSTS,
      note: keylessToggle('tvmaze')
        ? autoMatch
          ? 'Keyless shows provider enabled; automatic matching enabled.'
          : 'Keyless shows provider enabled; manual matching only (autoMatch is off).'
        : 'Keyless shows provider disabled; enable TVmaze in Admin → Settings to allow outbound requests.',
    },
    {
      id: 'omdb',
      label: 'OMDb',
      configured: omdbApiKey().length > 0,
      enabled: providerAutoEnabled('omdb'),
      requiresKey: true,
      keyless: false,
      kinds: ['movie', 'show'],
      hosts: OMDB_HOSTS,
      note: omdbApiKey().length > 0
        ? autoMatch
          ? 'API key configured; automatic matching enabled.'
          : 'API key configured; manual matching only (autoMatch is off).'
        : 'No OMDb key configured; set one in Admin → Settings to enable IMDb-backed lookups.',
    },
    {
      id: 'imdb',
      label: 'IMDb suggestions (unofficial)',
      configured: true,
      enabled: providerAutoEnabled('imdb'),
      requiresKey: false,
      keyless: true,
      kinds: ['movie', 'show'],
      hosts: IMDB_HOSTS,
      note: keylessToggle('imdb')
        ? autoMatch
          ? 'Keyless unofficial IMDb suggestions enabled; automatic matching enabled.'
          : 'Keyless unofficial IMDb suggestions enabled; manual matching only (autoMatch is off).'
        : 'Keyless unofficial IMDb suggestions disabled; enable IMDb in Admin → Settings to allow outbound requests.',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function asId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asText(value);
}

function asNumber(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
}

function yearFromDate(value: unknown): number | null {
  const text = asText(value);
  const match = text.match(/(19\d{2}|20\d{2})/);
  return match ? Number(match[1]) : null;
}

function providerYear(...values: unknown[]): number | null {
  for (const value of values) {
    const year = asNumber(value) ?? yearFromDate(value);
    if (year && year >= 1800 && year <= 2200) return Math.round(year);
  }
  return null;
}

/** Only https URLs on the provider's own image hosts are ever handed to art download. */
function safeImageUrl(value: unknown, hosts: Record<string, true>): string | null {
  const raw = asText(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !hosts[parsed.hostname]) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function stripHtml(value: unknown): string {
  const raw = asText(value);
  if (!raw) return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(20, Math.round(value as number)));
}

function ratingOf(value: unknown): number | null {
  const rating = asNumber(value);
  if (rating === null || rating < 0 || rating > 10) return null;
  return Math.round(rating * 10) / 10;
}

function namesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? asText(entry) : asText((entry as Record<string, unknown> | null)?.name);
    if (name) names.push(name.slice(0, 60));
  }
  return [...new Set(names)].slice(0, 20);
}

function peopleFromList(names: string[], role: string): PersonDTO[] {
  const people: PersonDTO[] = [];
  for (const raw of names) {
    const name = raw.trim().slice(0, 120);
    if (!name) continue;
    people.push({ name, role, character: null });
  }
  return people;
}

function splitNames(value: unknown): string[] {
  return asText(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.toLowerCase() !== 'n/a');
}

function makeCandidate(
  provider: ProviderId,
  kind: 'movie' | 'show',
  providerId: string,
  title: string,
  originalTitle: string | null,
  year: number | null,
  overview: string,
  rating: number | null,
  posterUrl: string | null,
  backdropUrl: string | null,
  popularity: number,
  wantedTitle: string,
  wantedYear: number | null,
): ProviderCandidate {
  return {
    provider,
    providerId,
    kind,
    title: title.slice(0, 300),
    originalTitle: originalTitle ? originalTitle.slice(0, 300) : null,
    year,
    overview: overview.slice(0, 5000),
    rating,
    posterUrl,
    backdropUrl,
    popularity,
    score: scoreCandidate(wantedTitle, wantedYear, title, year),
  };
}

function finalizeResolved(
  provider: ProviderId,
  kind: 'movie' | 'show',
  providerId: string,
  title: string,
  originalTitle: string | null,
  year: number | null,
  releaseDate: string | null,
  description: string,
  tagline: string | null,
  rating: number | null,
  contentRating: string | null,
  runtimeSeconds: number | null,
  genres: string[],
  tags: string[],
  people: PersonDTO[],
  posterUrl: string | null,
  backdropUrl: string | null,
  wantedTitle: string,
  wantedYear: number | null,
): ProviderResolved {
  return {
    provider,
    providerId,
    kind,
    title: title.slice(0, 300) || 'Untitled',
    originalTitle: originalTitle ? originalTitle.slice(0, 300) : null,
    year,
    releaseDate: releaseDate ? releaseDate.slice(0, 10) : null,
    description: description.slice(0, 5000),
    tagline: tagline ? tagline.slice(0, 300) : null,
    rating,
    contentRating: contentRating ? contentRating.slice(0, 20) : null,
    runtimeSeconds: runtimeSeconds !== null && runtimeSeconds > 0 ? Math.round(runtimeSeconds) : null,
    genres: [...new Set(genres.filter(Boolean))].slice(0, 20),
    tags: [...new Set(tags.filter(Boolean))].slice(0, 20),
    people: people.slice(0, 60),
    posterUrl,
    backdropUrl,
    matchScore: scoreCandidate(wantedTitle || title, wantedYear, title, year),
  };
}

/** Shared timeout + JSON fetch. Callers catch; URLs are never logged. */
async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`provider responded ${response.status}`);
  return response.json() as Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* Merged search / resolve                                             */
/* ------------------------------------------------------------------ */

async function searchOne(
  provider: ProviderId,
  kind: 'movie' | 'show',
  query: string,
  year: number | null,
  limit: number,
  manual: boolean,
): Promise<ProviderCandidate[]> {
  if (!providerSupports(provider, kind)) return [];
  try {
    if (provider === 'tmdb') return await searchTmdbCandidates(kind, query, year, limit, manual);
    if (provider === 'tvdb') return await searchTvdb(kind, query, year, limit);
    if (provider === 'tvmaze') return await searchTvmaze(query, year, limit);
    if (provider === 'omdb') return await searchOmdb(kind, query, year, limit);
    return await searchImdb(kind, query, year, limit);
  } catch (error) {
    logger.warn('providers', `${provider} search failed: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Merge every eligible provider, dedupe by provider+id, sort by score then
 * popularity, cap at the requested limit. Never throws and never calls the
 * network when no provider is configured/enabled.
 */
export async function searchProviders(
  kind: 'movie' | 'show',
  query: string,
  year: number | null,
  options: { limit?: number; manual?: boolean } = {},
): Promise<ProviderCandidate[]> {
  const wanted = asText(query).slice(0, 200);
  if (!wanted) return [];
  const limit = clampLimit(options.limit);
  const manual = options.manual === true;
  const eligible = PROVIDER_IDS.filter((id) => providerEligible(id, manual) && providerSupports(id, kind));
  if (eligible.length === 0) return [];
  const settled = await Promise.allSettled(eligible.map((id) => searchOne(id, kind, wanted, year, limit, manual)));
  const merged = new Map<string, ProviderCandidate>();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const candidate of result.value) {
      if (!candidate.providerId) continue;
      const key = `${candidate.provider}:${candidate.providerId}`;
      const existing = merged.get(key);
      if (!existing || candidate.score > existing.score) merged.set(key, candidate);
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.popularity - a.popularity || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Resolve one provider id into normalized metadata. Never throws. */
export async function resolveProvider(
  provider: ProviderId,
  kind: 'movie' | 'show',
  providerId: string,
  wantedTitle = '',
  wantedYear: number | null = null,
  options: { manual?: boolean } = {},
): Promise<ProviderResolved | null> {
  const id = asText(providerId).slice(0, 64);
  if (!id || !PROVIDER_IDS.includes(provider) || !providerSupports(provider, kind)) return null;
  const manual = options.manual === true;
  if (!(manual ? providerEligible(provider, true) : providerAutoEnabled(provider))) return null;
  try {
    if (provider === 'tmdb') return await resolveTmdb(kind, id, wantedTitle, wantedYear, manual);
    if (provider === 'tvdb') return await resolveTvdb(kind, id, wantedTitle, wantedYear);
    if (provider === 'tvmaze') return await resolveTvmaze(id, wantedTitle, wantedYear);
    if (provider === 'omdb') return await resolveOmdb(kind, id, wantedTitle, wantedYear);
    return await resolveImdb(kind, id, wantedTitle, wantedYear);
  } catch (error) {
    logger.warn('providers', `${provider} details failed: ${(error as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* TMDB (wraps the existing opt-in client)                             */
/* ------------------------------------------------------------------ */

async function searchTmdbCandidates(kind: MatchKind, query: string, year: number | null, limit: number, manual: boolean): Promise<ProviderCandidate[]> {
  const results = await searchTmdb(kind, query, year, limit, manual);
  return results.map((candidate) => ({
    provider: 'tmdb',
    providerId: candidate.providerId,
    kind: candidate.kind,
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    overview: candidate.overview,
    rating: candidate.rating,
    posterUrl: candidate.posterUrl,
    backdropUrl: candidate.backdropUrl,
    popularity: candidate.popularity,
    score: candidate.score,
  }));
}

async function resolveTmdb(kind: MatchKind, providerId: string, wantedTitle: string, wantedYear: number | null, manual: boolean): Promise<ProviderResolved | null> {
  const resolved: ResolvedMetadata | null = await tmdbDetails(kind, providerId, wantedTitle, wantedYear, manual);
  return resolved ? { ...resolved } : null;
}

/* ------------------------------------------------------------------ */
/* TheTVDB v4 (key required; token cached, never logged)               */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tvdbProviderId(entry: Record<string, unknown>): string {
  const raw = asId(entry.tvdb_id) || asId(entry.id) || asId(entry.objectID);
  return raw.replace(/^(movie|series)-/i, '').slice(0, 64);
}

async function tvdbTokenValue(): Promise<string | null> {
  const key = tvdbApiKey();
  if (!key) return null;
  const fingerprint = keyFingerprint(key);
  if (tvdbToken && tvdbToken.fingerprint === fingerprint && tvdbToken.expiresAt > Date.now()) return tvdbToken.value;
  const payload = await fetchJson('https://api4.thetvdb.com/v4/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ apikey: key }),
  });
  const token = asText(asRecord(asRecord(payload)?.data)?.token);
  if (!token) return null;
  // TVDB tokens live for a month; refreshing every 6h is cheap and safe.
  tvdbToken = { fingerprint, value: token, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return token;
}

async function tvdbGet(pathname: string, params: Record<string, string>): Promise<unknown> {
  const token = await tvdbTokenValue();
  if (!token) throw new Error('TVDB key not configured');
  const url = new URL(`https://api4.thetvdb.com/v4${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetchJson(url.toString(), { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
}

function tvdbReleaseDate(data: Record<string, unknown>): string {
  const direct = asText(data.released) || asText(data.firstAired);
  if (direct) return direct;
  const firstRelease = asText(asRecord(data.first_release)?.date);
  if (firstRelease) return firstRelease;
  if (Array.isArray(data.releases)) {
    for (const raw of data.releases) {
      const date = asText(asRecord(raw)?.date);
      if (date) return date;
    }
  }
  return '';
}

function tvdbContentRating(data: Record<string, unknown>): string | null {
  if (!Array.isArray(data.contentRatings)) return null;
  for (const raw of data.contentRatings) {
    const name = asText(asRecord(raw)?.name);
    if (name && name.toLowerCase() !== 'n/a') return name;
  }
  return null;
}

/** TVDB artwork type 3 is "background"; only artworks.thetvdb.com URLs are accepted. */
function tvdbBackdrop(data: Record<string, unknown>): string | null {
  if (!Array.isArray(data.artworks)) return null;
  for (const raw of data.artworks) {
    const artwork = asRecord(raw);
    if (asNumber(artwork?.type) !== 3) continue;
    const url = safeImageUrl(artwork?.image, TVDB_ART_HOSTS);
    if (url) return url;
  }
  return null;
}

async function searchTvdb(kind: 'movie' | 'show', query: string, year: number | null, limit: number): Promise<ProviderCandidate[]> {
  const payload = await tvdbGet('/search', {
    query,
    type: kind === 'movie' ? 'movie' : 'series',
    ...(year ? { year: String(year) } : {}),
  });
  const entries = asRecord(payload)?.data;
  if (!Array.isArray(entries)) return [];
  const candidates: ProviderCandidate[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const type = asText(entry.type).toLowerCase();
    if (type && kind === 'movie' && type !== 'movie') continue;
    if (type && kind === 'show' && !type.includes('series')) continue;
    const providerId = tvdbProviderId(entry);
    const title = asText(entry.name) || asText(entry.title);
    if (!providerId || !title) continue;
    const candidateYear = providerYear(entry.year, entry.first_air_time, entry.firstAired);
    candidates.push(
      makeCandidate(
        'tvdb',
        kind,
        providerId,
        title,
        asText(entry.originalName) || null,
        candidateYear,
        stripHtml(entry.overview),
        ratingOf(entry.score ?? entry.rating),
        safeImageUrl(entry.image_url ?? entry.image ?? entry.thumbnail, TVDB_ART_HOSTS),
        null,
        0,
        query,
        year,
      ),
    );
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function resolveTvdb(kind: 'movie' | 'show', providerId: string, wantedTitle: string, wantedYear: number | null): Promise<ProviderResolved | null> {
  const cacheKey = `${kind}:${providerId}`;
  const cached = tvdbDetailCache.get(cacheKey);
  if (cached) return cached;
  const payload = await tvdbGet(kind === 'movie' ? `/movies/${encodeURIComponent(providerId)}/extended` : `/series/${encodeURIComponent(providerId)}/extended`, {});
  const data = asRecord(asRecord(payload)?.data);
  if (!data) return null;
  const title = asText(data.name) || wantedTitle || 'Untitled';
  const date = tvdbReleaseDate(data);
  const runtimeMinutes = asNumber(data.runtime) ?? asNumber(data.averageRuntime);
  const resolved = finalizeResolved(
    'tvdb',
    kind,
    providerId,
    title,
    asText(data.originalName) || null,
    providerYear(data.year, date) ?? wantedYear,
    date || null,
    stripHtml(data.overview) || stripHtml((Array.isArray(data.overviewTranslations) ? data.overviewTranslations : [])[0]),
    null,
    ratingOf(data.score ?? data.rating),
    tvdbContentRating(data),
    runtimeMinutes !== null ? runtimeMinutes * 60 : null,
    namesFrom(data.genres),
    namesFrom(data.tagOptions ?? data.tags),
    [],
    safeImageUrl(data.image, TVDB_ART_HOSTS),
    tvdbBackdrop(data),
    wantedTitle,
    wantedYear,
  );
  tvdbDetailCache.set(cacheKey, resolved);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* OMDb (IMDb data through omdbapi.com; key required)                  */
/* ------------------------------------------------------------------ */

async function searchOmdb(kind: 'movie' | 'show', query: string, year: number | null, limit: number): Promise<ProviderCandidate[]> {
  const key = omdbApiKey();
  if (!key) return [];
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', key);
  url.searchParams.set('s', query);
  url.searchParams.set('type', kind === 'movie' ? 'movie' : 'series');
  if (year) url.searchParams.set('y', String(year));
  const payload = asRecord(await fetchJson(url.toString()));
  if (!payload || asText(payload.Response).toLowerCase() !== 'true') return [];
  const results = payload.Search;
  if (!Array.isArray(results)) return [];
  const candidates: ProviderCandidate[] = [];
  for (const raw of results) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const providerId = asId(entry.imdbID);
    const title = asText(entry.Title);
    if (!providerId.startsWith('tt') || !title) continue;
    candidates.push(
      makeCandidate(
        'omdb',
        kind,
        providerId,
        title,
        null,
        providerYear(entry.Year),
        '',
        null,
        safeImageUrl(entry.Poster, AMAZON_ART_HOSTS),
        null,
        0,
        query,
        year,
      ),
    );
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

function runtimeSecondsFromMinutes(value: unknown): number | null {
  const match = asText(value).match(/(\d+)\s*min/i);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}

function releaseDateIso(value: unknown): string | null {
  const text = asText(value);
  if (!text || text.toLowerCase() === 'n/a') return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

async function resolveOmdb(kind: 'movie' | 'show', providerId: string, wantedTitle: string, wantedYear: number | null): Promise<ProviderResolved | null> {
  const cacheKey = providerId;
  const cached = omdbDetailCache.get(cacheKey);
  if (cached) return cached;
  const key = omdbApiKey();
  if (!key) return null;
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', key);
  url.searchParams.set('i', providerId);
  url.searchParams.set('plot', 'full');
  const payload = asRecord(await fetchJson(url.toString()));
  if (!payload || asText(payload.Response).toLowerCase() !== 'true') return null;
  const title = asText(payload.Title) || wantedTitle || 'Untitled';
  const people: PersonDTO[] = [
    ...peopleFromList(splitNames(payload.Director), 'director'),
    ...peopleFromList(splitNames(payload.Writer), 'writer'),
    ...peopleFromList(splitNames(payload.Actors), 'cast'),
  ];
  const rated = asText(payload.Rated);
  const resolved = finalizeResolved(
    'omdb',
    kind,
    providerId,
    title,
    title,
    providerYear(payload.Year) ?? wantedYear,
    releaseDateIso(payload.Released),
    stripHtml(payload.Plot),
    null,
    ratingOf(payload.imdbRating),
    rated && rated.toLowerCase() !== 'n/a' ? rated : null,
    runtimeSecondsFromMinutes(payload.Runtime),
    splitNames(payload.Genre),
    [],
    people,
    safeImageUrl(payload.Poster, AMAZON_ART_HOSTS),
    null,
    wantedTitle,
    wantedYear,
  );
  omdbDetailCache.set(cacheKey, resolved);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* TVmaze (keyless; shows only, toggle-gated)                          */
/* ------------------------------------------------------------------ */

async function searchTvmaze(query: string, year: number | null, limit: number): Promise<ProviderCandidate[]> {
  const url = new URL('https://api.tvmaze.com/search/shows');
  url.searchParams.set('q', query);
  const payload = await fetchJson(url.toString());
  if (!Array.isArray(payload)) return [];
  const candidates: ProviderCandidate[] = [];
  for (const raw of payload) {
    const wrapper = asRecord(raw);
    const show = asRecord(wrapper?.show);
    if (!show) continue;
    const providerId = asId(show.id);
    const title = asText(show.name);
    if (!providerId || !title) continue;
    const image = asRecord(show.image);
    candidates.push(
      makeCandidate(
        'tvmaze',
        'show',
        providerId,
        title,
        null,
        yearFromDate(show.premiered),
        stripHtml(show.summary),
        ratingOf(asRecord(show.rating)?.average),
        safeImageUrl(image?.original ?? image?.medium, TVMAZE_ART_HOSTS),
        null,
        asNumber(show.weight) ?? asNumber(wrapper?.score) ?? 0,
        query,
        year,
      ),
    );
  }
  return candidates.sort((a, b) => b.score - a.score || b.popularity - a.popularity).slice(0, limit);
}

function tvmazePeople(show: Record<string, unknown>): PersonDTO[] {
  const cast = asRecord(show._embedded)?.cast;
  if (!Array.isArray(cast)) return [];
  const people: PersonDTO[] = [];
  for (const raw of cast.slice(0, 30)) {
    const entry = asRecord(raw);
    const name = asText(asRecord(entry?.person)?.name);
    if (!name) continue;
    const character = asText(asRecord(entry?.character)?.name);
    people.push({ name: name.slice(0, 120), role: 'cast', character: character ? character.slice(0, 200) : null });
  }
  return people;
}

async function resolveTvmaze(providerId: string, wantedTitle: string, wantedYear: number | null): Promise<ProviderResolved | null> {
  const cached = tvmazeDetailCache.get(providerId);
  if (cached) return cached;
  const url = new URL(`https://api.tvmaze.com/shows/${encodeURIComponent(providerId)}`);
  url.searchParams.set('embed', 'cast');
  const show = asRecord(await fetchJson(url.toString()));
  if (!show) return null;
  const title = asText(show.name) || wantedTitle || 'Untitled';
  const runtimeMinutes = asNumber(show.averageRuntime) ?? asNumber(show.runtime);
  const image = asRecord(show.image);
  const resolved = finalizeResolved(
    'tvmaze',
    'show',
    providerId,
    title,
    title,
    yearFromDate(show.premiered) ?? wantedYear,
    asText(show.premiered) || null,
    stripHtml(show.summary),
    null,
    ratingOf(asRecord(show.rating)?.average),
    null,
    runtimeMinutes !== null ? runtimeMinutes * 60 : null,
    namesFrom(show.genres),
    [],
    tvmazePeople(show),
    safeImageUrl(image?.original ?? image?.medium, TVMAZE_ART_HOSTS),
    null,
    wantedTitle,
    wantedYear,
  );
  tvmazeDetailCache.set(providerId, resolved);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* IMDb suggestions (keyless/unofficial, toggle-gated)                 */
/* ------------------------------------------------------------------ */

interface ImdbSuggestion {
  id: string;
  title: string;
  year: number | null;
  kind: 'movie' | 'show';
  posterUrl: string | null;
  rank: number;
  actors: string[];
}

function imdbSuggestionUrl(query: string): string {
  const normalized = query.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
  const first = normalized.charAt(0).toLowerCase() || 'a';
  return `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(first)}/${encodeURIComponent(query)}.json`;
}

function imdbKindOf(entry: Record<string, unknown>): 'movie' | 'show' | null {
  const qid = asText(entry.qid).toLowerCase();
  const label = asText(entry.q).toLowerCase();
  if (qid === 'movie' || qid === 'tvmovie' || qid === 'short' || qid === 'video') return 'movie';
  if (qid === 'tvseries' || qid === 'tvminiseries' || qid === 'tvspecial' || qid === 'tvshort') return 'show';
  if (label.includes('series')) return 'show';
  if (label === 'feature' || label === 'short' || label === 'video') return 'movie';
  return null;
}

function imdbSuggestionFrom(entry: Record<string, unknown>): ImdbSuggestion | null {
  const id = asId(entry.id);
  const kind = imdbKindOf(entry);
  const title = asText(entry.l);
  if (!/^tt\d+$/.test(id) || !kind || !title) return null;
  const image = asRecord(entry.i);
  return {
    id,
    title,
    year: providerYear(entry.y, entry.tl, entry.yr),
    kind,
    posterUrl: safeImageUrl(image?.imageUrl, AMAZON_ART_HOSTS),
    rank: asNumber(entry.rank) ?? 0,
    actors: splitNames(entry.s),
  };
}

async function imdbEntries(query: string): Promise<ImdbSuggestion[]> {
  const payload = asRecord(await fetchJson(imdbSuggestionUrl(query)));
  const items = payload?.d;
  if (!Array.isArray(items)) return [];
  const suggestions: ImdbSuggestion[] = [];
  for (const raw of items) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const suggestion = imdbSuggestionFrom(entry);
    if (!suggestion) continue;
    imdbItemCache.set(suggestion.id, suggestion);
    suggestions.push(suggestion);
  }
  return suggestions;
}

async function searchImdb(kind: 'movie' | 'show', query: string, year: number | null, limit: number): Promise<ProviderCandidate[]> {
  const cacheKey = `${kind}:${query.toLowerCase()}:${year ?? ''}`;
  const cached = imdbSearchCache.get(cacheKey);
  if (cached) return cached;
  const suggestions = (await imdbEntries(query)).filter((entry) => entry.kind === kind);
  const candidates = suggestions
    .map((entry) =>
      makeCandidate(
        'imdb',
        kind,
        entry.id,
        entry.title,
        null,
        entry.year,
        '',
        null,
        entry.posterUrl,
        null,
        entry.rank > 0 ? Math.round(1_000_000 / entry.rank) : 0,
        query,
        year,
      ),
    )
    .sort((a, b) => b.score - a.score || b.popularity - a.popularity)
    .slice(0, limit);
  imdbSearchCache.set(cacheKey, candidates);
  if (candidates.length > 0) return candidates;
  return [];
}

async function resolveImdb(kind: 'movie' | 'show', providerId: string, wantedTitle: string, wantedYear: number | null): Promise<ProviderResolved | null> {
  let suggestion = imdbItemCache.get(providerId) ?? null;
  if (!suggestion) {
    const byId = await imdbEntries(providerId);
    suggestion = byId.find((entry) => entry.id === providerId) ?? null;
  }
  if (!suggestion && wantedTitle) {
    const byTitle = await imdbEntries(wantedTitle);
    suggestion = byTitle.find((entry) => entry.id === providerId) ?? null;
  }
  if (!suggestion) return null;
  const resolvedKind = suggestion.kind === 'show' && kind === 'show' ? 'show' : kind;
  const resolved = finalizeResolved(
    'imdb',
    resolvedKind,
    providerId,
    suggestion.title,
    suggestion.title,
    suggestion.year ?? wantedYear,
    null,
    '',
    null,
    null,
    null,
    null,
    [],
    [],
    peopleFromList(suggestion.actors, 'cast'),
    suggestion.posterUrl,
    null,
    wantedTitle,
    wantedYear,
  );
  return resolved;
}

