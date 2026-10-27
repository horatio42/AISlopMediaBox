#!/usr/bin/env node
/**
 * Screenshot harness for docs. Requires a running, seeded instance.
 *   SLOP_URL=http://localhost:3999 SLOP_USER=admin SLOP_PASSWORD=slop123 node scripts/screenshots.mjs
 * Writes PNGs to docs/screenshots/. No external services.
 *
 * The harness discovers real items from the API: a direct-playable movie, a
 * transcode-only movie, the first show, an album, a smart collection and a
 * playlist. Missing content is skipped with a warning instead of faked.
 *
 * Ingestion: SLOP_INGEST_DEMO=1 generates a tiny inbox under DATA_DIR/ingest and
 * configures its source; SLOP_INGEST_IMDB=1 enables the keyless IMDb toggle for
 * real review candidates; SLOP_INGEST_ONLY=1 captures only the ingestion shots.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.SLOP_URL || 'http://localhost:3999').replace(/\/+$/, '');
const USER = process.env.SLOP_USER || 'admin';
const PASS = process.env.SLOP_PASSWORD || 'slop123';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const INGEST_ONLY = process.env.SLOP_INGEST_ONLY === '1';
const INGEST_DEMO = process.env.SLOP_INGEST_DEMO === '1';
const INGEST_IMDB = process.env.SLOP_INGEST_IMDB === '1';

async function login(context) {
  const response = await context.request.post(`${BASE}/api/auth/login`, {
    data: { username: USER, password: PASS },
    headers: { origin: BASE },
  });
  if (!response.ok()) throw new Error(`Login failed: ${response.status()} ${await response.text()}`);
}

async function api(context, route) {
  const response = await context.request.get(`${BASE}${route}`);
  if (!response.ok()) throw new Error(`GET ${route} -> ${response.status()}`);
  return response.json();
}

/** JSON call that turns a non-2xx response into an error carrying the API code/details. */
async function apiSend(context, method, route, data) {
  const response = await context.request.fetch(`${BASE}${route}`, {
    method,
    data,
    headers: { origin: BASE, 'content-type': 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) {
    const error = new Error(`${method} ${route} -> ${response.status()} ${body?.error?.message || ''}`.trim());
    error.status = response.status();
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }
  return body;
}

function runFfmpeg(args, label) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed while creating ${label}: ${result.stderr || result.status}`);
  }
}

function writeIngestFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const movie = path.join(dir, 'Touch Grass (2022).mp4');
  if (!fs.existsSync(movie)) {
    runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x1f2933:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', movie,
    ], 'Touch Grass fixture');
  }
  fs.writeFileSync(path.join(dir, 'Touch Grass (2022).nfo'), `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Touch Grass</title>
  <originaltitle>Touch Grass</originaltitle>
  <year>2022</year>
  <plot>A shut-in is legally required to touch one blade of grass.</plot>
  <rating>7.9</rating>
  <mpaa>PG-13</mpaa>
  <runtime>2</runtime>
  <genre>Comedy</genre>
  <uniqueid type="tmdb" default="true">999001</uniqueid>
</movie>
`, 'utf8');
  fs.writeFileSync(path.join(dir, 'Touch Grass (2022).en.srt'), `1
00:00:00,000 --> 00:00:01,500
Go outside. It is a trap.

`, 'utf8');
  const poster = path.join(dir, 'poster.jpg');
  if (!fs.existsSync(poster)) {
    runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x245b3a:s=300x450', '-frames:v', '1', poster], 'poster fixture');
  }
  // No year and no NFO: confidence 0.35, so a 0.5 threshold parks it in review.
  const ambiguous = path.join(dir, 'Oppenheimer.mp4');
  if (!fs.existsSync(ambiguous)) fs.copyFileSync(movie, ambiguous);
}

async function findIngestSource(context, dir) {
  const listing = await api(context, '/api/ingest/sources');
  return (listing.items || []).find((source) => path.resolve(source.path) === path.resolve(dir)) || null;
}

/** Deterministic, generated-only inbox for the ingestion screenshots. Never touches real media. */
async function setupIngestShowcase(context) {
  const dataDir = path.resolve(process.env.DATA_DIR || 'data');
  const dir = path.resolve(process.env.SLOP_INGEST_DIR || path.join(dataDir, 'ingest', 'movies'));
  writeIngestFixtures(dir);
  let source = await findIngestSource(context, dir);
  const patch = { action: 'copy', autoMatch: false, minConfidence: 0.5, holdUnmatched: true, recursive: true, settleSeconds: 0, enabled: true };
  if (source) {
    source = (await apiSend(context, 'PATCH', `/api/ingest/sources/${source.id}`, patch)).item;
  } else {
    source = (await apiSend(context, 'POST', '/api/ingest/sources', { name: 'Docs showcase drop', kind: 'movies', path: dir, ...patch })).item;
  }
  if (INGEST_IMDB) await apiSend(context, 'PATCH', '/api/admin/settings', { imdbEnabled: true });
  try {
    await apiSend(context, 'POST', `/api/ingest/sources/${source.id}/scan`, {});
  } catch (error) {
    if (error.code !== 'ingest_in_progress') throw error;
    console.log(`ingest job already running (${error.details?.jobId || 'unknown'}), reusing it`);
  }

  const deadline = Date.now() + 60_000;
  let review = [];
  let organized = [];
  while (Date.now() < deadline) {
    const listing = await api(context, `/api/ingest/items?sourceId=${source.id}&pageSize=50`);
    review = (listing.items || []).filter((item) => item.status === 'review');
    organized = (listing.items || []).filter((item) => item.status === 'organized');
    if (review.length > 0 && organized.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (!review.length) console.warn('⚠ no review item appeared; ingestion screenshot will lack the review queue');
  if (!organized.length) console.warn('⚠ no organized fixture yet; the NFO movie may still be processing');

  const target = review.find((item) => !(item.candidates || []).length) || review[0];
  if (target && INGEST_IMDB) {
    try {
      const result = await apiSend(context, 'POST', `/api/ingest/items/${target.id}/search`, { query: 'Oppenheimer' });
      if (!result.candidates?.length) console.warn('⚠ provider search returned no candidates (offline or provider disabled)');
    } catch (error) {
      console.warn(`⚠ provider search failed: ${error.message}`);
    }
  }
  console.log(`ingest showcase: source #${source.id} ${dir}, ${review.length} review, ${organized.length} organized`);
  return { source, dir, review };
}

async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  const { size } = fs.statSync(file);
  if (size < 30_000) console.warn(`⚠ ${name}.png is only ${Math.round(size / 1024)}KB — check for a blank page`);
  console.log(`captured ${name}.png (${Math.round(size / 1024)}KB)`);
}

async function shotLocator(locator, name) {
  const file = path.join(OUT, `${name}.png`);
  await locator.screenshot({ path: file });
  const { size } = fs.statSync(file);
  if (size < 30_000) console.warn(`⚠ ${name}.png is only ${Math.round(size / 1024)}KB — check for an empty card`);
  console.log(`captured ${name}.png (${Math.round(size / 1024)}KB)`);
}

/** Wait until the SPA shell has mounted a view and finished its loading state. */
async function gotoApp(page, route, { wait = 1000 } = {}) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const view = document.querySelector('#view');
    return Boolean(view) && view.childElementCount > 0 && !view.querySelector('.view-loading');
  }, { timeout: 25_000 });
  await settle(page, wait);
}

async function gotoAdmin(page, section, { wait = 1200 } = {}) {
  await page.goto(`${BASE}/admin#${section}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#adm-main .adm-section', { timeout: 25_000 });
  await page.waitForFunction(() => {
    const main = document.querySelector('#adm-main');
    return Boolean(main) && !main.querySelector('.adm-view-loading') && !main.querySelector('.adm-skeleton');
  }, { timeout: 25_000 });
  await settle(page, wait);
}

/** Pick the first movie where /api/stream/:id/info reports the requested mode. */
async function pickMovie(context, wanted) {
  const data = await api(context, '/api/browse?kind=movies&pageSize=50');
  const candidates = [];
  for (const item of data.items || []) {
    try {
      const info = await api(context, `/api/stream/${item.id}/info`);
      if ((wanted === 'direct' && info.directPlay) || (wanted === 'transcode' && info.directPlay === false)) candidates.push(item);
    } catch {
      /* unplayable rows are skipped */
    }
  }
  // Prefer a clean title with no resume prompt so the player screenshot shows the player.
  return candidates.find((item) => !item.progress) || candidates[0] || null;
}

async function playAndSettle(page, name) {
  await page.waitForSelector('.watch', { timeout: 20_000 });
  await page.waitForSelector('.watch-badge', { timeout: 20_000 });
  // Start playback so the frame is not just a poster behind a big play button.
  const bigPlay = page.locator('.watch-bigplay');
  if (await bigPlay.isVisible().catch(() => false)) await bigPlay.click({ timeout: 5_000 }).catch(() => {});
  await page.evaluate(async () => {
    const video = document.querySelector('video');
    if (video && video.paused) {
      try { await video.play(); } catch { /* autoplay policy */ }
    }
  }).catch(() => {});
  await page.mouse.move(DESKTOP.width / 2, DESKTOP.height - 80);
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video) && video.readyState >= 2 && video.currentTime > 0.4;
  }, { timeout: 25_000 }).catch(() => console.warn(`⚠ ${name}: video did not start, capturing whatever is there`));
  await page.waitForTimeout(900);
  await page.mouse.move(DESKTOP.width / 2, DESKTOP.height - 80);
  await page.waitForTimeout(250);
}

async function captureIngest(page) {
  await gotoAdmin(page, 'ingest', { wait: 1800 });
  await page.waitForSelector('.adm-ingest-source', { timeout: 25_000 }).catch(() => console.warn('⚠ ingestion sources did not render'));
  await shot(page, 'admin-ingest', { fullPage: true });
  const reviewCard = page.locator('.adm-ingest-review').first();
  if ((await reviewCard.count()) === 0) {
    console.warn('skip admin-ingest-review: no review items on this instance');
    return;
  }
  if ((await reviewCard.locator('.adm-ingest-cand').count()) === 0) {
    console.warn('skip admin-ingest-review: review item has no provider candidates');
    return;
  }
  await reviewCard.scrollIntoViewIfNeeded();
  await settle(page, 700);
  await shotLocator(reviewCard, 'admin-ingest-review');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1, colorScheme: 'dark' });
  await login(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  if (INGEST_ONLY) {
    if (INGEST_DEMO) await setupIngestShowcase(context);
    await captureIngest(page);
    await browser.close();
    if (errors.length) console.warn('page errors seen:', [...new Set(errors)].slice(0, 10));
    console.log(`\nScreenshots written to ${OUT}`);
    return;
  }

  const picks = {
    direct: await pickMovie(context, 'direct'),
    transcode: await pickMovie(context, 'transcode'),
    show: (await api(context, '/api/browse?kind=shows&pageSize=1')).items?.[0] || null,
    album: (await api(context, '/api/music/albums?pageSize=1')).items?.[0] || null,
    collection: (await api(context, '/api/collections?pageSize=10')).items?.find((entry) => entry.kind === 'smart') || null,
    playlist: (await api(context, '/api/playlists?pageSize=1')).items?.[0] || null,
  };
  console.log('picked:', Object.fromEntries(Object.entries(picks).map(([key, item]) => [key, item ? `${item.id} ${item.title || item.name}` : 'none'])));

  await gotoApp(page, '/', { wait: 1200 });
  await shot(page, 'home');

  await gotoApp(page, '/browse/movies');
  await shot(page, 'movies');

  await gotoApp(page, '/browse/shows');
  await shot(page, 'shows');

  if (picks.direct) {
    await gotoApp(page, `/item/${picks.direct.id}`, { wait: 1000 });
    await shot(page, 'detail');
  }
  if (picks.show) {
    await gotoApp(page, `/item/${picks.show.id}`, { wait: 1200 });
    await shot(page, 'detail-show');
  }

  // Direct play: browser-native container/codecs, no ffmpeg in the loop.
  if (picks.direct) {
    await gotoApp(page, `/watch/${picks.direct.id}`, { wait: 600 });
    await playAndSettle(page, 'player');
    await shot(page, 'player');
  }

  // Transcode: an MKV (or otherwise non-native) row, streamed as HLS.
  if (picks.transcode) {
    await gotoApp(page, `/watch/${picks.transcode.id}`, { wait: 600 });
    await playAndSettle(page, 'player-transcode');
    await shot(page, 'player-transcode');
  }

  await gotoApp(page, '/music', { wait: 1200 });
  await shot(page, 'music');

  if (picks.album) {
    await gotoApp(page, `/music/albums?album=${picks.album.id}`, { wait: 1400 });
    await page.waitForSelector('.music-sheet', { timeout: 10_000 }).catch(() => {});
    await shot(page, 'music-album');
  }

  await gotoApp(page, '/photos', { wait: 1400 });
  await shot(page, 'photos');

  // Lightbox: open the first tile and show its metadata panel.
  try {
    await page.locator('.photo-tile').first().click({ timeout: 5_000 });
    await page.waitForSelector('.photo-lightbox .plb-img', { timeout: 10_000 });
    await settle(page, 600);
    const info = page.locator('.plb-tool[aria-label="Photo info"]');
    if (await info.isVisible().catch(() => false)) await info.click({ timeout: 3_000 }).catch(() => {});
    await settle(page, 500);
    await shot(page, 'photos-lightbox');
  } catch (error) {
    console.warn(`skip photos-lightbox: ${error.message}`);
  }

  await gotoApp(page, '/collections', { wait: 1000 });
  await shot(page, 'collections');

  if (picks.collection) {
    await gotoApp(page, `/collections/${picks.collection.id}`, { wait: 1000 });
    await shot(page, 'collection-detail');
  }

  await gotoApp(page, '/playlists', { wait: 1000 });
  await shot(page, 'playlists');

  if (picks.playlist) {
    await gotoApp(page, `/playlists/${picks.playlist.id}`, { wait: 1000 });
    await shot(page, 'playlist-detail');
  }

  await gotoApp(page, '/requests', { wait: 1000 });
  await shot(page, 'requests');

  await gotoApp(page, '/profile', { wait: 1000 });
  await shot(page, 'profile');

  await gotoAdmin(page, 'dashboard', { wait: 1400 });
  await shot(page, 'admin-dashboard');
  await gotoAdmin(page, 'libraries');
  await shot(page, 'admin-libraries');
  await gotoAdmin(page, 'media', { wait: 1400 });
  await shot(page, 'admin-media');
  await gotoAdmin(page, 'settings', { wait: 1400 });
  await shot(page, 'admin-settings');
  await gotoAdmin(page, 'jobs', { wait: 1000 });
  await shot(page, 'admin-jobs');
  await gotoAdmin(page, 'privacy', { wait: 1000 });
  await shot(page, 'admin-privacy');

  // TV mode uses the same shell with bigger focus targets; /tv is a real route.
  await page.evaluate(() => localStorage.setItem('slop-tv', '1'));
  await gotoApp(page, '/tv', { wait: 1200 });
  await shot(page, 'home-tv');

  // Mobile home + detail.
  const mobile = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await login(mobile);
  const mobilePage = await mobile.newPage();
  await gotoApp(mobilePage, '/', { wait: 1400 });
  await shot(mobilePage, 'home-mobile');
  if (picks.direct) {
    await gotoApp(mobilePage, `/item/${picks.direct.id}`, { wait: 1000 });
    await shot(mobilePage, 'detail-mobile');
  }

  // Logged-out login page.
  const anon = await browser.newContext({ viewport: DESKTOP, colorScheme: 'dark' });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await anonPage.waitForSelector('.auth-card', { timeout: 15_000 });
  await settle(anonPage, 900);
  await shot(anonPage, 'login');

  // Ingest last: an optional demo inbox adds media and should not perturb the gallery above.
  if (INGEST_DEMO) await setupIngestShowcase(context);
  await captureIngest(page);

  await browser.close();
  if (errors.length) console.warn('page errors seen:', [...new Set(errors)].slice(0, 10));
  console.log(`\nScreenshots written to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
