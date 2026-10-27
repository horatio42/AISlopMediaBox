import { after, before, test } from 'node:test';
import path from 'node:path';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  USER_PASSWORD,
  adminClient,
  assert,
  Client,
  createLibrary,
  makeAudioTrack,
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
}

interface PagedItems<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface RequestItem {
  id: number;
  title: string;
  kind: string;
  year: number | null;
  note: string;
  status: string;
  reviewNote: string;
  user: { id: number; username: string; displayName: string } | null;
  reviewedBy: { id: number; username: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface RequestStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  fulfilled: number;
  scope: string;
  allowRequests: boolean;
}

interface ReportItem {
  id: number;
  mediaId: number | null;
  mediaTitle: string | null;
  reason: string;
  status: string;
  notes: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface UserProfile {
  id: number;
  username: string;
  displayName: string;
  role: string;
  avatarHue: number;
  hasPin?: boolean;
  preferences: Record<string, unknown>;
  activeSessions?: number;
  stats?: Record<string, number>;
}

interface ExportBody {
  exportedAt: string;
  version: number;
  app: string;
  user: UserProfile;
  state: {
    favorites: { mediaId: number; title: string }[];
    watched: { mediaId: number; title: string }[];
    ratings: { mediaId: number; rating: number }[];
  };
  progress: { mediaId: number; positionSeconds: number; finished: boolean }[];
  collections: { name: string; itemIds: number[] }[];
  playlists: { name: string; items: { mediaId: number }[] }[];
  requests: { title: string; status: string }[];
  reports: { reason: string; status: string }[];
  sessions: { current: boolean; createdAt: string }[];
}

let server: StartedServer;
let admin: Client;
let manager: Client;
let user: Client;
let other: Client;
let moviesLibrary: Library;
let movieA: number;
let movieB: number;
let trackId: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  manager = await newUserClient(server, admin, 'request_manager', 'manager');
  user = await newUserClient(server, admin, 'request_user', 'user');
  other = await newUserClient(server, admin, 'request_other', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  for (const [title, year] of [
    ['Request Movie A', 2015],
    ['Request Movie B', 2016],
  ] as const) {
    const dir = path.join(moviesRoot, `${title} (${year})`);
    makeVideo(path.join(dir, `${title} (${year}).mp4`));
    writeNfo(path.join(dir, 'movie.nfo'), 'movie', { title, year, plot: `${title} plot`, genres: ['Drama'] });
  }
  makeAudioTrack(path.join(server.mediaDir, 'music', 'Req Artist', 'Req Album (2017)', '01 - Req Track.mp3'), {
    title: 'Req Track',
    genre: 'Chill',
    track: 1,
  });

  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  const musicLibrary = await createLibrary(admin, { name: 'Music', kind: 'music', path: path.join(server.mediaDir, 'music') });
  await scanLibrary(admin, moviesLibrary.id);
  await scanLibrary(admin, musicLibrary.id);

  const movies = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items?sort=title`);
  movieA = movies.json!.items.find((item) => item.title === 'Request Movie A')!.id;
  movieB = movies.json!.items.find((item) => item.title === 'Request Movie B')!.id;
  const music = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items?kind=album`);
  const album = await admin.get<{ tracks: MediaItem[] }>(`/api/media/${music.json!.items[0].id}`);
  trackId = album.json!.tracks[0].id;
});

after(async () => {
  await server.stop();
});

test('media requests respect the allowRequests gate and validate every field', async () => {
  const disabled = await admin.patch('/api/admin/settings', { allowRequests: false });
  assert.equal(disabled.status, 200);
  const blocked = await user.post('/api/requests', { title: 'Blocked Request', kind: 'movie' });
  assert.equal(blocked.status, 403);
  assert.equal((blocked.json as ErrorBody).error.code, 'requests_disabled');
  assert.equal((await admin.patch('/api/admin/settings', { allowRequests: true })).status, 200);

  const invalid: Record<string, unknown>[] = [
    {},
    { title: '' },
    { title: 'x'.repeat(201) },
    { title: 'Bad kind', kind: 'podcast' },
    { title: 'Too old', year: 1879 },
    { title: 'Too new', year: 2201 },
    { title: 'Long note', note: 'x'.repeat(2001) },
    { title: 'Bad note', note: 42 },
  ];
  for (const body of invalid) {
    const response = await other.post('/api/requests', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request');
  }

  const created = await user.post<RequestItem>('/api/requests', {
    title: 'The Slop Movie',
    kind: 'movie',
    year: 2020,
    note: 'Please, chief.',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json?.title, 'The Slop Movie');
  assert.equal(created.json?.kind, 'movie');
  assert.equal(created.json?.year, 2020);
  assert.equal(created.json?.note, 'Please, chief.');
  assert.equal(created.json?.status, 'pending');
  assert.equal(created.json?.reviewNote, '');
  assert.equal(created.json?.user?.username, 'request_user');
  assert.equal(created.json?.reviewedBy, null);
  assert.match(created.json?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

  const duplicate = await user.post('/api/requests', { title: 'the slop movie' });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.json as ErrorBody).error.code, 'conflict');

  const otherRequest = await other.post<RequestItem>('/api/requests', { title: 'Other Request', kind: 'show', year: 2016 });
  assert.equal(otherRequest.status, 201);

  const mine = await user.get<PagedItems<RequestItem>>('/api/requests');
  assert.equal(mine.json?.total, 1);
  assert.equal(mine.json!.items[0].title, 'The Slop Movie');
  const mineOther = await other.get<PagedItems<RequestItem>>('/api/requests');
  assert.equal(mineOther.json?.total, 1);
  assert.equal(mineOther.json!.items[0].title, 'Other Request');
  const all = await manager.get<PagedItems<RequestItem>>('/api/requests');
  assert.equal(all.json?.total, 2);
  const mineManager = await manager.get<PagedItems<RequestItem>>('/api/requests?mine=1');
  assert.equal(mineManager.json?.total, 0);
  const pendingOnly = await manager.get<PagedItems<RequestItem>>('/api/requests?status=pending');
  assert.equal(pendingOnly.json?.total, 2);
  assert.equal((await manager.get('/api/requests?status=closed')).status, 400);

  const ownStats = await user.get<RequestStats>('/api/requests/stats');
  assert.deepEqual(ownStats.json, {
    total: 1,
    pending: 1,
    approved: 0,
    rejected: 0,
    fulfilled: 0,
    scope: 'own',
    allowRequests: true,
  });
  const allStats = await manager.get<RequestStats>('/api/requests/stats');
  assert.equal(allStats.json?.total, 2);
  assert.equal(allStats.json?.scope, 'all');
  assert.equal((await manager.get<RequestStats>('/api/requests/stats?mine=1')).json?.scope, 'own');
});

test('request reviews enforce transitions, notes, and manager permissions', async () => {
  const requests = await manager.get<PagedItems<RequestItem>>('/api/requests?status=pending');
  const userRequest = requests.json!.items.find((item) => item.user?.username === 'request_user')!;
  const otherRequest = requests.json!.items.find((item) => item.user?.username === 'request_other')!;

  assert.equal((await user.patch(`/api/requests/${userRequest.id}`, { status: 'approved' })).status, 403);
  assert.equal((await other.patch(`/api/requests/${userRequest.id}`, { status: 'approved' })).status, 403);

  const approved = await manager.patch<{ ok: boolean; request: RequestItem }>(`/api/requests/${userRequest.id}`, {
    status: 'approved',
    reviewNote: 'Good slop.',
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json?.request.status, 'approved');
  assert.equal(approved.json?.request.reviewNote, 'Good slop.');
  assert.equal(approved.json?.request.reviewedBy?.username, 'request_manager');
  assert.ok(Date.parse(approved.json!.request.updatedAt) >= Date.parse(approved.json!.request.createdAt));

  const fulfilled = await manager.patch<{ request: RequestItem }>(`/api/requests/${userRequest.id}`, { status: 'fulfilled' });
  assert.equal(fulfilled.status, 200);
  assert.equal(fulfilled.json?.request.status, 'fulfilled');

  assert.equal((await manager.patch(`/api/requests/${userRequest.id}`, { status: 'pending' })).status, 409);
  assert.equal((await manager.patch(`/api/requests/${userRequest.id}`, { status: 'rejected' })).status, 409);
  assert.equal((await manager.patch(`/api/requests/${userRequest.id}`, { status: 'closed' })).status, 400);

  const rejected = await manager.patch<{ request: RequestItem }>(`/api/requests/${otherRequest.id}`, { status: 'rejected' });
  assert.equal(rejected.status, 200);
  const backwards = await manager.patch(`/api/requests/${otherRequest.id}`, { status: 'approved' });
  assert.equal(backwards.status, 409);
  assert.deepEqual((backwards.json as ErrorBody).error.details as { allowed?: string[] }, { allowed: [] });

  const managerRequest = await manager.post<RequestItem>('/api/requests', { title: 'Manager Request' });
  assert.equal(managerRequest.status, 201);
  const longNote = await manager.patch(`/api/requests/${managerRequest.json!.id}`, { status: 'approved', reviewNote: 'x'.repeat(1001) });
  assert.equal(longNote.status, 400);
  assert.equal((await manager.patch(`/api/requests/${managerRequest.json!.id}`, {})).status, 400);
  assert.equal((await manager.patch('/api/requests/99999', { status: 'approved' })).status, 404);
  assert.equal((await manager.patch('/api/requests/abc', { status: 'approved' })).status, 400);

  const deleteMe = await user.post<RequestItem>('/api/requests', { title: 'Delete Me Please' });
  assert.equal(deleteMe.status, 201);
  assert.equal((await other.del(`/api/requests/${deleteMe.json!.id}`)).status, 403);
  const deleted = await user.del(`/api/requests/${deleteMe.json!.id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await user.del(`/api/requests/${userRequest.id}`)).status, 403);
  assert.equal((await admin.del(`/api/requests/${managerRequest.json!.id}`)).status, 200);
  assert.equal((await admin.del(`/api/requests/${userRequest.id}`)).status, 200);
  assert.equal((await admin.del('/api/requests/99999')).status, 404);

  const finalAll = await manager.get<PagedItems<RequestItem>>('/api/requests');
  assert.equal(finalAll.json?.total, 1);
  const finalStats = await manager.get<RequestStats>('/api/requests/stats');
  assert.equal(finalStats.json?.total, 1);
  assert.equal(finalStats.json?.rejected, 1);
});

test('profile preferences merge, validate, and reject privilege fields', async () => {
  assert.equal((await user.put(`/api/progress/${movieA}/state`, { favorite: true, rating: 9 })).status, 200);
  assert.equal((await user.put(`/api/progress/${movieB}`, { positionSeconds: 30, durationSeconds: 120 })).status, 200);

  const playlist = await user.post<{ id: number }>('/api/playlists', { name: 'Profile Mix' });
  assert.equal((await user.post(`/api/playlists/${playlist.json!.id}/items`, { mediaIds: [movieA] })).status, 201);
  const collection = await user.post<{ id: number }>('/api/collections', { name: 'Profile Picks' });
  assert.equal((await user.post(`/api/collections/${collection.json!.id}/items`, { mediaIds: [movieA] })).status, 201);

  const me = await user.get<UserProfile>('/api/users/me');
  assert.equal(me.status, 200);
  assert.equal(me.json?.username, 'request_user');
  assert.equal(me.json?.role, 'user');
  assert.equal(me.json?.hasPin, false);
  assert.equal(me.json?.activeSessions, 1);
  assert.equal(me.json?.stats?.favorites, 1);
  assert.equal(me.json?.stats?.watched, 0);
  assert.equal(me.json?.stats?.rated, 1);
  assert.equal(me.json?.stats?.progressCount, 1);
  assert.equal(me.json?.stats?.inProgress, 1);
  assert.equal(me.json?.stats?.playlists, 1);
  assert.equal(me.json?.stats?.collections, 1);
  assert.equal(me.json?.stats?.requests, 0);
  assert.equal(me.json?.stats?.reports, 0);

  const patched = await user.patch<UserProfile>('/api/users/me', {
    displayName: 'Slop Person',
    avatarHue: 123,
    preferences: { theme: 'dark', reduceMotion: true },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json?.displayName, 'Slop Person');
  assert.equal(patched.json?.avatarHue, 123);
  assert.deepEqual(patched.json?.preferences, { theme: 'dark', reduceMotion: true });

  const merged = await user.patch<UserProfile>('/api/users/me', { preferences: { memes: false } });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.json?.preferences, { theme: 'dark', reduceMotion: true, memes: false });
  const authMe = await user.get<{ user: UserProfile }>('/api/auth/me');
  assert.equal(authMe.json?.user.displayName, 'Slop Person');
  assert.equal(authMe.json?.user.preferences.memes, false);

  const invalid: Record<string, unknown>[] = [
    {},
    { role: 'admin' },
    { username: 'new_name' },
    { displayName: '' },
    { displayName: 'x'.repeat(61) },
    { avatarHue: 361 },
    { avatarHue: -1 },
    { avatarHue: 1.5 },
    { preferences: [] },
    { preferences: { theme: 'neon' } },
    { preferences: { cardDensity: 'huge' } },
    { preferences: { autoPlayNext: 'yes' } },
    { preferences: { defaultSubtitle: 'x'.repeat(41) } },
    { preferences: { nonsense: true } },
  ];
  for (const body of invalid) {
    const response = await user.patch('/api/users/me', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request');
  }
});

test('password changes verify the current password and revoke other sessions', async () => {
  const second = new Client(server.baseUrl, 'profile-second');
  await second.loginOk('request_user', USER_PASSWORD);

  const wrong = await user.post('/api/users/me/password', { current: 'not-the-password', next: 'newpass123' });
  assert.equal(wrong.status, 400);
  assert.equal((wrong.json as ErrorBody).error.code, 'invalid_password');
  const short = await user.post('/api/users/me/password', { current: USER_PASSWORD, next: 'short' });
  assert.equal(short.status, 400);
  const same = await user.post('/api/users/me/password', { current: USER_PASSWORD, next: USER_PASSWORD });
  assert.equal(same.status, 400);
  assert.equal((same.json as ErrorBody).error.message, 'New password must differ from the current one.');

  const changed = await user.post<{ ok: boolean; sessionsRevoked: number }>('/api/users/me/password', {
    current: USER_PASSWORD,
    next: 'newpass123',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json?.ok, true);
  assert.ok((changed.json?.sessionsRevoked ?? 0) >= 1);
  assert.equal((await user.get('/api/users/me')).status, 200);
  assert.equal((await second.get('/api/users/me')).status, 401);

  const oldLogin = await new Client(server.baseUrl, 'old-password').login('request_user', USER_PASSWORD);
  assert.equal(oldLogin.status, 401);
  assert.equal((oldLogin.json as { error?: { code?: string } }).error?.code, 'invalid_credentials');
  const newSession = new Client(server.baseUrl, 'new-password');
  await newSession.loginOk('request_user', 'newpass123');
  assert.equal((await newSession.get('/api/users/me')).status, 200);
});

test('user export scopes state to the caller and never leaks hashes', async () => {
  const response = await user.get<ExportBody>('/api/users/me/export');
  assert.equal(response.status, 200);
  assert.match(response.contentType, /application\/json/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="aislopmediabox-export-request_user-\d{4}-\d{2}-\d{2}\.json"/);

  const exported = response.json!;
  assert.equal(exported.version, 1);
  assert.equal(exported.app, 'AISlopMediaBox');
  assert.match(exported.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(exported.user.username, 'request_user');
  assert.equal(exported.user.displayName, 'Slop Person');
  assert.equal(exported.state.favorites.length, 1);
  assert.equal(exported.state.favorites[0].mediaId, movieA);
  assert.equal(exported.state.ratings.length, 1);
  assert.equal(exported.state.ratings[0].mediaId, movieA);
  assert.equal(exported.state.ratings[0].rating, 9);
  assert.deepEqual(exported.state.watched, []);
  assert.equal(exported.progress.length, 1);
  assert.equal(exported.progress[0].mediaId, movieB);
  assert.equal(exported.progress[0].positionSeconds, 30);
  assert.equal(exported.progress[0].finished, false);
  assert.deepEqual(exported.collections.map((entry) => entry.name), ['Profile Picks']);
  assert.deepEqual(exported.collections[0].itemIds, [movieA]);
  assert.deepEqual(exported.playlists.map((entry) => entry.name), ['Profile Mix']);
  assert.deepEqual(exported.playlists[0].items.map((item) => item.mediaId), [movieA]);
  assert.deepEqual(exported.requests, []);
  assert.deepEqual(exported.reports, []);
  assert.equal(exported.sessions.filter((session) => session.current).length, 1);
  assert.ok(exported.sessions.length >= 2);
  assert.ok(!response.text.includes('password_hash'));
  assert.ok(!response.text.includes('scrypt$'));
  assert.ok(!response.text.includes('request_other'));
});

test('self-deletion requires the password, clears the session, and removes the account', async () => {
  const wrong = await user.del('/api/users/me', { password: 'wrong-password' });
  assert.equal(wrong.status, 400);
  assert.equal((wrong.json as ErrorBody).error.code, 'invalid_password');
  assert.ok(user.cookies.has('slop_session'));

  const deleted = await user.del<{ ok: boolean }>('/api/users/me', { password: 'newpass123' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json?.ok, true);
  assert.equal(user.cookies.has('slop_session'), false);
  assert.equal((await user.get('/api/auth/me')).status, 401);

  const relogin = await new Client(server.baseUrl, 'deleted-relogin').login('request_user', 'newpass123');
  assert.equal(relogin.status, 401);
  const users = await admin.get<PagedItems<UserProfile>>('/api/admin/users?q=request_user');
  assert.equal(users.json?.total, 0);
  const allUsers = await admin.get<PagedItems<UserProfile>>('/api/admin/users');
  assert.ok(!allUsers.json!.items.some((entry) => entry.username === 'request_user'));
});

test('moderation reports accept media or title, expose own reports, and admin review resolves', async () => {
  const invalid: Record<string, unknown>[] = [
    {},
    { reason: 'ab' },
    { reason: 'x'.repeat(1001) },
    { reason: 'Suspicious', mediaId: 99999 },
    { reason: 'Suspicious' },
    { reason: 'Suspicious', title: 'x'.repeat(201) },
  ];
  for (const body of invalid) {
    const response = await other.post('/api/requests/reports', body);
    assert.equal([400, 404].includes(response.status), true, `${JSON.stringify(body)}: ${response.status}`);
  }

  const mediaReport = await other.post<{ ok: boolean; report: ReportItem }>('/api/requests/reports', {
    mediaId: movieA,
    reason: 'This file is too sloppy.',
  });
  assert.equal(mediaReport.status, 201);
  assert.equal(mediaReport.json?.report.mediaId, movieA);
  assert.equal(mediaReport.json?.report.mediaTitle, 'Request Movie A');
  assert.equal(mediaReport.json?.report.status, 'open');
  assert.equal(mediaReport.json?.report.reason, 'This file is too sloppy.');
  assert.equal(mediaReport.json?.report.resolvedAt, null);

  const titleReport = await other.post<{ report: ReportItem }>('/api/requests/reports', {
    title: 'Ghost Feature',
    reason: 'Not even in the library.',
  });
  assert.equal(titleReport.status, 201);
  assert.equal(titleReport.json?.report.mediaId, null);
  assert.equal(titleReport.json?.report.notes, 'Reported title: Ghost Feature');

  const mine = await other.get<PagedItems<ReportItem>>('/api/requests/reports/mine');
  assert.equal(mine.json?.total, 2);
  assert.deepEqual(mine.json!.items.map((report) => report.reason).sort(), ['Not even in the library.', 'This file is too sloppy.']);
  assert.equal((await manager.get<PagedItems<ReportItem>>('/api/requests/reports/mine')).json?.total, 0);

  const adminList = await admin.get<PagedItems<ReportItem> & { byStatus: Record<string, number> }>('/api/admin/reports?status=open');
  assert.equal(adminList.json?.total, 2);
  assert.equal(adminList.json?.byStatus.open, 2);
  assert.equal((await admin.get('/api/admin/reports?status=closed')).status, 400);

  const reportId = mediaReport.json!.report.id;
  const resolved = await admin.patch<{ ok: boolean; report: ReportItem & { resolvedBy?: { username: string } | null } }>(
    `/api/admin/reports/${reportId}`,
    { status: 'resolved', notes: 'Handled by the council.' },
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json?.report.status, 'resolved');
  assert.equal(resolved.json?.report.notes, 'Handled by the council.');
  assert.ok(resolved.json?.report.resolvedAt);
  assert.equal(resolved.json?.report.resolvedBy?.username, 'admin');

  const resolvedList = await admin.get<PagedItems<ReportItem>>('/api/admin/reports?status=resolved');
  assert.equal(resolvedList.json?.total, 1);
  assert.equal(resolvedList.json!.items[0].id, reportId);

  const invalidReviews: { body: Record<string, unknown>; status: number }[] = [
    { body: { status: 'closed' }, status: 400 },
    { body: { notes: 'x'.repeat(2001) }, status: 400 },
    { body: { badField: true }, status: 400 },
    { body: {}, status: 400 },
  ];
  for (const entry of invalidReviews) {
    assert.equal((await admin.patch(`/api/admin/reports/${reportId}`, entry.body)).status, entry.status);
  }
  assert.equal((await admin.patch('/api/admin/reports/99999', { status: 'resolved' })).status, 404);
  const afterReview = await other.get<PagedItems<ReportItem>>('/api/requests/reports/mine');
  assert.equal(afterReview.json!.items.find((report) => report.id === reportId)?.status, 'resolved');
});

