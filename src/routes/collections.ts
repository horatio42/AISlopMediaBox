import { Router } from 'express';
import type { Request } from 'express';
import { getDb, nowISO } from '../db.ts';
import { HttpError, pageParams, sendPage } from '../lib/http.ts';
import { artUrl, mediaRowsToDTO } from '../lib/dto.ts';
import type { ArtDTO, ArtKind, CollectionDTO, CollectionRow, MediaDTO, MediaKind, MediaRow } from '../types.ts';

export const collectionsRouter = Router();

type RuleOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
type RuleField = 'kind' | 'genre' | 'year' | 'rating' | 'libraryId' | 'addedWithinDays' | 'tag' | 'person' | 'titleContains';

export interface SmartRule {
  field: RuleField;
  op: RuleOp;
  value: string | number | (string | number)[];
}

export interface SmartRules {
  match: 'all' | 'any';
  rules: SmartRule[];
}

export interface EvaluateOptions {
  userId?: number;
  limit?: number;
  includeChildren?: boolean;
}

const MEDIA_KINDS: Record<MediaKind, true> = {
  movie: true,
  show: true,
  season: true,
  episode: true,
  artist: true,
  album: true,
  track: true,
  photo: true,
  video: true,
};

const TOP_LEVEL_KINDS: MediaKind[] = ['movie', 'show', 'artist', 'album', 'photo', 'video'];
/** Child rows (seasons/episodes/tracks) are noisy; only explicit, unambiguous rules may surface them. */
const CHILD_KINDS: Record<'season' | 'episode' | 'track', true> = { season: true, episode: true, track: true };
const MAX_RESULTS = 500;
const MAX_RULES = 20;

/** Operators each field accepts. Anything else is a 400, never a silently ignored rule. */
const FIELD_OPS: Record<RuleField, RuleOp[]> = {
  kind: ['eq', 'neq', 'in'],
  genre: ['eq', 'neq', 'in', 'contains'],
  tag: ['eq', 'neq', 'in', 'contains'],
  person: ['eq', 'neq', 'contains'],
  year: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'],
  rating: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  libraryId: ['eq', 'neq', 'in'],
  addedWithinDays: ['eq', 'lt', 'lte', 'gt', 'gte'],
  titleContains: ['eq', 'contains'],
};

function isRuleField(value: string): value is RuleField {
  return value in FIELD_OPS;
}

function isRuleOp(value: string): value is RuleOp {
  return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'].includes(value);
}

function scalarValue(field: RuleField, raw: unknown): string | number {
  switch (field) {
    case 'kind': {
      if (typeof raw !== 'string' || !(raw in MEDIA_KINDS)) {
        throw new HttpError(400, `Rule kind must be one of: ${Object.keys(MEDIA_KINDS).join(', ')}.`, 'invalid_rules');
      }
      return raw;
    }
    case 'genre':
    case 'tag':
    case 'person':
    case 'titleContains': {
      if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 200) {
        throw new HttpError(400, `${field} rules need a non-empty string (max 200 chars).`, 'invalid_rules');
      }
      return raw.trim();
    }
    case 'year': {
      const value = typeof raw === 'number' ? raw : NaN;
      if (!Number.isInteger(value) || value < 1800 || value > 2200) {
        throw new HttpError(400, 'year rules need an integer between 1800 and 2200.', 'invalid_rules');
      }
      return value;
    }
    case 'rating': {
      const value = typeof raw === 'number' ? raw : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 10) {
        throw new HttpError(400, 'rating rules need a number between 0 and 10.', 'invalid_rules');
      }
      return value;
    }
    case 'libraryId': {
      const value = typeof raw === 'number' ? raw : NaN;
      if (!Number.isInteger(value) || value <= 0) {
        throw new HttpError(400, 'libraryId rules need a positive integer.', 'invalid_rules');
      }
      return value;
    }
    case 'addedWithinDays': {
      const value = typeof raw === 'number' ? raw : NaN;
      if (!Number.isInteger(value) || value < 0 || value > 3650) {
        throw new HttpError(400, 'addedWithinDays rules need an integer between 0 and 3650.', 'invalid_rules');
      }
      return value;
    }
  }
}

/** Validate + normalize a rules payload. Throws HttpError(400, 'invalid_rules'). */
export function validateSmartRules(input: unknown): SmartRules {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Smart rules must be an object: { match, rules }.', 'invalid_rules');
  }
  const record = Object.fromEntries(Object.entries(input as Record<string, unknown>));
  const match = record.match === undefined ? 'all' : record.match;
  if (match !== 'all' && match !== 'any') {
    throw new HttpError(400, "match must be 'all' or 'any'.", 'invalid_rules');
  }
  const rawRules = record.rules;
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new HttpError(400, 'Smart collections need at least one rule.', 'invalid_rules');
  }
  if (rawRules.length > MAX_RULES) {
    throw new HttpError(400, `At most ${MAX_RULES} rules. Rules are seasoning, not the meal.`, 'invalid_rules');
  }

  const rules: SmartRule[] = [];
  for (const raw of rawRules) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'Each rule needs { field, op, value }.', 'invalid_rules');
    }
    const rule = Object.fromEntries(Object.entries(raw as Record<string, unknown>));
    const field = typeof rule.field === 'string' ? rule.field : '';
    const op = typeof rule.op === 'string' ? rule.op : '';
    if (!isRuleField(field)) {
      throw new HttpError(400, `Unknown rule field: ${field || '(missing)'}.`, 'invalid_rules', { fields: Object.keys(FIELD_OPS) });
    }
    if (!isRuleOp(op) || !FIELD_OPS[field].includes(op)) {
      throw new HttpError(400, `Operator ${op || '(missing)'} is not allowed for ${field}.`, 'invalid_rules', {
        allowed: FIELD_OPS[field],
      });
    }
    if (rule.value === undefined) throw new HttpError(400, `Rule on ${field} is missing a value.`, 'invalid_rules');

    if (op === 'in') {
      if (!Array.isArray(rule.value) || rule.value.length === 0 || rule.value.length > 50) {
        throw new HttpError(400, `'in' rules on ${field} need an array of 1-50 values.`, 'invalid_rules');
      }
      rules.push({ field, op, value: rule.value.map((entry) => scalarValue(field, entry)) });
    } else {
      rules.push({ field, op, value: scalarValue(field, rule.value) });
    }
  }
  return { match, rules };
}

function parseStoredRules(raw: string): SmartRules | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return validateSmartRules(parsed);
  } catch {
    return null;
  }
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function comparison(op: RuleOp): string {
  switch (op) {
    case 'eq':
      return '=';
    case 'neq':
      return '!=';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
    default:
      throw new HttpError(400, `Operator ${op} is not a comparison.`, 'invalid_rules');
  }
}

function existsClause(table: string, column: string, op: RuleOp, value: unknown, params: unknown[]): string {
  if (op === 'in') {
    const list = value as (string | number)[];
    params.push(...list);
    return `EXISTS (SELECT 1 FROM ${table} fx WHERE fx.media_id = m.id AND fx.${column} IN (${list.map(() => '?').join(',')}))`;
  }
  if (op === 'contains') {
    params.push(likePattern(String(value)));
    return `EXISTS (SELECT 1 FROM ${table} fx WHERE fx.media_id = m.id AND fx.${column} LIKE ? ESCAPE '\\')`;
  }
  if (op === 'neq') {
    params.push(value);
    return `NOT EXISTS (SELECT 1 FROM ${table} fx WHERE fx.media_id = m.id AND fx.${column} = ?)`;
  }
  params.push(value);
  return `EXISTS (SELECT 1 FROM ${table} fx WHERE fx.media_id = m.id AND fx.${column} ${comparison(op)} ?)`;
}

function ruleClause(rule: SmartRule, params: unknown[]): string {
  const op = rule.op;
  switch (rule.field) {
    case 'kind': {
      if (op === 'in') {
        const list = rule.value as string[];
        params.push(...list);
        return `m.kind IN (${list.map(() => '?').join(',')})`;
      }
      params.push(rule.value);
      return `m.kind ${comparison(op)} ?`;
    }
    case 'genre':
      return existsClause('media_genres', 'genre', op, rule.value, params);
    case 'tag':
      return existsClause('media_tags', 'tag', op, rule.value, params);
    case 'person':
      return existsClause('media_people', 'name', op, rule.value, params);
    case 'titleContains': {
      if (op === 'contains') {
        params.push(likePattern(String(rule.value)));
        return `m.title LIKE ? ESCAPE '\\'`;
      }
      params.push(rule.value);
      return `m.title = ? COLLATE NOCASE`;
    }
    case 'year':
      if (op === 'in') {
        const list = rule.value as number[];
        params.push(...list);
        return `m.year IN (${list.map(() => '?').join(',')})`;
      }
      params.push(rule.value);
      return `m.year ${comparison(op)} ?`;
    case 'rating':
      params.push(rule.value);
      return `m.rating ${comparison(op)} ?`;
    case 'libraryId':
      if (op === 'in') {
        const list = rule.value as number[];
        params.push(...list);
        return `m.library_id IN (${list.map(() => '?').join(',')})`;
      }
      params.push(rule.value);
      return `m.library_id ${comparison(op)} ?`;
    case 'addedWithinDays': {
      const days = rule.value as number;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      params.push(cutoff);
      // "addedWithinDays lte N" = added in the last N days; gt/gte = older than N days.
      return op === 'gt' || op === 'gte' ? `m.added_at < ?` : `m.added_at >= ?`;
    }
  }
}

function targetedKindValues(rule: SmartRule): string[] | null {
  if (rule.op === 'eq') return typeof rule.value === 'string' ? [rule.value] : null;
  if (rule.op === 'in') return Array.isArray(rule.value) ? (rule.value as string[]) : null;
  return null;
}

/**
 * Child kinds are allowed only when every kind rule under match:'all' targets the
 * same single child kind (e.g. {match:'all', rules:[{field:'kind',op:'eq',value:'episode'}]}).
 * Any other shape — match:'any', mixed kind targets, neq kind rules — stays top-level.
 */
function allowsChildKinds(rules: SmartRules): boolean {
  if (rules.match !== 'all') return false;
  const kindRules = rules.rules.filter((rule) => rule.field === 'kind');
  if (kindRules.length === 0) return false;
  const targets = new Set<string>();
  for (const rule of kindRules) {
    const values = targetedKindValues(rule);
    if (!values || values.length === 0) return false;
    for (const value of values) targets.add(value);
  }
  if (targets.size !== 1) return false;
  const [only] = targets;
  return only in CHILD_KINDS;
}

function buildWhere(rules: SmartRules): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = ['m.hidden = 0'];
  if (!allowsChildKinds(rules)) {
    clauses.push(`m.kind IN (${TOP_LEVEL_KINDS.map(() => '?').join(',')})`);
    params.push(...TOP_LEVEL_KINDS);
  }
  const ruleClauses = rules.rules.map((rule) => ruleClause(rule, params));
  if (ruleClauses.length > 0) clauses.push(`(${ruleClauses.join(rules.match === 'any' ? ' OR ' : ' AND ')})`);
  return { where: clauses.join(' AND '), params };
}

function smartMediaRows(rules: SmartRules, options: EvaluateOptions = {}): MediaRow[] {
  const { where, params } = buildWhere(rules);
  const limit = Math.max(1, Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS));
  return getDb()
    .prepare(`SELECT m.* FROM media m WHERE ${where} ORDER BY m.sort_title COLLATE NOCASE ASC, m.id ASC LIMIT ?`)
    .all(...params, limit) as MediaRow[];
}

/** Evaluate a smart-collection rule set at read time. Exported for tests. */
export function evaluateSmartRules(rules: unknown, options: EvaluateOptions = {}): MediaDTO[] {
  const validated = validateSmartRules(rules);
  return mediaRowsToDTO(smartMediaRows(validated, options), options.userId);
}

const SEED_META_KEY = 'collections_seeded';

interface SeedCollection {
  name: string;
  description: string;
  kind: 'manual' | 'smart';
  rules: unknown;
  sortOrder: number;
}

const DEFAULT_COLLECTIONS: SeedCollection[] = [
  {
    name: 'Certified Bangers',
    description: 'Hand-picked, no notes. Certified.',
    kind: 'manual',
    rules: {},
    sortOrder: 0,
  },
  {
    name: 'Recently Added',
    description: 'Fresh out of the scanning mines. Last 30 days.',
    kind: 'smart',
    rules: { match: 'all', rules: [{ field: 'addedWithinDays', op: 'lte', value: 30 }] },
    sortOrder: 1,
  },
  {
    name: 'Absolute Cinema',
    description: 'Rating 8 or higher. Peak fiction only.',
    kind: 'smart',
    rules: { match: 'all', rules: [{ field: 'rating', op: 'gte', value: 8 }] },
    sortOrder: 2,
  },
  {
    name: 'The Vault',
    description: 'Pre-2000 artifacts. Historians, assemble.',
    kind: 'smart',
    rules: { match: 'all', rules: [{ field: 'year', op: 'lt', value: 2000 }] },
    sortOrder: 3,
  },
];

/** Seed the four pinned collections exactly once, tracked in meta. */
function ensureSeeded(): void {
  const db = getDb();
  const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(SEED_META_KEY);
  if (marker) return;
  const seed = db.transaction(() => {
    const existing = (db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n;
    if (existing === 0) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO collections(name, description, kind, rules, pinned, sort_order, created_by, created_at, updated_at)
         VALUES(?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
      );
      const timestamp = nowISO();
      for (const entry of DEFAULT_COLLECTIONS) {
        const rules = entry.kind === 'smart' ? JSON.stringify(validateSmartRules(entry.rules)) : '{}';
        insert.run(entry.name, entry.description, entry.kind, rules, entry.sortOrder, timestamp, timestamp);
      }
    }
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      SEED_META_KEY,
      nowISO(),
    );
  });
  seed();
}

function body(req: Request): Record<string, unknown> {
  const raw: unknown = req.body;
  const result: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) result[key] = value;
  return result;
}

function positiveInt(raw: unknown, label = 'id'): number {
  const value = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, `Invalid ${label}.`, 'bad_request');
  return value;
}

function requiredString(raw: unknown, label: string, min: number, max: number): string {
  if (typeof raw !== 'string') throw new HttpError(400, `${label} must be a string.`, 'bad_request');
  const trimmed = raw.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, `${label} must be ${min}-${max} characters.`, 'bad_request');
  }
  return trimmed;
}

function optionalDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new HttpError(400, 'description must be a string.', 'bad_request');
  if (raw.length > 2000) throw new HttpError(400, 'description is capped at 2000 characters.', 'bad_request');
  return raw.trim();
}

function integerInRange(raw: unknown, label: string, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label} must be an integer between ${min} and ${max}.`, 'bad_request');
  }
  return value;
}

function boolValue(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') throw new HttpError(400, `${label} must be a boolean.`, 'bad_request');
  return raw;
}

function isCurator(user: { role: string }): boolean {
  return user.role === 'admin' || user.role === 'manager';
}

function canManage(row: CollectionRow, user: { id: number; role: string }): boolean {
  return isCurator(user) || row.created_by === user.id;
}

function getCollection(id: number): CollectionRow {
  const row = getDb().prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined;
  if (!row) throw new HttpError(404, 'That collection is not a thing. Ghosted.', 'not_found');
  return row;
}

function artFor(media: Pick<MediaRow, 'id' | 'updated_at'> | undefined): ArtDTO {
  const art: ArtDTO = {};
  if (!media) return art;
  const rows = getDb().prepare('SELECT kind, source FROM media_art WHERE media_id = ?').all(media.id) as {
    kind: ArtKind;
    source: string;
  }[];
  for (const row of rows) art[row.kind] = artUrl(media.id, row.kind, `${row.source}-${media.updated_at}`);
  return art;
}

function collectionSummary(row: CollectionRow): { count: number; first: MediaRow | undefined } {
  const db = getDb();
  if (row.kind === 'smart') {
    const rules = parseStoredRules(row.rules);
    if (!rules) return { count: 0, first: undefined };
    const { where, params } = buildWhere(rules);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${where}`).get(...params) as { n: number }).n;
    const first = db
      .prepare(`SELECT m.* FROM media m WHERE ${where} ORDER BY m.sort_title COLLATE NOCASE ASC, m.id ASC LIMIT 1`)
      .get(...params) as MediaRow | undefined;
    return { count: Math.min(total, MAX_RESULTS), first };
  }
  const where = 'ci.collection_id = ? AND m.hidden = 0';
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM collection_items ci JOIN media m ON m.id = ci.media_id WHERE ${where}`).get(row.id) as {
      n: number;
    }
  ).n;
  const first = db
    .prepare(
      `SELECT m.* FROM collection_items ci JOIN media m ON m.id = ci.media_id
       WHERE ${where} ORDER BY ci.sort_order ASC, ci.added_at ASC, ci.media_id ASC LIMIT 1`,
    )
    .get(row.id) as MediaRow | undefined;
  return { count: Math.min(total, MAX_RESULTS), first };
}

type CollectionView = CollectionDTO & { coverMediaId: number | null; cover: ArtDTO };

function toCollectionDTO(row: CollectionRow): CollectionView {
  const { count, first } = collectionSummary(row);
  const creator = row.created_by
    ? (getDb().prepare('SELECT username FROM users WHERE id = ?').get(row.created_by) as { username: string } | undefined)
    : undefined;
  const art = artFor(first);
  const storedRules = row.kind === 'smart' ? parseStoredRules(row.rules) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    rules: storedRules ? { match: storedRules.match, rules: storedRules.rules } : {},
    pinned: Boolean(row.pinned),
    sortOrder: row.sort_order,
    createdBy: creator?.username ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: count,
    art,
    coverMediaId: first?.id ?? null,
    cover: art,
  };
}

function itemsFor(row: CollectionRow, userId?: number): MediaDTO[] {
  if (row.kind === 'smart') {
    const rules = parseStoredRules(row.rules);
    if (!rules) return [];
    return mediaRowsToDTO(smartMediaRows(rules, { userId, limit: MAX_RESULTS }), userId);
  }
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM collection_items ci JOIN media m ON m.id = ci.media_id
       WHERE ci.collection_id = ? AND m.hidden = 0
       ORDER BY ci.sort_order ASC, ci.added_at ASC, ci.media_id ASC LIMIT ?`,
    )
    .all(row.id, MAX_RESULTS) as MediaRow[];
  return mediaRowsToDTO(rows, userId);
}

function mediaIdList(raw: unknown, label = 'mediaIds'): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, `${label} must be a non-empty array of media ids.`, 'bad_request');
  }
  if (raw.length > MAX_RESULTS) {
    throw new HttpError(400, `At most ${MAX_RESULTS} media ids at once.`, 'bad_request');
  }
  const ids: number[] = [];
  for (const entry of raw) {
    const value = typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry) : NaN;
    if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, `${label} contains an invalid id.`, 'bad_request');
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

function collectionItemIds(collectionId: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT media_id FROM collection_items WHERE collection_id = ?
       ORDER BY sort_order ASC, added_at ASC, media_id ASC`,
    )
    .all(collectionId) as { media_id: number }[];
  return rows.map((row) => row.media_id);
}

collectionsRouter.get('/', (req, res) => {
  ensureSeeded();
  const user = req.user!;
  const { page, pageSize, offset } = pageParams(req, { page: 1, pageSize: 48, maxPageSize: 100 });
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n;
  const rows = db
    .prepare('SELECT * FROM collections ORDER BY pinned DESC, sort_order ASC, name COLLATE NOCASE ASC LIMIT ? OFFSET ?')
    .all(pageSize, offset) as CollectionRow[];
  sendPage(res, rows.map((row) => toCollectionDTO(row)), total, page, pageSize);
});

collectionsRouter.post('/', (req, res) => {
  ensureSeeded();
  const user = req.user!;
  const input = body(req);
  const name = requiredString(input.name, 'name', 1, 120);
  const kind = input.kind === undefined ? 'manual' : input.kind;
  if (kind !== 'manual' && kind !== 'smart') {
    throw new HttpError(400, "kind must be 'manual' or 'smart'.", 'bad_request');
  }
  const description = optionalDescription(input.description);

  let rulesJSON = '{}';
  if (kind === 'smart') rulesJSON = JSON.stringify(validateSmartRules(input.rules));
  else if (input.rules !== undefined) throw new HttpError(400, 'Manual collections do not take rules. Add items instead.', 'bad_request');

  let pinned = 0;
  if (input.pinned !== undefined) {
    if (!isCurator(user)) throw new HttpError(403, 'Only curators can pin collections.', 'forbidden');
    pinned = boolValue(input.pinned, 'pinned') ? 1 : 0;
  }
  let sortOrder = 0;
  if (input.sortOrder !== undefined) {
    if (!isCurator(user)) throw new HttpError(403, 'Only curators can set sort order.', 'forbidden');
    sortOrder = integerInRange(input.sortOrder, 'sortOrder', -10_000, 10_000);
  } else {
    sortOrder = ((getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM collections').get() as { n: number }).n ?? -1) + 1;
  }

  const db = getDb();
  if (db.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE').get(name)) {
    throw new HttpError(409, 'A collection with that name already exists.', 'conflict');
  }
  const timestamp = nowISO();
  const info = db
    .prepare(
      `INSERT INTO collections(name, description, kind, rules, pinned, sort_order, created_by, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, description, kind, rulesJSON, pinned, sortOrder, user.id, timestamp, timestamp);
  res.status(201).json(toCollectionDTO(getCollection(Number(info.lastInsertRowid))));
});

collectionsRouter.patch('/:id', (req, res) => {
  ensureSeeded();
  const id = positiveInt(req.params.id, 'id');
  const row = getCollection(id);
  const user = req.user!;
  if (!canManage(row, user)) throw new HttpError(403, 'Only the creator or a curator can edit this collection.', 'forbidden');

  const input = body(req);
  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    const name = requiredString(input.name, 'name', 1, 120);
    const clash = getDb().prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id);
    if (clash) throw new HttpError(409, 'A collection with that name already exists.', 'conflict');
    updates.push('name = ?');
    params.push(name);
  }
  if (input.description !== undefined) {
    updates.push('description = ?');
    params.push(optionalDescription(input.description));
  }

  let nextKind: 'manual' | 'smart' = row.kind;
  if (input.kind !== undefined) {
    if (input.kind !== 'manual' && input.kind !== 'smart') {
      throw new HttpError(400, "kind must be 'manual' or 'smart'.", 'bad_request');
    }
    nextKind = input.kind;
  }
  let nextRules = row.rules;
  if (nextKind === 'smart') {
    if (input.rules !== undefined) nextRules = JSON.stringify(validateSmartRules(input.rules));
    else if (row.kind === 'manual') throw new HttpError(400, 'Switching a collection to smart requires rules.', 'bad_request');
  } else {
    if (input.rules !== undefined) throw new HttpError(400, 'Manual collections do not take rules.', 'bad_request');
    nextRules = '{}';
  }
  if (nextKind !== row.kind) {
    updates.push('kind = ?');
    params.push(nextKind);
  }
  if (nextRules !== row.rules) {
    updates.push('rules = ?');
    params.push(nextRules);
  }
  if (input.pinned !== undefined) {
    if (!isCurator(user)) throw new HttpError(403, 'Only curators can pin collections.', 'forbidden');
    updates.push('pinned = ?');
    params.push(boolValue(input.pinned, 'pinned') ? 1 : 0);
  }
  if (input.sortOrder !== undefined) {
    updates.push('sort_order = ?');
    params.push(integerInRange(input.sortOrder, 'sortOrder', -10_000, 10_000));
  }
  if (updates.length === 0) throw new HttpError(400, 'Nothing to update. Send a field, chief.', 'bad_request');

  updates.push('updated_at = ?');
  params.push(nowISO(), id);
  getDb().prepare(`UPDATE collections SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(toCollectionDTO(getCollection(id)));
});

collectionsRouter.delete('/:id', (req, res) => {
  ensureSeeded();
  const id = positiveInt(req.params.id, 'id');
  const row = getCollection(id);
  if (!canManage(row, req.user!)) throw new HttpError(403, 'Only the creator or a curator can delete this collection.', 'forbidden');
  getDb().prepare('DELETE FROM collections WHERE id = ?').run(id);
  res.json({ ok: true });
});

collectionsRouter.get('/:id', (req, res) => {
  ensureSeeded();
  const id = positiveInt(req.params.id, 'id');
  const row = getCollection(id);
  const dto = toCollectionDTO(row);
  res.json({ ...dto, items: itemsFor(row, req.user!.id) });
});

function manageableManualCollection(id: number, user: { id: number; role: string }): CollectionRow {
  const row = getCollection(id);
  if (!canManage(row, user)) throw new HttpError(403, 'Only the creator or a curator can edit this collection.', 'forbidden');
  if (row.kind !== 'manual') {
    throw new HttpError(400, 'Smart collections compute their items. Edit the rules instead.', 'bad_request');
  }
  return row;
}

collectionsRouter.post('/:id/items', (req, res) => {
  ensureSeeded();
  const id = positiveInt(req.params.id, 'id');
  const row = manageableManualCollection(id, req.user!);
  const ids = mediaIdList(body(req).mediaIds);
  const db = getDb();

  const existing = collectionItemIds(id);
  if (existing.length + ids.length > MAX_RESULTS) {
    throw new HttpError(400, `Collections cap at ${MAX_RESULTS} items.`, 'bad_request', { cap: MAX_RESULTS });
  }
  const found = db.prepare(`SELECT id FROM media WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number }[];
  const foundIds = new Set(found.map((entry) => entry.id));
  const missing = ids.filter((mediaId) => !foundIds.has(mediaId));
  if (missing.length > 0) throw new HttpError(400, 'Some media ids do not exist.', 'bad_request', { missing });

  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM collection_items WHERE collection_id = ?').get(id) as {
    n: number;
  }).n;
  const timestamp = nowISO();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO collection_items(collection_id, media_id, sort_order, added_at) VALUES(?, ?, ?, ?)',
  );
  const add = db.transaction(() => {
    ids.forEach((mediaId, index) => insert.run(id, mediaId, maxSort + 1 + index, timestamp));
  });
  add();
  res.status(201).json({ ok: true, added: ids.length, itemCount: collectionItemIds(row.id).length });
});

collectionsRouter.delete('/:id/items/:mediaId', (req, res) => {
  ensureSeeded();
  const id = positiveInt(req.params.id, 'id');
  manageableManualCollection(id, req.user!);
  const mediaId = positiveInt(req.params.mediaId, 'mediaId');
  const info = getDb().prepare('DELETE FROM collection_items WHERE collection_id = ? AND media_id = ?').run(id, mediaId);
  if (info.changes === 0) throw new HttpError(404, 'That item is not in this collection.', 'not_found');
  res.json({ ok: true, itemCount: collectionItemIds(id).length });
});

collectionsRouter.put('/:id/items', (req, res) => {
  ensureSeeded();
  const id = positiveInt(req.params.id, 'id');
  manageableManualCollection(id, req.user!);
  const ids = mediaIdList(body(req).mediaIds);

  const current = collectionItemIds(id);
  const currentSet = new Set(current);
  const unknown = ids.filter((mediaId) => !currentSet.has(mediaId));
  if (unknown.length > 0) {
    throw new HttpError(400, 'Reorder payload includes items not in this collection.', 'bad_request', { unknown });
  }
  const provided = new Set(ids);
  const order = [...ids, ...current.filter((mediaId) => !provided.has(mediaId))];

  const update = getDb().prepare('UPDATE collection_items SET sort_order = ? WHERE collection_id = ? AND media_id = ?');
  const reorder = getDb().transaction(() => {
    order.forEach((mediaId, index) => update.run(index, id, mediaId));
  });
  reorder();
  res.json({ ok: true, itemCount: order.length });
});



