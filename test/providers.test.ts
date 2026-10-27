import { after, before, test } from 'node:test';
import path from 'node:path';
import { adminClient, assert, createLibrary, makeVideo, newUserClient, scanLibrary, startServer } from './helpers.ts';
import type { Client, StartedServer } from './helpers.ts';

interface ProviderStatusBody {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  requiresKey: boolean;
  keyless: boolean;
  kinds: string[];
  hosts: string[];
  note: string;
}

interface CandidateBody {
  provider: string;
  providerId: string;
  kind: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  score: number;
}

interface MatchesBody {
  ok: boolean;
  targetId: number;
  kind: string;
  query: string;
  providers: ProviderStatusBody[];
  candidates: CandidateBody[];
}

interface MatchBody {
  ok: boolean;
  matched: boolean;
  provider?: string;
  reason?: string;
  candidates?: CandidateBody[];
  item?: { id: number; title: string; metadataProvider?: string | null };
}

interface PrivacyBody {
  zeroOutbound: boolean;
  outboundEndpoints: { host: string; providers?: string[]; modes: string[] }[];
  providers: (ProviderStatusBody & { keySource: string; toggle: boolean })[];
  tmdb: { configured: boolean; source: string; autoMatch: boolean };
}

interface MediaItem {
  id: number;
  kind: string;
  title: string;
}

interface PagedItems<T> {
  items: T[];
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let regular: Client;
let movieId: number;

const live = async (): Promise<boolean> => {
  try {
    const [tvmaze, imdb] = await Promise.all([
      fetch('https://api.tvmaze.com/search/shows?q=Breaking%20Bad', { signal: AbortSignal.timeout(5000) }),
      fetch('https://v2.sg.media-imdb.com/suggestion/o/oppenheimer.json', { signal: AbortSignal.timeout(5000) }),
    ]);
    return tvmaze.ok && imdb.ok;
  } catch {
    return false;
  }
};

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'provider_manager', 'manager');
  regular = await newUserClient(server, admin, 'provider_regular', 'user');
  const libraryDir = path.join(server.mediaDir, 'providers');
  makeVideo(path.join(libraryDir, 'Oppenheimer (2023).mp4'));
  const library = await createLibrary(admin, { name: 'Provider Movies', kind: 'movies', path: libraryDir });
  await scanLibrary(admin, library.id);
  const items = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${library.id}/items`);
  const movie = items.json?.items.find((item) => item.kind === 'movie');
  assert.ok(movie, 'provider fixture movie was not indexed');
  movieId = movie.id;
});

after(async () => {
  await server?.stop();
});

test('provider registry is truthful and the default footprint is zero outbound', async () => {
  const privacy = await admin.get<PrivacyBody>('/api/admin/privacy');
  assert.equal(privacy.status, 200);
  assert.equal(privacy.json?.zeroOutbound, true);
  assert.deepEqual(privacy.json?.outboundEndpoints, []);
  assert.equal(privacy.json?.providers.length, 5);
  for (const provider of privacy.json!.providers) assert.equal(provider.enabled, false, `${provider.id} must be off by default`);
  const tmdb = privacy.json!.providers.find((provider) => provider.id === 'tmdb')!;
  assert.equal(tmdb.configured, false);
  assert.deepEqual(tmdb.hosts, ['api.themoviedb.org', 'image.tmdb.org']);
  const tvmaze = privacy.json!.providers.find((provider) => provider.id === 'tvmaze')!;
  assert.equal(tvmaze.keyless, true);
  assert.equal(tvmaze.configured, true);
  assert.deepEqual(tvmaze.kinds, ['show']);
  const imdb = privacy.json!.providers.find((provider) => provider.id === 'imdb')!;
  assert.equal(imdb.keyless, true);
  assert.deepEqual(imdb.hosts, ['v2.sg.media-imdb.com', 'm.media-amazon.com']);

  const matches = await manager.get<MatchesBody>(`/api/media/${movieId}/matches?query=Oppenheimer`);
  assert.equal(matches.status, 200);
  assert.deepEqual(matches.json?.candidates, [], 'disabled providers must not search or return candidates');
  assert.equal(matches.json?.providers.length, 5);
  assert.equal(matches.json?.kind, 'movie');
  assert.equal((await regular.get(`/api/media/${movieId}/matches?query=Oppenheimer`)).status, 403);
  assert.equal((await manager.get(`/api/media/${movieId}/matches?kind=music`)).status, 400);
});

test('keyless toggles enable manual provider search and show up in the privacy audit', async () => {
  const patched = await admin.patch('/api/admin/settings', { tvmazeEnabled: true, imdbEnabled: true });
  assert.equal(patched.status, 200);
  const online = await live();
  const privacy = await admin.get<PrivacyBody>('/api/admin/privacy');
  assert.equal(privacy.json?.zeroOutbound, false);
  const hosts = privacy.json!.outboundEndpoints.map((endpoint) => endpoint.host);
  assert.ok(hosts.includes('v2.sg.media-imdb.com'));
  assert.ok(hosts.includes('api.tvmaze.com'));
  assert.ok(hosts.includes('static.tvmaze.com'));
  assert.ok(hosts.includes('m.media-amazon.com'));
  assert.equal(hosts.filter((host) => host === 'm.media-amazon.com').length, 1, 'shared art host must be deduped');
  const imdb = privacy.json!.providers.find((provider) => provider.id === 'imdb')!;
  assert.equal(imdb.toggle, true);
  assert.equal(imdb.enabled, true);
  assert.equal(imdb.keySource, 'none');

  const movieMatches = await manager.get<MatchesBody>(`/api/media/${movieId}/matches?query=Oppenheimer`);
  assert.equal(movieMatches.status, 200);
  const imdbStatus = movieMatches.json!.providers.find((provider) => provider.id === 'imdb')!;
  assert.equal(imdbStatus.enabled, true);
  if (!online) {
    assert.deepEqual(movieMatches.json?.candidates, [], 'offline: no candidates expected');
    return;
  }
  const imdbCandidate = movieMatches.json!.candidates.find((candidate) => candidate.provider === 'imdb');
  assert.ok(imdbCandidate, `expected an IMDb candidate, got ${JSON.stringify(movieMatches.json?.candidates)}`);
  assert.equal(imdbCandidate.kind, 'movie');
  assert.match(imdbCandidate.providerId, /^tt\d+$/);
  assert.equal(imdbCandidate.title, 'Oppenheimer');
  assert.equal(imdbCandidate.year, 2023);
  assert.match(imdbCandidate.posterUrl ?? '', /^https:\/\/m\.media-amazon\.com\//);

  const showMatches = await manager.get<MatchesBody>(`/api/media/${movieId}/matches?query=Breaking%20Bad&kind=show&year=2008`);
  assert.equal(showMatches.status, 200);
  assert.equal(showMatches.json?.kind, 'show');
  const tvmazeCandidate = showMatches.json!.candidates.find((candidate) => candidate.provider === 'tvmaze');
  assert.ok(tvmazeCandidate, `expected a TVmaze candidate, got ${JSON.stringify(showMatches.json?.candidates)}`);
  assert.equal(tvmazeCandidate.title, 'Breaking Bad');
  assert.equal(tvmazeCandidate.year, 2008);
  assert.match(tvmazeCandidate.posterUrl ?? '', /^https:\/\/static\.tvmaze\.com\//);
});

test('scanner auto-matches new movies through enabled providers', async () => {
  const online = await live();
  const libraryDir = path.join(server.mediaDir, 'provider-autoscan');
  makeVideo(path.join(libraryDir, 'Oppenheimer (2023).mp4'));
  const library = await createLibrary(admin, { name: 'Provider Autoscan', kind: 'movies', path: libraryDir });
  await scanLibrary(admin, library.id);
  const items = await admin.get<PagedItems<MediaItem & { metadataProvider: string | null; matchScore: number | null }>>(`/api/libraries/${library.id}/items`);
  const movie = items.json?.items.find((item) => item.kind === 'movie');
  assert.ok(movie, 'autoscan fixture movie was not indexed');
  assert.equal(movie.title, 'Oppenheimer');
  if (!online) {
    assert.equal(movie.metadataProvider ?? null, null, 'offline: local parse only');
    return;
  }
  assert.equal(movie.metadataProvider, 'imdb');
  assert.ok((movie.matchScore ?? 0) >= 0.55, `expected a confident provider match, got ${movie.matchScore}`);
});

test('provider match resolves details while legacy TMDB paths degrade gracefully', async () => {
  const online = await live();
  if (online) {
    const matched = await manager.post<MatchBody>(`/api/media/${movieId}/match`, { provider: 'imdb', providerId: 'tt15398776' });
    assert.equal(matched.status, 200, matched.text);
    assert.equal(matched.json?.matched, true);
    assert.equal(matched.json?.provider, 'imdb');
    assert.equal(matched.json?.item?.metadataProvider, 'imdb');
    assert.equal(matched.json?.item?.title, 'Oppenheimer');
  }

  const invalid = await manager.post(`/api/media/${movieId}/match`, { provider: 'nope', providerId: '1' });
  assert.equal(invalid.status, 400);
  const keylessTvdb = await manager.post<MatchBody>(`/api/media/${movieId}/match`, { provider: 'tvdb', providerId: '123' });
  assert.equal(keylessTvdb.status, 200);
  assert.equal(keylessTvdb.json?.matched, false);
  assert.equal(keylessTvdb.json?.reason, 'no_match');

  const legacyWithoutKey = await manager.post<MatchBody>(`/api/media/${movieId}/match`, {});
  assert.equal(legacyWithoutKey.status, 200);
  assert.equal(legacyWithoutKey.json?.reason, 'tmdb_not_configured');

  const fakeKey = await admin.patch('/api/admin/settings', { tmdbApiKey: 'fakekey1234' });
  assert.equal(fakeKey.status, 200);
  assert.equal((await admin.get<PrivacyBody>('/api/admin/privacy')).json?.zeroOutbound, false);
  const rejected = await manager.post<MatchBody>(`/api/media/${movieId}/match`, { id: '550' });
  assert.equal(rejected.status, 200, 'a rejected provider key must not 500');
  assert.equal(rejected.json?.ok, false);
  assert.equal(rejected.json?.reason, 'no_match');
  assert.equal(rejected.json?.provider, 'tmdb');
  assert.equal((await manager.post(`/api/media/${movieId}/match`, { tmdbId: 'not-numeric' })).status, 400);
  assert.equal((await admin.patch('/api/admin/settings', { tmdbApiKey: '', tvmazeEnabled: false, imdbEnabled: false })).status, 200);
  assert.equal((await admin.get<PrivacyBody>('/api/admin/privacy')).json?.zeroOutbound, true);
});

test('new ingest/provider settings validate and never leak keys in broadcasts', async () => {
  const invalid: Record<string, unknown>[] = [
    { tvdbApiKey: 'short' },
    { omdbApiKey: 'bad key!!!' },
    { tvdbApiKey: 42 },
    { tvmazeEnabled: 'yes' },
    { imdbEnabled: 1 },
    { ingestWatch: 'on' },
    { ingestIntervalSeconds: 4 },
    { ingestIntervalSeconds: 3601 },
    { ingestIntervalSeconds: 30.5 },
  ];
  for (const body of invalid) {
    const response = await admin.patch('/api/admin/settings', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
  }
  const valid = await admin.patch<{ changed: string[]; settings: Record<string, unknown> }>('/api/admin/settings', {
    tvdbApiKey: 'tvdb-key-1234',
    omdbApiKey: 'omdb-key-1234',
    tvmazeEnabled: true,
    imdbEnabled: true,
    ingestWatch: false,
    ingestIntervalSeconds: 45,
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.json?.changed, ['tvdbApiKey', 'omdbApiKey', 'tvmazeEnabled', 'imdbEnabled', 'ingestWatch', 'ingestIntervalSeconds']);
  assert.equal(valid.json?.settings.tvdbApiKey, 'tvdb-key-1234');
  assert.equal(valid.json?.settings.ingestIntervalSeconds, 45);
  const privacy = await admin.get<PrivacyBody>('/api/admin/privacy');
  assert.equal(privacy.json?.providers.find((provider) => provider.id === 'tvdb')?.configured, true);
  assert.equal(privacy.json?.providers.find((provider) => provider.id === 'omdb')?.configured, true);
  assert.equal(privacy.json?.tmdb.source, 'none');
  const exported = await admin.get<{ settings: Record<string, unknown>; secretsRedacted: string[] }>('/api/admin/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.json?.settings.tvdbApiKey, '');
  assert.equal(exported.json?.settings.omdbApiKey, '');
  assert.deepEqual(exported.json?.secretsRedacted, ['tmdbApiKey', 'tvdbApiKey', 'omdbApiKey']);
  assert.equal((await admin.patch('/api/admin/settings', { tvdbApiKey: '', omdbApiKey: '', tvmazeEnabled: false, imdbEnabled: false })).status, 200);
});
