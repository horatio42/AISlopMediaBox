#!/usr/bin/env node
/**
 * AISlopMediaBox demo seeder.
 *
 * 1. Synthesizes (or reuses) the demo library via scripts/demo-content.mjs.
 * 2. Ensures Movies / Shows / Music / Photos libraries exist in the DB.
 * 3. If the server is reachable (SEED_URL or http://127.0.0.1:$PORT), logs in
 *    with the admin credentials and requests a scan for each library.
 *
 * Idempotent: libraries are matched by path, fixtures are manifest-gated.
 *
 * Usage: npm run seed   (or node scripts/seed.ts)
 * Env:   DATA_DIR, MEDIA_DIR, PORT, SEED_URL, ADMIN_USER, ADMIN_PASSWORD
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { openDatabase } from '../src/db.ts';

const SESSION_COOKIE = 'slop_session';

interface LibrarySpec {
  name: string;
  kind: 'movies' | 'shows' | 'music' | 'photos';
  dir: string;
  blurb: string;
}

interface LibraryRow {
  id: number;
  name: string;
  kind: string;
  path: string;
  created: boolean;
}

function parseFlags(argv: string[]): { help: boolean; skipScan: boolean; forceContent: boolean } {
  const flags = { help: false, skipScan: false, forceContent: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--no-scan') flags.skipScan = true;
    else if (arg === '--force-content') flags.forceContent = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

function log(message: string): void {
  console.log(`[seed] ${message}`);
}

function fail(message: string): never {
  console.error(`[seed] ERROR: ${message}`);
  process.exit(1);
}

function generateDemoContent(force: boolean): void {
  const generator = path.resolve(import.meta.dirname, 'demo-content.mjs');
  if (!fs.existsSync(generator)) fail(`Demo generator missing at ${generator}`);
  log('checking demo fixtures (ffmpeg synthesis is cached by manifest)');
  const args = [generator];
  if (force) args.push('--force');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) fail(`Could not run demo generator: ${result.error.message}`);
  if (result.status !== 0) fail(`Demo generator exited ${result.status ?? 'unknown'}`);
}

function ensureLibraries(): LibraryRow[] {
  const db = openDatabase();
  const specs: LibrarySpec[] = [
    { name: 'Movies', kind: 'movies', dir: path.join(config.mediaDir, 'movies'), blurb: 'certified cinema' },
    { name: 'Shows', kind: 'shows', dir: path.join(config.mediaDir, 'shows'), blurb: 'peak television' },
    { name: 'Music', kind: 'music', dir: path.join(config.mediaDir, 'music'), blurb: 'certified bangers' },
    { name: 'Photos', kind: 'photos', dir: path.join(config.mediaDir, 'photos'), blurb: 'touch grass' },
  ];

  const findStmt = db.prepare('SELECT id, name, kind, path FROM libraries WHERE path = ?');
  const insertStmt = db.prepare(
    `INSERT INTO libraries(name, kind, path, scan_schedule, settings, created_at, updated_at)
     VALUES(?, ?, ?, 'manual', '{}', ?, ?)`,
  );
  const rows: LibraryRow[] = [];
  const timestamp = new Date().toISOString();

  for (const spec of specs) {
    if (!fs.existsSync(spec.dir) || !fs.statSync(spec.dir).isDirectory()) {
      fail(`Expected media folder at ${spec.dir}. The generator should have created it.`);
    }
    const existing = findStmt.get(spec.dir) as Omit<LibraryRow, 'created'> | undefined;
    if (existing) {
      log(`library exists: ${existing.name} #${existing.id} (${existing.path})`);
      rows.push({ ...existing, created: false });
      continue;
    }
    const info = insertStmt.run(spec.name, spec.kind, spec.dir, timestamp, timestamp);
    const id = Number(info.lastInsertRowid);
    log(`created library: ${spec.name} #${id} — ${spec.blurb}`);
    rows.push({ id, name: spec.name, kind: spec.kind, path: spec.dir, created: true });
  }
  return rows;
}

async function probeServer(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

async function loginCookie(base: string): Promise<string | null> {
  const username = process.env.ADMIN_USER || config.adminUser;
  const password = process.env.ADMIN_PASSWORD || config.adminPassword;
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log(`login as "${username}" failed: HTTP ${res.status}. Scans skipped, fixtures are still fine.`);
      return null;
    }
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const session = cookies.map((cookie) => cookie.split(';')[0]).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    if (!session) {
      log('login succeeded but no session cookie came back. Scans skipped.');
      return null;
    }
    return session;
  } catch (error) {
    log(`login request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface ScanOutcome {
  id: number;
  name: string;
  ok: boolean;
  jobId?: string;
  detail: string;
}

async function requestScan(base: string, cookie: string, library: LibraryRow): Promise<ScanOutcome> {
  try {
    const res = await fetch(`${base}/api/libraries/${library.id}/scan`, {
      method: 'POST',
      headers: { cookie },
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: { message?: string } };
    if (!res.ok) {
      return { id: library.id, name: library.name, ok: false, detail: `HTTP ${res.status}: ${body.error?.message || 'scan rejected'}` };
    }
    return {
      id: library.id,
      name: library.name,
      ok: true,
      jobId: body.jobId,
      detail: body.jobId ? `scan job ${body.jobId}` : 'scan accepted',
    };
  } catch (error) {
    return { id: library.id, name: library.name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function printGuidance(libraries: LibraryRow[], heading = 'Next steps (server not detected — no shame, start it when ready):'): void {
  const base = process.env.SEED_URL?.replace(/\/+$/, '') || `http://localhost:${config.port}`;
  let port = config.port;
  try {
    const parsed = new URL(base);
    if (parsed.port) port = Number(parsed.port);
  } catch {
    /* keep config.port when SEED_URL is not a URL */
  }
  log('');
  log(heading);
  log(`  1. DATA_DIR=${config.dataDir} PORT=${port} npm run dev`);
  log('  2. Log in and scan, either in the UI (Admin → Libraries → Scan all) or:');
  log(`     curl -c /tmp/slop.cookies -H 'content-type: application/json' \\`);
  log(`       -d '{"username":"${process.env.ADMIN_USER || config.adminUser}","password":"..."}' \\`);
  log(`       ${base}/api/auth/login`);
  for (const library of libraries) {
    log(`     curl -b /tmp/slop.cookies -X POST ${base}/api/libraries/${library.id}/scan`);
  }
  log('  3. Or rerun with scans: SEED_URL=' + base + ' npm run seed');
  log('');
  log('No thoughts, head empty. Everything is local.');
}

function printLibraryTable(libraries: LibraryRow[]): void {
  log('libraries:');
  for (const library of libraries) {
    log(`  #${library.id}  ${library.name.padEnd(7)} ${library.kind.padEnd(7)} ${library.created ? 'created' : 'exists '}  ${library.path}`);
  }
}

async function triggerScans(libraries: LibraryRow[]): Promise<void> {
  const explicit = process.env.SEED_URL;
  const base = (explicit || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '');
  const reachable = await probeServer(base);
  if (!reachable) {
    if (explicit) log(`SEED_URL=${base} did not answer /api/health. Fixtures and libraries are ready anyway.`);
    printGuidance(libraries);
    return;
  }
  log(`server detected at ${base}, requesting scans`);
  const cookie = await loginCookie(base);
  if (!cookie) {
    printGuidance(libraries, 'Next steps (server is up, but admin login failed — check ADMIN_USER / ADMIN_PASSWORD):');
    return;
  }
  const outcomes = await Promise.all(libraries.map((library) => requestScan(base, cookie, library)));
  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) log(`scan queued for ${outcome.name} #${outcome.id}: ${outcome.detail}`);
    else {
      failures += 1;
      log(`scan failed for ${outcome.name} #${outcome.id}: ${outcome.detail}`);
    }
  }
  if (failures > 0) {
    log('Some scans were rejected — if the scanner is still booting, retry in a moment or use the admin UI.');
    printGuidance(libraries, 'Next steps (server is up, but the scan endpoint rejected the request):');
    return;
  }
  log('');
  log('Watch the job queue at /api/jobs?status=running or open /admin → Jobs.');
  log('Then go outside. Or watch a 41-second film about a microwave manual. Balance.');
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log('Usage: node scripts/seed.ts [--no-scan] [--force-content]');
    console.log('Env: DATA_DIR, MEDIA_DIR, PORT (default 3100), SEED_URL, ADMIN_USER, ADMIN_PASSWORD');
    return;
  }

  log(`data dir: ${config.dataDir}`);
  log(`media dir: ${config.mediaDir}`);
  generateDemoContent(flags.forceContent);
  const libraries = ensureLibraries();
  printLibraryTable(libraries);

  if (flags.skipScan) {
    log('--no-scan passed; libraries are ready, scans are yours to trigger.');
    printGuidance(libraries, 'Next steps (scans skipped for this run):');
    return;
  }
  await triggerScans(libraries);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
