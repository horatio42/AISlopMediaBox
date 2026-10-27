import { after, before, test } from 'node:test';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  Client,
  USER_PASSWORD,
  adminClient,
  assert,
  startServer,
} from './helpers.ts';
import type { LoginResponse, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MeBody {
  authenticated: boolean;
  allowSignups?: boolean;
  serverName?: string;
  user?: { id: number; username: string; role: string; displayName: string; hasPin?: boolean; activeSessions?: number };
}

interface BrandingBody {
  serverName: string;
  tagline: string;
  accent: string;
  memes: boolean;
  allowSignups: boolean;
  requireInvite: boolean;
  allowRequests: boolean;
  allowParties: boolean;
  maintenanceMode: boolean;
  version: string;
  demoMode: boolean;
}

interface SessionsBody {
  items: { id: string; current: boolean; createdAt: string; expiresAt: string; userAgent: string; ip: string }[];
}

interface RegisterBody {
  ok: boolean;
  user: { id: number; username: string; role: string };
}

interface InviteCheckBody {
  valid: boolean;
}

interface InviteBody {
  ok: boolean;
  invite: { id: string; code: string; role: string; valid: boolean; expiresAt: string | null };
}

interface InviteListBody {
  items: { id: string; code: string; role: string; usedBy: { username: string } | null; valid: boolean }[];
  total: number;
}

let server: StartedServer;
let admin: Client;
let manager: Client | null = null;
let regularUser: Client;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
});

after(async () => {
  await server.stop();
});

test('health is public, reports the database, and survives no session', async () => {
  const response = await new Client(server.baseUrl, 'anon').get('/api/health');
  assert.equal(response.status, 200);
  assert.match(response.contentType, /application\/json/);
  const health = response.json as {
    ok: boolean;
    name: string;
    version: string;
    env: string;
    db: boolean;
    maintenance: boolean;
    uptimeSeconds: number;
    node: string;
  };
  assert.equal(health.ok, true);
  assert.equal(health.name, 'AISlopMediaBox');
  assert.equal(health.version, '1.0.0');
  assert.equal(health.env, 'test');
  assert.equal(health.db, true);
  assert.equal(health.maintenance, false);
  assert.equal(typeof health.uptimeSeconds, 'number');
  assert.ok(health.uptimeSeconds >= 0);
  assert.match(health.node, /^v24\./);
});

test('security headers are applied to API and HTML responses', async () => {
  for (const target of ['/api/health', '/login', '/admin']) {
    const response = await fetch(`${server.baseUrl}${target}`);
    assert.equal(response.status, 200, `${target} did not respond`);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
    assert.equal(response.headers.get('x-powered-by'), null);
    if (target.startsWith('/api/')) assert.equal(response.headers.get('cache-control'), 'no-store');
    else assert.equal(response.headers.get('cache-control'), 'public, max-age=0');
  }
});

test('branding exposes safe defaults without authentication', async () => {
  const response = await new Client(server.baseUrl, 'anon-branding').get('/api/branding');
  assert.equal(response.status, 200);
  const branding = response.json as BrandingBody;
  assert.equal(branding.serverName, 'AISlopMediaBox');
  assert.equal(branding.tagline, 'Certified fresh slop, served locally.');
  assert.equal(branding.accent, 'slop');
  assert.equal(branding.memes, true);
  assert.equal(branding.allowSignups, false);
  assert.equal(branding.requireInvite, true);
  assert.equal(branding.allowRequests, true);
  assert.equal(branding.allowParties, true);
  assert.equal(branding.maintenanceMode, false);
  assert.equal(branding.version, '1.0.0');
  assert.equal(branding.demoMode, false);
});

test('unknown API and static routes fail honestly', async () => {
  const anon = new Client(server.baseUrl, 'anon-404');
  const api = await anon.get('/api/definitely-not-a-route');
  assert.equal(api.status, 404);
  const apiError = api.json as ErrorBody;
  assert.equal(apiError.error.code, 'not_found');
  assert.match(apiError.error.message, /No route for GET \/api\/definitely-not-a-route/);

  const asset = await anon.get('/nope/missing-asset.js');
  assert.equal(asset.status, 404);
  assert.match(asset.text, /404/);
  assert.match(asset.text, /skill issue/);

  const spa = await anon.get('/some/spa/route');
  assert.equal(spa.status, 200);
  assert.match(spa.contentType, /text\/html/);
});

test('malformed JSON is rejected with a JSON error envelope', async () => {
  const anon = new Client(server.baseUrl, 'anon-json');
  const response = await anon.post('/api/auth/login', undefined, {
    body: '{"username": "admin", ',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 400);
  const error = response.json as ErrorBody;
  assert.ok(error && error.error, `expected JSON error envelope, got: ${response.text}`);
  assert.equal(error.error.code, 'invalid_json');
  assert.equal(typeof error.error.message, 'string');
});

test('unauthenticated API access is 401 with the standard envelope', async () => {
  const anon = new Client(server.baseUrl, 'anon-api');
  for (const path of [
    '/api/browse',
    '/api/libraries',
    '/api/collections',
    '/api/jobs/active',
    '/api/admin/overview',
    '/api/media/1',
    '/api/stream/1/info',
    '/api/art/1/poster',
    '/api/progress/stats',
    '/api/users/me',
  ]) {
    const response = await anon.get(path);
    assert.equal(response.status, 401, `${path} should require auth`);
    const error = response.json as ErrorBody;
    assert.equal(error.error.code, 'unauthorized', `${path} error code`);
  }
});

test('login rejects bad credentials and missing fields without leaking which failed', async () => {
  const anon = new Client(server.baseUrl, 'anon-login');
  const wrong = await anon.login('admin', 'definitely-not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal((wrong.json as LoginResponse).error?.code, 'invalid_credentials');
  assert.match((wrong.json as LoginResponse).error?.message ?? '', /Wrong credentials/);

  const missing = await anon.post('/api/auth/login', { username: 'admin' });
  assert.equal(missing.status, 400);
  assert.equal((missing.json as LoginResponse).error?.code, 'bad_request');
});

test('session cookie is HttpOnly, Strict, persistent, and actually authenticates', async () => {
  const response = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const login = (await response.json()) as LoginResponse;
  assert.equal(login.ok, true);
  assert.equal(login.user?.username, 'admin');
  assert.equal(login.user?.role, 'admin');

  const rawCookies = response.headers.getSetCookie();
  assert.equal(rawCookies.length, 1);
  const raw = rawCookies[0];
  assert.match(raw, /^slop_session=[A-Za-z0-9_-]+/);
  assert.match(raw, /Path=\//);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Max-Age=2592000/);
  assert.doesNotMatch(raw, /Secure/);

  const value = /^slop_session=([^;]+)/.exec(raw)?.[1] ?? '';
  const client = new Client(server.baseUrl, 'cookie-session');
  client.cookies.set('slop_session', value);

  const me = await client.get<MeBody>('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json?.authenticated, true);
  assert.equal(me.json?.user?.username, 'admin');
  assert.equal(me.json?.user?.hasPin, false);
  assert.ok((me.json?.user?.activeSessions ?? 0) >= 1);
  assert.equal(me.json?.serverName, 'AISlopMediaBox');
});

test('logout destroys the session server-side and clears the cookie', async () => {
  const client = new Client(server.baseUrl, 'logout');
  const login = await client.login(ADMIN_USER, ADMIN_PASSWORD);
  assert.equal(login.status, 200);
  assert.ok(client.cookies.has('slop_session'));

  const logout = await client.post('/api/auth/logout', {});
  assert.equal(logout.status, 200);
  assert.equal((logout.json as { ok: boolean }).ok, true);
  assert.equal(client.cookies.has('slop_session'), false);

  const me = await client.get<MeBody>('/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.json?.authenticated, false);
  assert.equal(me.json?.allowSignups, false);
  assert.equal(me.json?.serverName, 'AISlopMediaBox');

  // A stale cookie value must not resurrect the session.
  const stale = new Client(server.baseUrl, 'stale');
  stale.cookies.set('slop_session', 'not-a-real-session-token');
  const staleMe = await stale.get('/api/auth/me');
  assert.equal(staleMe.status, 401);
});

test('sessions can be listed and revoked, but only by their owner', async () => {
  const second = new Client(server.baseUrl, 'admin-second');
  await second.loginOk(ADMIN_USER, ADMIN_PASSWORD);

  const list = await admin.get<SessionsBody>('/api/auth/sessions');
  assert.equal(list.status, 200);
  const items = list.json?.items ?? [];
  assert.ok(items.length >= 2);
  assert.equal(items.filter((item) => item.current).length, 1);
  const current = items.find((item) => item.current);
  assert.ok(current);
  const other = items.find((item) => !item.current);
  assert.ok(other);
  assert.match(other.id, /^[A-Za-z0-9_-]+$/);
  assert.ok(Date.parse(other.expiresAt) > Date.now());
  assert.equal(typeof other.ip, 'string');

  const revoked = await admin.del(`/api/auth/sessions/${other.id}`);
  assert.equal(revoked.status, 200);
  assert.equal((await second.get('/api/auth/me')).status, 401);

  const bogus = await admin.del('/api/auth/sessions/does-not-exist');
  assert.equal(bogus.status, 404);
  assert.equal((bogus.json as ErrorBody).error.code, 'not_found');

  // The admin is not allowed to revoke a session it does not own (even for a real user).
  const sessionsAgain = await admin.get<SessionsBody>('/api/auth/sessions');
  assert.equal(sessionsAgain.json?.items.filter((item) => item.current).length, 1);
  assert.ok((sessionsAgain.json?.items.length ?? 0) >= 1);
  assert.ok(!sessionsAgain.json!.items.some((item) => item.id === other.id));
});

test('PIN flow gates login without invalidating the existing session', async () => {
  const invalid = await admin.post('/api/auth/pin', { pin: 'abc' });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.json as ErrorBody).error.code, 'bad_request');

  const set = await admin.post('/api/auth/pin', { pin: '1234' });
  assert.equal(set.status, 200);
  assert.equal((set.json as { ok: boolean; hasPin: boolean }).hasPin, true);

  // Existing sessions stay valid — the PIN is a soft profile lock for shared TVs.
  const me = await admin.get<MeBody>('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json?.user?.hasPin, true);

  const noPin = new Client(server.baseUrl, 'pin-missing');
  const missing = await noPin.login(ADMIN_USER, ADMIN_PASSWORD);
  assert.equal(missing.status, 401);
  assert.equal((missing.json as LoginResponse).error?.code, 'pin_required');

  const wrongPin = await new Client(server.baseUrl, 'pin-wrong').login(ADMIN_USER, ADMIN_PASSWORD, '9999');
  assert.equal(wrongPin.status, 401);
  assert.equal((wrongPin.json as LoginResponse).error?.code, 'pin_required');

  const pinClient = new Client(server.baseUrl, 'pin-ok');
  const correct = await pinClient.login(ADMIN_USER, ADMIN_PASSWORD, '1234');
  assert.equal(correct.status, 200);
  assert.equal((correct.json as LoginResponse).ok, true);

  const clear = await admin.post('/api/auth/pin', { pin: null });
  assert.equal(clear.status, 200);
  assert.equal((clear.json as { hasPin: boolean }).hasPin, false);
  assert.equal((await pinClient.get<MeBody>('/api/auth/me')).json?.user?.hasPin, false);
});

test('registration respects signup and invite gates, then consumes the invite', async () => {
  const closed = await new Client(server.baseUrl, 'register-closed').post('/api/auth/register', {
    username: 'closed-user',
    password: 'password123',
  });
  assert.equal(closed.status, 403);
  assert.equal((closed.json as ErrorBody).error.code, 'signups_closed');

  const enable = await admin.patch('/api/admin/settings', { allowSignups: true, requireInvite: true });
  assert.equal(enable.status, 200);
  assert.equal(enable.headers.get('cache-control'), 'no-store');

  const noInvite = await new Client(server.baseUrl, 'register-no-invite').post('/api/auth/register', {
    username: 'invite-less',
    password: 'password123',
  });
  assert.equal(noInvite.status, 403);
  assert.equal((noInvite.json as ErrorBody).error.code, 'invite_required');

  const badInvite = await new Client(server.baseUrl, 'register-bad-invite').post('/api/auth/register', {
    username: 'bad-invite',
    password: 'password123',
    invite: 'NOTAREALCODE',
  });
  assert.equal(badInvite.status, 403);
  assert.equal((badInvite.json as ErrorBody).error.code, 'invite_invalid');

  const issued = await admin.post<InviteBody>('/api/admin/invites', { role: 'manager', ttlHours: 1 });
  assert.equal(issued.status, 201);
  assert.equal(issued.json?.invite.role, 'manager');
  assert.equal(issued.json?.invite.valid, true);
  assert.match(issued.json?.invite.code ?? '', /^[A-Z0-9]{12}$/);
  const code = issued.json!.invite.code;

  const check = await new Client(server.baseUrl, 'invite-check').get<InviteCheckBody>(`/api/auth/invites/check/${code}`);
  assert.equal(check.status, 200);
  assert.equal(check.json?.valid, true);
  const checkBad = await new Client(server.baseUrl, 'invite-check-bad').get<InviteCheckBody>('/api/auth/invites/check/nope');
  assert.equal(checkBad.json?.valid, false);

  manager = new Client(server.baseUrl, 'registered-manager');
  const registered = await manager.post<RegisterBody>('/api/auth/register', {
    username: 'invited_manager',
    password: 'managerpass1',
    displayName: 'Invited Curator',
    invite: code,
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.json?.ok, true);
  assert.equal(registered.json?.user.role, 'manager');
  assert.ok(manager.cookies.has('slop_session'));

  const reuse = await new Client(server.baseUrl, 'invite-reuse').post('/api/auth/register', {
    username: 'invite_reuser',
    password: 'password123',
    invite: code,
  });
  assert.equal(reuse.status, 403);
  assert.equal((reuse.json as ErrorBody).error.code, 'invite_invalid');

  const checkUsed = await new Client(server.baseUrl, 'invite-check-used').get<InviteCheckBody>(`/api/auth/invites/check/${code}`);
  assert.equal(checkUsed.json?.valid, false);

  const invites = await admin.get<InviteListBody>('/api/admin/invites');
  const invite = invites.json?.items.find((item) => item.code === code);
  assert.ok(invite);
  assert.equal(invite.valid, false);
  assert.equal(invite.usedBy?.username, 'invited_manager');
});

test('role gates separate users, managers, and admins', async () => {
  assert.ok(manager, 'registration test must run first');

  const created = await admin.post('/api/admin/users', { username: 'plain_user', password: USER_PASSWORD, role: 'user' });
  assert.equal(created.status, 201);
  regularUser = new Client(server.baseUrl, 'plain-user');
  await regularUser.loginOk('plain_user', USER_PASSWORD);

  const folderPath = encodeURIComponent(server.mediaDir);
  const adminFolders = await admin.get(`/api/libraries/folders?path=${folderPath}`);
  assert.equal(adminFolders.status, 200);
  assert.equal((adminFolders.json as { path: string }).path, server.mediaDir);

  const managerFolders = await manager.get(`/api/libraries/folders?path=${folderPath}`);
  assert.equal(managerFolders.status, 200);
  assert.equal((managerFolders.json as { path: string }).path, server.mediaDir);

  const userFolders = await regularUser.get(`/api/libraries/folders?path=${folderPath}`);
  assert.equal(userFolders.status, 403);
  assert.equal((userFolders.json as ErrorBody).error.code, 'forbidden');

  const userCreate = await regularUser.post('/api/libraries', { name: 'nope', kind: 'movies', path: server.mediaDir });
  assert.equal(userCreate.status, 403);

  const managerList = await manager.get('/api/jobs');
  assert.equal(managerList.status, 200);
  const userJobs = await regularUser.get('/api/jobs');
  assert.equal(userJobs.status, 403);

  assert.equal((await regularUser.get('/api/admin/overview')).status, 403);
  assert.equal((await manager.get('/api/admin/overview')).status, 403);
  assert.equal((await admin.get('/api/admin/overview')).status, 200);

  // Manager sessions are not visible to the admin's session endpoints (ownership check).
  const managerSessions = await manager.get<SessionsBody>('/api/auth/sessions');
  const managerSessionId = managerSessions.json?.items[0]?.id;
  assert.ok(managerSessionId);
  const crossDelete = await admin.del(`/api/auth/sessions/${managerSessionId}`);
  assert.equal(crossDelete.status, 404);
});

test('cross-origin mutations are blocked by the CSRF guard', async () => {
  const evil = await admin.request('POST', '/api/auth/logout', {
    json: {},
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(evil.status, 403);
  assert.equal((evil.json as ErrorBody).error.code, 'csrf');
  assert.match((evil.json as ErrorBody).error.message, /Cross-origin/);

  // The blocked request must not have destroyed the admin session.
  assert.equal((await admin.get<MeBody>('/api/auth/me')).status, 200);

  assert.ok(manager, 'registration test must run first');
  const sameOrigin = await manager.request('POST', '/api/auth/logout', {
    json: {},
    headers: { Origin: server.baseUrl },
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal((await manager.get<MeBody>('/api/auth/me')).status, 401);
  manager = null;
});

test('login rate limiting returns 429 with Retry-After and a stable shape', async () => {
  const client = new Client(server.baseUrl, 'rate-limit');
  let limited = await client.login('admin', 'wrong-password');
  const deadline = Date.now() + 1000;
  // The limiter budget is shared per IP across this file; step into it deterministically.
  while (limited.status !== 429 && Date.now() < deadline) {
    limited = await client.login('admin', 'still-wrong');
  }
  assert.equal(limited.status, 429);
  assert.equal((limited.json as ErrorBody).error.code, 'rate_limited');
  assert.match((limited.json as ErrorBody).error.message, /Touch grass/);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter));
  assert.ok(retryAfter > 0 && retryAfter <= 300);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
});
