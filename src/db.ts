import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config, ensureDataDirs, paths } from './config.ts';
import { hashPassword } from './lib/passwords.ts';
import type { SiteSettings } from './types.ts';

export type DB = Database.Database;

let db: DB | null = null;

export const DEFAULT_SETTINGS: SiteSettings = {
  serverName: 'AISlopMediaBox',
  tagline: 'Certified fresh slop, served locally.',
  accent: 'slop',
  allowSignups: false,
  requireInvite: true,
  tmdbApiKey: '',
  tvdbApiKey: '',
  omdbApiKey: '',
  tvmazeEnabled: false,
  imdbEnabled: false,
  ingestWatch: true,
  ingestIntervalSeconds: 30,
  transcodeEnabled: true,
  subtitleBurnIn: false,
  maxTranscodeHeight: config.maxTranscodeHeight,
  transcodePreset: config.transcodePreset,
  hwAccel: config.transcodeHwAccel,
  hwAccelDevice: config.transcodeHwAccelDevice,
  hwAccelDecode: true,
  transcodeThrottleSeconds: config.transcodeThrottleSeconds,
  scanOnStart: true,
  autoMatch: true,
  generateArt: true,
  allowRequests: true,
  allowParties: true,
  maintenanceMode: false,
  memes: true,
  telemetry: false,
};

export function nowISO(): string {
  return new Date().toISOString();
}

export function openDatabase(): DB {
  if (db) return db;
  ensureDataDirs();
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(paths.schema, 'utf8'));
  bootstrap();
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error('Database not opened yet');
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

function bootstrap(): void {
  const d = db;
  if (!d) return;
  const timestamp = nowISO();
  const schemaVersion = '1';
  const existing = d.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  if (!existing) d.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', schemaVersion);
  d.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', ?)").run(timestamp);

  const count = (d.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count === 0) {
    d.prepare(
      `INSERT INTO users(username, display_name, password_hash, role, avatar_hue, created_at)
       VALUES(?, ?, ?, 'admin', 280, ?)`,
    ).run(config.adminUser, 'Head Slopmaster', hashPassword(config.adminPassword), timestamp);
  }

  const defaults = DEFAULT_SETTINGS;
  const settingsStmt = d.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  for (const [key, value] of Object.entries(defaults)) {
    settingsStmt.run(key, JSON.stringify(value));
  }
}

export class SettingsStore {
  private cache = new Map<string, unknown>();

  get<K extends keyof SiteSettings>(key: K): SiteSettings[K] {
    if (this.cache.has(key)) return this.cache.get(key) as SiteSettings[K];
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    const fallback = DEFAULT_SETTINGS[key];
    const value = row ? (JSON.parse(row.value) as SiteSettings[K]) : fallback;
    this.cache.set(key, value);
    return value;
  }

  all(): SiteSettings {
    const result = { ...DEFAULT_SETTINGS };
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const row of rows) {
      if (row.key in result) {
        try {
          (result as Record<string, unknown>)[row.key] = JSON.parse(row.value);
        } catch {
          /* keep default when a setting is corrupt */
        }
      }
    }
    return result;
  }

  set<K extends keyof SiteSettings>(key: K, value: SiteSettings[K]): void {
    getDb()
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
    this.cache.set(key, value);
  }

  setMany(patch: Partial<SiteSettings>): void {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      this.set(key as keyof SiteSettings, value as never);
    }
  }
}

export const settings = new SettingsStore();
