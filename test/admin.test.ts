import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  USER_PASSWORD,
  adminClient,
  assert,
  Client,
  createLibrary,
  makeVideo,
  newUserClient,
  scanLibrary,
  startServer,
  writeNfo,
} from './helpers.ts';
import type { Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MediaItem {
  id: number;
  kind: string;
  title: string;
  sizeBytes: number | null;
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface SettingsBody {
  serverName: string;
  tagline: string;
  accent: string;
  allowSignups: boolean;
  requireInvite: boolean;
  tmdbApiKey: string;
  transcodeEnabled: boolean;
  subtitleBurnIn: boolean;
  maxTranscodeHeight: number;
  transcodePreset: string;
  scanOnStart: boolean;
  autoMatch: boolean;
  generateArt: boolean;
  allowRequests: boolean;
  allowParties: boolean;
  maintenanceMode: boolean;
  memes: boolean;
  telemetry: boolean;
}

interface OverviewBody {
  generatedAt: string;
  server: { name: string; version: string; env: string; startedAt: string; pid: number; platform: string; host: string; port: number };
  database: { path: string; pageSize: number; pageCount: number; totalBytes: number; walBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number };
  memory: { rssBytes: number; heapUsedBytes: number; systemTotalBytes: number };
  counts: {
    users: number;
    admins: number;
    libraries: number;
    media: number;
    hiddenMedia: number;
    art: number;
    subtitles: number;
    collections: number;
    playlists: number;
    requests: number;
    openReports: number;
    sessions: number;
    invitesActive: number;
    mediaByKind: Record<string, number>;
  };
  streams: { active: number; items: unknown[] };
  logs: { total: number; byLevel: Record<string, number>; recent: unknown[] };
  jobs: { counts: Record<string, number>; active: unknown[]; recent: unknown[] };
  storage: {
    mediaBytes: number;
    mediaItems: number;
    libraries: { id: number; name: string; items: number; bytes: number; exists: boolean }[];
    cache: { root: string; totalBytes: number; totalFiles: number };
    db: { bytes: number; path: string };
    art: { count: number; bytes: number };
    disk: { freeBytes: number };
  };
  topMedia: { largest: { item: MediaItem; bytes: number }[]; mostPlayed: { item: MediaItem; plays: number; seconds: number }[] };
  watch: {
    totalSeconds: number;
    totalPlays: number;
    watchers: number;
    finishedCount: number;
    last24hSeconds: number;
    topGenres: { genre: string; seconds: number; plays: number; items: number }[];
    recent: { userId: number; username: string; mediaId: number; title: string; positionSeconds: number }[];
  };
  settingsSummary: Record<string, unknown>;
}

interface UserRow {
  id: number;
  username: string;
  displayName: string;
  role: string;
  disabled: boolean;
  hasPin: boolean;
  activeSessions: number;
  avatarHue: number;
  preferences: Record<string, unknown>;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UsersPage extends PagedItems<UserRow> {
  byRole: Record<string, number>;
}

interface Invite {
  id: string;
  code: string;
  role: string;
  valid: boolean;
  expired: boolean;
  expiresAt: string | null;
  usedBy: { username: string } | null;
  createdBy: { username: string } | null;
  createdAt: string;
}

interface LogEntry {
  id: number;
  level: string;
  scope: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface LogsPage extends PagedItems<LogEntry> {
  byLevel: Record<string, number>;
  scopes: string[];
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let user: Client;
let other: Client;
let moviesLibrary: Library;
let movieId: number;
let movieBytes: number;
let adminId: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'admin_manager', 'manager');
  user = await newUserClient(server, admin, 'admin_user', 'user');
  other = await newUserClient(server, admin, 'admin_other', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  const dir = path.join(moviesRoot, 'Admin Movie (2020)');
  const video = makeVideo(path.join(dir, 'Admin Movie (2020).mp4'));
  movieBytes = fs.statSync(video).size;
  writeNfo(path.join(dir, 'movie.nfo'), 'movie', { title: 'Admin Movie', year: 2020, plot: 'Admin plot.', rating: 8, genres: ['Drama'] });
  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  await scanLibrary(admin, moviesLibrary.id);

  const items = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  movieId = items.json!.items[0].id;
  await user.put(`/api/progress/${movieId}`, { positionSeconds: 30, durationSeconds: 120 });
  const me = await admin.get<{ user: { id: number } }>('/api/auth/me');
  adminId = me.json!.user.id;
});

after(async () => {
  await server.stop();
});

test('admin overview aggregates server, storage, jobs, and watch data', async () => {
  assert.equal((await user.get('/api/admin/overview')).status, 403);
  assert.equal((await manager.get('/api/admin/overview')).status, 403);
  assert.equal((await new Client(server.baseUrl, 'anon-admin').get('/api/admin/overview')).status, 401);

  const response = await admin.get<OverviewBody>('/api/admin/overview');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const overview = response.json!;
  assert.match(overview.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(overview.server.name, 'AISlopMediaBox');
  assert.equal(overview.server.version, '1.0.0');
  assert.equal(overview.server.env, 'test');
  assert.match(overview.server.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(overview.server.pid > 0);
  assert.equal(overview.server.host, '127.0.0.1');
  assert.equal(overview.server.port, server.port);
  assert.ok(overview.server.platform.length > 0);

  assert.ok(overview.database.pageSize >= 512);
  assert.ok(overview.database.pageCount > 0);
  assert.ok(overview.database.totalBytes > 0);
  assert.equal(overview.database.path, path.join(server.dataDir, 'aislop.db'));
  assert.equal(overview.disk.path, server.dataDir);
  assert.ok(overview.disk.freeBytes > 0);
  assert.ok(overview.disk.totalBytes >= overview.disk.freeBytes);
  assert.ok(overview.memory.rssBytes > 0);
  assert.ok(overview.memory.heapUsedBytes > 0);

  assert.equal(overview.counts.users, 4);
  assert.equal(overview.counts.admins, 1);
  assert.equal(overview.counts.libraries, 1);
  assert.equal(overview.counts.media, 1);
  assert.equal(overview.counts.hiddenMedia, 0);
  assert.ok(overview.counts.art >= 1);
  assert.equal(overview.counts.collections, 0);
  assert.equal(overview.counts.playlists, 0);
  assert.equal(overview.counts.requests, 0);
  assert.equal(overview.counts.openReports, 0);
  assert.ok(overview.counts.sessions >= 4);
  assert.equal(overview.counts.invitesActive, 0);
  assert.deepEqual(overview.counts.mediaByKind, { movie: 1 });

  assert.equal(overview.streams.active, 0);
  assert.deepEqual(overview.streams.items, []);
  assert.ok(overview.logs.total >= 0);
  for (const level of ['debug', 'info', 'warn', 'error']) assert.ok(typeof overview.logs.byLevel[level] === 'number');
  assert.ok(Array.isArray(overview.logs.recent));
  for (const key of ['queued', 'running', 'done', 'error', 'cancelled', 'total']) assert.ok(typeof overview.jobs.counts[key] === 'number');
  assert.ok(overview.jobs.counts.done >= 1);
  assert.deepEqual(overview.jobs.active, []);

  assert.equal(overview.storage.mediaItems, 1);
  assert.equal(overview.storage.mediaBytes, movieBytes);
  assert.equal(overview.storage.libraries.length, 1);
  assert.equal(overview.storage.libraries[0].id, moviesLibrary.id);
  assert.equal(overview.storage.libraries[0].items, 1);
  assert.equal(overview.storage.libraries[0].bytes, movieBytes);
  assert.equal(overview.storage.libraries[0].exists, true);
  assert.ok(overview.storage.art.count >= 1);
  assert.ok(overview.storage.db.bytes > 0);
  assert.ok(overview.storage.cache.totalBytes >= 0);
  assert.ok(overview.storage.disk.freeBytes > 0);

  assert.equal(overview.topMedia.largest.length, 1);
  assert.equal(overview.topMedia.largest[0].item.id, movieId);
  assert.equal(overview.topMedia.largest[0].bytes, movieBytes);
  assert.equal(overview.topMedia.mostPlayed[0].item.id, movieId);
  assert.equal(overview.topMedia.mostPlayed[0].plays, 1);
  assert.equal(overview.topMedia.mostPlayed[0].seconds, 30);

  assert.equal(overview.watch.totalSeconds, 30);
  assert.equal(overview.watch.totalPlays, 1);
  assert.equal(overview.watch.watchers, 1);
  assert.equal(overview.watch.finishedCount, 0);
  assert.equal(overview.watch.last24hSeconds, 30);
  assert.deepEqual(overview.watch.topGenres, [{ genre: 'Drama', seconds: 30, plays: 1, items: 1 }]);
  assert.equal(overview.watch.recent[0].username, 'admin_user');
  assert.equal(overview.watch.recent[0].title, 'Admin Movie');
  assert.equal(overview.watch.recent[0].positionSeconds, 30);

  assert.equal(overview.settingsSummary.serverName, 'AISlopMediaBox');
  assert.equal(overview.settingsSummary.maintenanceMode, false);
  assert.equal(overview.settingsSummary.tmdbConfigured, false);
  assert.equal(overview.settingsSummary.allowSignups, false);
});

test('settings persist, validate each knob, and redact secrets from broadcasts', async () => {
  assert.equal((await user.get('/api/admin/settings')).status, 403);
  assert.equal((await manager.get('/api/admin/settings')).status, 403);
  const defaults = await admin.get<SettingsBody>('/api/admin/settings');
  assert.equal(defaults.status, 200);
  assert.equal(defaults.json?.serverName, 'AISlopMediaBox');
  assert.equal(defaults.json?.tagline, 'Certified fresh slop, served locally.');
  assert.equal(defaults.json?.accent, 'slop');
  assert.equal(defaults.json?.allowSignups, false);
  assert.equal(defaults.json?.requireInvite, true);
  assert.equal(defaults.json?.tmdbApiKey, '');
  assert.equal(defaults.json?.transcodeEnabled, true);
  assert.equal(defaults.json?.subtitleBurnIn, false);
  assert.equal(defaults.json?.maxTranscodeHeight, 1080);
  assert.equal(defaults.json?.transcodePreset, 'veryfast');
  assert.equal(defaults.json?.scanOnStart, true);
  assert.equal(defaults.json?.autoMatch, true);
  assert.equal(defaults.json?.generateArt, true);
  assert.equal(defaults.json?.allowRequests, true);
  assert.equal(defaults.json?.allowParties, true);
  assert.equal(defaults.json?.maintenanceMode, false);
  assert.equal(defaults.json?.memes, true);
  assert.equal(defaults.json?.telemetry, false);

  const changed = await admin.patch<{ ok: boolean; changed: string[]; settings: SettingsBody }>('/api/admin/settings', {
    serverName: 'Slop Palace',
    tagline: '',
    accent: 'midnight',
    allowSignups: true,
    maxTranscodeHeight: 720,
    transcodePreset: 'fast',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json?.ok, true);
  assert.deepEqual(changed.json?.changed, ['serverName', 'tagline', 'accent', 'allowSignups', 'maxTranscodeHeight', 'transcodePreset']);
  assert.equal(changed.json?.settings.serverName, 'Slop Palace');
  assert.equal(changed.json?.settings.maxTranscodeHeight, 720);
  const persisted = await admin.get<SettingsBody>('/api/admin/settings');
  assert.equal(persisted.json?.serverName, 'Slop Palace');
  assert.equal(persisted.json?.transcodePreset, 'fast');
  const branding = await new Client(server.baseUrl, 'branding').get<{ serverName: string; accent: string; allowSignups: boolean }>('/api/branding');
  assert.equal(branding.json?.serverName, 'Slop Palace');
  assert.equal(branding.json?.accent, 'midnight');
  assert.equal(branding.json?.allowSignups, true);

  const invalid: { body: Record<string, unknown>; label: string }[] = [
    { body: {}, label: 'empty patch' },
    { body: { unknownKnob: true }, label: 'unknown key' },
    { body: { telemetry: true }, label: 'telemetry true' },
    { body: { allowSignups: 'yes' }, label: 'boolean type' },
    { body: { accent: 'unicorn' }, label: 'accent' },
    { body: { transcodePreset: 'ludicrous' }, label: 'preset' },
    { body: { maxTranscodeHeight: 100 }, label: 'height low' },
    { body: { maxTranscodeHeight: 3000 }, label: 'height high' },
    { body: { maxTranscodeHeight: 720.5 }, label: 'height float' },
    { body: { serverName: '' }, label: 'serverName empty' },
    { body: { serverName: 'x'.repeat(61) }, label: 'serverName long' },
    { body: { tagline: 'x'.repeat(161) }, label: 'tagline long' },
    { body: { tmdbApiKey: 'short' }, label: 'tmdb short' },
    { body: { tmdbApiKey: 'bad key!!!' }, label: 'tmdb malformed' },
    { body: { tmdbApiKey: 42 }, label: 'tmdb type' },
    { body: { scanOnStart: 1 }, label: 'number boolean' },
  ];
  for (const entry of invalid) {
    const response = await admin.patch('/api/admin/settings', entry.body);
    assert.equal(response.status, 400, `${entry.label}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request', entry.label);
  }

  const key = await admin.patch<{ settings: SettingsBody }>('/api/admin/settings', { tmdbApiKey: 'abcd1234' });
  assert.equal(key.status, 200);
  assert.equal(key.json?.settings.tmdbApiKey, 'abcd1234');
  const privacy = await admin.get<{ zeroOutbound: boolean; tmdb: { configured: boolean; source: string } }>('/api/admin/privacy');
  assert.equal(privacy.json?.tmdb.configured, true);
  assert.equal(privacy.json?.tmdb.source, 'settings');
  assert.equal(privacy.json?.zeroOutbound, false);
  const cleared = await admin.patch<{ settings: SettingsBody }>('/api/admin/settings', { tmdbApiKey: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json?.settings.tmdbApiKey, '');
  assert.equal((await admin.get<{ zeroOutbound: boolean }>('/api/admin/privacy')).json?.zeroOutbound, true);
  assert.equal((await admin.patch('/api/admin/settings', [])).status, 400);
});

test('admin user listing filters, sorts, and paginates', async () => {
  const list = await admin.get<UsersPage>('/api/admin/users');
  assert.equal(list.status, 200);
  assert.equal(list.json?.total, 4);
  assert.deepEqual(list.json?.byRole, { admin: 1, manager: 1, user: 2 });
  const adminRow = list.json!.items.find((entry) => entry.username === 'admin')!;
  assert.equal(adminRow.role, 'admin');
  assert.equal(adminRow.displayName, 'Head Slopmaster');
  assert.equal(adminRow.disabled, false);
  assert.equal(adminRow.hasPin, false);
  assert.ok(adminRow.activeSessions >= 1);
  assert.ok(adminRow.avatarHue >= 0 && adminRow.avatarHue <= 360);
  assert.match(adminRow.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const q = await admin.get<UsersPage>('/api/admin/users?q=admin_user');
  assert.equal(q.json?.total, 1);
  assert.equal(q.json!.items[0].username, 'admin_user');
  const role = await admin.get<UsersPage>('/api/admin/users?role=user');
  assert.equal(role.json?.total, 2);
  const managers = await admin.get<UsersPage>('/api/admin/users?role=manager');
  assert.equal(managers.json?.total, 1);
  const paged = await admin.get<UsersPage>('/api/admin/users?pageSize=1&page=2&sort=username&order=asc');
  assert.equal(paged.json?.items.length, 1);
  assert.equal(paged.json?.pageSize, 1);
  assert.equal((await admin.get('/api/admin/users?role=owner')).status, 400);
  assert.equal((await admin.get('/api/admin/users?sort=password')).status, 400);
  assert.equal((await user.get('/api/admin/users')).status, 403);
});

test('admin user creation validates fields and rejects duplicates', async () => {
  const invalid: Record<string, unknown>[] = [
    {},
    { username: 'x', password: 'password123' },
    { username: 'bad name', password: 'password123' },
    { username: 'x'.repeat(33), password: 'password123' },
    { username: 'valid_user', password: 'short' },
    { username: 'valid_user', password: 'x'.repeat(201) },
    { username: 'valid_user', password: 'password123', role: 'owner' },
    { username: 'valid_user', password: 'password123', displayName: '' },
    { username: 'valid_user', password: 'password123', displayName: 'x'.repeat(41) },
  ];
  for (const body of invalid) {
    const response = await admin.post('/api/admin/users', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
  }

  const created = await admin.post<{ ok: boolean; user: UserRow }>('/api/admin/users', {
    username: 'new_user',
    password: USER_PASSWORD,
    role: 'user',
    displayName: 'Fresh User',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json?.user.username, 'new_user');
  assert.equal(created.json?.user.displayName, 'Fresh User');
  assert.equal(created.json?.user.role, 'user');
  assert.equal(created.json?.user.activeSessions, 0);
  assert.equal(created.json?.user.hasPin, false);
  const duplicate = await admin.post('/api/admin/users', { username: 'new_user', password: USER_PASSWORD });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.json as ErrorBody).error.code, 'conflict');
});

test('admin user updates gate sessions, pins, roles, and reset passwords', async () => {
  const newUser = new Client(server.baseUrl, 'new-user-session');
  await newUser.loginOk('new_user', USER_PASSWORD);
  const list = await admin.get<UsersPage>('/api/admin/users?q=new_user');
  const newUserId = list.json!.items[0].id;

  const display = await admin.patch<{ ok: boolean; user: UserRow }>(`/api/admin/users/${newUserId}`, { displayName: 'New Person' });
  assert.equal(display.status, 200);
  assert.equal(display.json?.user.displayName, 'New Person');
  assert.equal((await newUser.get<{ displayName: string }>('/api/users/me')).json?.displayName, 'New Person');

  const invalid: Record<string, unknown>[] = [
    {},
    { password: 'not-a-field' },
    { role: 'owner' },
    { disabled: 'yes' },
    { displayName: '' },
    { displayName: 'x'.repeat(41) },
    { pin: 'abc' },
    { pin: '123' },
    { pin: 1234 },
  ];
  for (const body of invalid) {
    assert.equal((await admin.patch(`/api/admin/users/${newUserId}`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await admin.patch('/api/admin/users/99999', { displayName: 'Ghost' })).status, 404);

  const pin = await admin.patch<{ user: UserRow }>(`/api/admin/users/${newUserId}`, { pin: '4321' });
  assert.equal(pin.status, 200);
  assert.equal(pin.json?.user.hasPin, true);
  assert.equal((await admin.patch<{ user: UserRow }>(`/api/admin/users/${newUserId}`, { pin: null })).json?.user.hasPin, false);

  const disabled = await admin.patch<{ user: UserRow; sessionsRevoked: number }>(`/api/admin/users/${newUserId}`, { disabled: true });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json?.user.disabled, true);
  assert.ok((disabled.json?.sessionsRevoked ?? 0) >= 1);
  assert.equal((await newUser.get('/api/auth/me')).status, 401);
  const bannedLogin = await new Client(server.baseUrl, 'banned').login('new_user', USER_PASSWORD);
  assert.equal(bannedLogin.status, 403);
  assert.equal((bannedLogin.json as { error?: { code?: string } }).error?.code, 'account_disabled');
  assert.equal((await admin.patch(`/api/admin/users/${newUserId}`, { disabled: false })).status, 200);

  const promoted = await admin.patch<{ user: UserRow }>(`/api/admin/users/${newUserId}`, { role: 'manager' });
  assert.equal(promoted.json?.user.role, 'manager');
  assert.equal((await admin.patch<{ user: UserRow }>(`/api/admin/users/${newUserId}`, { role: 'user' })).json?.user.role, 'user');

  const generated = await admin.post<{ ok: boolean; generated: boolean; password: string; sessionsRevoked: number }>(
    `/api/admin/users/${newUserId}/reset-password`,
    {},
  );
  assert.equal(generated.status, 200);
  assert.equal(generated.json?.generated, true);
  assert.equal(generated.json?.password.length, 12);
  assert.equal(generated.json?.sessionsRevoked, 0, 'the account had no live sessions after being disabled');
  const generatedLogin = await new Client(server.baseUrl, 'generated-password').login('new_user', generated.json!.password);
  assert.equal(generatedLogin.status, 200);

  const explicit = await admin.post<{ generated: boolean; password?: string; sessionsRevoked: number }>(`/api/admin/users/${newUserId}/reset-password`, {
    password: 'resetpass1',
  });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.json?.generated, false);
  assert.equal(explicit.json?.password, undefined);
  assert.ok((explicit.json?.sessionsRevoked ?? 0) >= 1);
  assert.equal((await new Client(server.baseUrl, 'old-generated').login('new_user', generated.json!.password)).status, 401);
  const resetLogin = await new Client(server.baseUrl, 'reset-login');
  await resetLogin.loginOk('new_user', 'resetpass1');
  assert.equal((await resetLogin.get('/api/users/me')).status, 200);
  assert.equal((await admin.post('/api/admin/users/99999/reset-password', {})).status, 404);
  assert.equal((await admin.post(`/api/admin/users/${newUserId}/reset-password`, { password: 'short' })).status, 400);
});

test('last-admin protections hold and a second admin can hand over safely', async () => {
  const demote = await admin.patch(`/api/admin/users/${adminId}`, { role: 'user' });
  assert.equal(demote.status, 409);
  assert.equal((demote.json as ErrorBody).error.code, 'conflict');
  const disable = await admin.patch(`/api/admin/users/${adminId}`, { disabled: true });
  assert.equal(disable.status, 409);
  const selfDelete = await admin.del(`/api/admin/users/${adminId}`);
  assert.equal(selfDelete.status, 400);

  const second = await admin.post<{ user: UserRow }>('/api/admin/users', {
    username: 'second_admin',
    password: 'secondpass1',
    role: 'admin',
  });
  assert.equal(second.status, 201);
  const secondAdmin = new Client(server.baseUrl, 'second-admin');
  await secondAdmin.loginOk('second_admin', 'secondpass1');

  const handedOver = await secondAdmin.patch<{ user: UserRow }>(`/api/admin/users/${adminId}`, { role: 'user' });
  assert.equal(handedOver.status, 200);
  assert.equal(handedOver.json?.user.role, 'user');
  assert.equal((await admin.get('/api/admin/overview')).status, 403, 'demoted admin loses access');
  const restored = await secondAdmin.patch<{ user: UserRow }>(`/api/admin/users/${adminId}`, { role: 'admin' });
  assert.equal(restored.status, 200);
  assert.equal((await admin.get('/api/admin/overview')).status, 200);

  const deletedSecond = await admin.del(`/api/admin/users/${second.json!.user.id}`);
  assert.equal(deletedSecond.status, 200);
  assert.equal((await secondAdmin.get('/api/users/me')).status, 401);

  const users = await admin.get<UsersPage>('/api/admin/users?q=new_user');
  assert.equal(users.json?.total, 1);
  assert.equal((await admin.del(`/api/admin/users/${users.json!.items[0].id}`)).status, 200);
  assert.equal((await admin.get<UsersPage>('/api/admin/users?q=new_user')).json?.total, 0);
});

test('invitations validate roles/ttl, persist, and can be consumed once', async () => {
  const initial = await admin.get<PagedItems<Invite>>('/api/admin/invites');
  assert.equal(initial.status, 200);
  assert.equal(initial.json?.total, 0);

  const created = await admin.post<{ ok: boolean; invite: Invite }>('/api/admin/invites', {});
  assert.equal(created.status, 201);
  assert.match(created.json?.invite.code ?? '', /^[A-Z0-9]{12}$/);
  assert.equal(created.json?.invite.role, 'user');
  assert.equal(created.json?.invite.valid, true);
  assert.equal(created.json?.invite.expired, false);
  assert.ok(Date.parse(created.json!.invite.expiresAt ?? '') > Date.now());
  assert.equal(created.json?.invite.createdBy?.username, 'admin');

  const managerInvite = await admin.post<{ invite: Invite }>('/api/admin/invites', { role: 'manager', ttlHours: 720 });
  assert.equal(managerInvite.status, 201);
  assert.equal(managerInvite.json?.invite.role, 'manager');

  const invalid: Record<string, unknown>[] = [
    { role: 'admin' },
    { role: 'user', ttlHours: 0 },
    { role: 'user', ttlHours: 721 },
    { role: 'user', ttlHours: 1.5 },
    { role: 'user', ttlHours: '72' },
  ];
  for (const body of invalid) {
    assert.equal((await admin.post('/api/admin/invites', body)).status, 400, JSON.stringify(body));
  }

  const list = await admin.get<PagedItems<Invite>>('/api/admin/invites');
  assert.equal(list.json?.total, 2);
  assert.equal((await manager.get('/api/admin/invites')).status, 403);
  const deleteOne = await admin.del('/api/admin/invites/' + created.json!.invite.id);
  assert.equal(deleteOne.status, 200);
  assert.equal((await admin.del('/api/admin/invites/' + created.json!.invite.id)).status, 404);

  const invite = managerInvite.json!.invite.code;
  const registered = await new Client(server.baseUrl, 'invite-register').post<{ user: { role: string } }>('/api/auth/register', {
    username: 'invited_via_admin',
    password: 'password123',
    invite,
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.json?.user.role, 'manager');
  const usedList = await admin.get<PagedItems<Invite>>('/api/admin/invites');
  const used = usedList.json!.items.find((entry) => entry.code === invite)!;
  assert.equal(used.valid, false);
  assert.equal(used.usedBy?.username, 'invited_via_admin');
  assert.equal((await admin.get<PagedItems<Invite>>('/api/admin/invites?pageSize=1')).json?.items.length, 1);
});

test('admin logs filter by level/scope/text, export NDJSON, and can be cleared', async () => {
  // Generate a real warn log through the HTTP middleware.
  assert.equal((await admin.get('/api/media/99999')).status, 404);
  const page = await admin.get<LogsPage>('/api/admin/logs');
  assert.equal(page.status, 200);
  assert.ok((page.json?.total ?? 0) > 0);
  assert.ok(page.json!.items.length > 0);
  for (const level of ['debug', 'info', 'warn', 'error']) assert.ok(typeof page.json!.byLevel[level] === 'number');
  assert.ok(page.json!.scopes.includes('http'));
  const entry = page.json!.items[0];
  assert.equal(typeof entry.id, 'number');
  assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level));
  assert.ok(entry.scope.length > 0);
  assert.ok(entry.message.length > 0);
  assert.match(entry.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const warn = await admin.get<LogsPage>('/api/admin/logs?level=warn');
  assert.ok((warn.json?.total ?? 0) > 0);
  assert.ok(warn.json!.items.every((row) => row.level === 'warn'));
  const http = await admin.get<LogsPage>('/api/admin/logs?scope=http');
  assert.ok(http.json!.items.every((row) => row.scope === 'http'));
  const search = await admin.get<LogsPage>('/api/admin/logs?level=warn&q=99999');
  assert.ok((search.json?.total ?? 0) >= 1);
  assert.ok(search.json!.items.some((row) => row.message.includes('99999')));
  const recentOnly = await admin.get<LogsPage>('/api/admin/logs?olderThanDays=0');
  assert.ok(recentOnly.json!.items.every((row) => Date.parse(row.createdAt) <= Date.now()));
  const pageOne = await admin.get<LogsPage>('/api/admin/logs?pageSize=1&page=2');
  assert.ok(pageOne.json!.items.length <= 1);
  assert.equal((await admin.get('/api/admin/logs?level=verbose')).status, 400);
  assert.equal((await admin.get('/api/admin/logs?olderThanDays=-1')).status, 400);
  assert.equal((await manager.get('/api/admin/logs')).status, 403);

  const exported = await admin.get('/api/admin/logs/export?level=warn&limit=2');
  assert.equal(exported.status, 200);
  assert.match(exported.contentType, /application\/x-ndjson/);
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="aislop-logs-.*\.jsonl"/);
  const lines = exported.text.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const row = JSON.parse(line) as LogEntry;
    assert.equal(row.level, 'warn');
    assert.equal(typeof row.message, 'string');
  }
  const clamped = await admin.get('/api/admin/logs/export?limit=0');
  assert.equal(clamped.text.trim().split('\n').filter(Boolean).length, 1);
  assert.equal((await admin.get('/api/admin/logs/export?level=nope')).status, 400);

  const before = await admin.get<LogsPage>('/api/admin/logs');
  const deleted = await admin.del<{ ok: boolean; deleted: number }>('/api/admin/logs', { level: 'warn' });
  assert.equal(deleted.status, 200);
  assert.ok((deleted.json?.deleted ?? 0) > 0);
  const after = await admin.get<LogsPage>('/api/admin/logs');
  assert.ok((after.json?.total ?? 0) <= (before.json?.total ?? 0));
  assert.equal((await manager.del('/api/admin/logs', {})).status, 403);
  assert.equal((await admin.del('/api/admin/logs', { level: 'verbose' })).status, 400);
});

test('maintenance mode blocks non-admins but keeps auth, health, and admin alive', async () => {
  const enabled = await admin.patch('/api/admin/settings', { maintenanceMode: true });
  assert.equal(enabled.status, 200);
  assert.equal((await admin.get<{ maintenance: boolean }>('/api/health')).json?.maintenance, true);
  assert.equal((await user.get('/api/auth/me')).status, 200);

  const blocked = await user.get('/api/music');
  assert.equal(blocked.status, 503);
  assert.equal((blocked.json as ErrorBody).error.code, 'maintenance');
  assert.equal((await user.get('/api/browse')).status, 503);
  assert.equal((await user.get('/api/admin/overview')).status, 403, 'admin route still requires admin');
  assert.equal((await admin.get('/api/music')).status, 200);
  assert.equal((await manager.get('/api/music')).status, 503);

  const disabled = await admin.patch('/api/admin/settings', { maintenanceMode: false });
  assert.equal(disabled.status, 200);
  assert.equal((await user.get('/api/music')).status, 200);
  assert.equal((await admin.get<{ maintenance: boolean }>('/api/health')).json?.maintenance, false);
});

