import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { ulid } from 'ulid';

import type { KnowledgeEntry, KnowledgeSearchResult, KnowledgeStats } from './knowledge';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
}

interface SqliteDatabase {
  exec(sql: string): void;
  query(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  Database: new (filename: string) => SqliteDatabase;
}

interface EntryRow {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  scope: string | null;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

const ENTRY_COLUMNS = 'id,category,title,content,tags,scope,confidence,source,created_at,updated_at';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL CHECK(category IN ('coding-style','pitfall','architecture','workflow')),
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    scope       TEXT DEFAULT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0,
    source      TEXT NOT NULL CHECK(source IN ('human','ai-learned','ai-confirmed')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags, content='entries', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
CREATE INDEX IF NOT EXISTS idx_entries_confidence ON entries(confidence);
`;

const SCOPE_SQL = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE confidence >= ?1 AND (scope IS NULL OR ?2 = rtrim(replace(scope, char(92), '/'), '/') OR instr(?2, rtrim(replace(scope, char(92), '/'), '/') || '/') = 1) ORDER BY confidence DESC LIMIT 20`;

const FTS_SQL = `SELECT e.id,e.category,e.title,e.content,e.tags,e.scope,e.confidence,e.source,e.created_at,e.updated_at,rank FROM entries_fts f JOIN entries e ON e.rowid=f.rowid WHERE entries_fts MATCH ?1 AND e.confidence >= ?2 ORDER BY rank LIMIT 20`;

const TAGGED_SQL = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE confidence >= ?1 AND tags != ''`;

let database: SqliteDatabase | null = null;
let sqliteModule: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | undefined {
  if (sqliteModule === null) return undefined;
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteModule = require('bun:sqlite') as SqliteModule;
    return sqliteModule;
  } catch {
    sqliteModule = null;
    return undefined;
  }
}

export function isAvailable(): boolean {
  return loadSqlite() !== undefined;
}

function requireDatabase(): SqliteDatabase {
  if (database === null) {
    throw new Error('Knowledge DB not opened. Call knowledgeOpen first.');
  }
  return database;
}

function nowIso(): string {
  return new Date().toISOString();
}

function splitTags(tags: string): string[] {
  if (tags.length === 0) return [];
  return tags.split(',').map((tag) => tag.trim());
}

function rowToEntry(row: EntryRow): KnowledgeEntry {
  return {
    id: row.id,
    category: row.category as KnowledgeEntry['category'],
    title: row.title,
    content: row.content,
    tags: splitTags(row.tags),
    scope: row.scope,
    confidence: row.confidence,
    source: row.source as KnowledgeEntry['source'],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function escapeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(' OR ');
}

function normalizeScopePath(raw: string): string {
  const unified = raw.replaceAll('\\', '/');
  const withoutTrailing = unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
  return withoutTrailing.length === 0 ? '/' : withoutTrailing;
}

interface ScoredEntry {
  entry: KnowledgeEntry;
  score: number;
  sources: string[];
}

function addHit(
  hits: Map<string, ScoredEntry>,
  entry: KnowledgeEntry,
  score: number,
  source: string,
): void {
  const existing = hits.get(entry.id);
  if (existing === undefined) {
    hits.set(entry.id, { entry, score, sources: [source] });
    return;
  }
  existing.score += score;
  existing.sources.push(source);
}

export function knowledgeOpen(dbPath: string): void {
  const sqlite = loadSqlite();
  if (sqlite === undefined) {
    throw new Error('bun:sqlite is unavailable in this runtime');
  }
  if (database !== null) {
    database.close();
    database = null;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const opened = new sqlite.Database(dbPath);
  opened.exec('PRAGMA journal_mode = WAL;');
  const existing = opened
    .query("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='entries'")
    .get() as { c: number } | null;
  if (existing === null || existing.c === 0) {
    opened.exec(SCHEMA_SQL);
  }
  database = opened;
}

export function knowledgeClose(): void {
  if (database === null) return;
  database.close();
  database = null;
}

export function knowledgeAdd(
  title: string,
  category: string,
  content: string,
  tags: string,
  scope: string | null | undefined,
  source: string,
  confidence: number,
): string {
  const db = requireDatabase();
  const id = ulid();
  const now = nowIso();
  const scopeValue = scope === undefined || scope === null || scope.length === 0 ? null : scope;
  db.query(
    'INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)',
  ).run(id, category, title, content, tags, scopeValue, confidence, source, now, now);
  const entry: KnowledgeEntry = {
    id,
    category: category as KnowledgeEntry['category'],
    title,
    content,
    tags: tags
      .split(',')
      .filter((tag) => tag.length > 0)
      .map((tag) => tag.trim()),
    scope: scopeValue,
    confidence,
    source: source as KnowledgeEntry['source'],
    created_at: now,
    updated_at: now,
  };
  return JSON.stringify(entry);
}

export function knowledgeSearch(
  query: string,
  scopePath: string | null | undefined,
  tags: string | null | undefined,
  limit: number,
  minConfidence: number,
): string {
  const db = requireDatabase();
  const hits = new Map<string, ScoredEntry>();

  if (scopePath !== null && scopePath !== undefined) {
    const candidate = normalizeScopePath(scopePath);
    const rows = db.query(SCOPE_SQL).all(minConfidence, candidate) as EntryRow[];
    for (const row of rows) {
      const entry = rowToEntry(row);
      addHit(hits, entry, entry.scope === null ? 1 : 3, 'scope');
    }
  }

  if (query.length > 0 && query !== '*') {
    const ftsQuery = escapeFtsQuery(query);
    const rows = db.query(FTS_SQL).all(ftsQuery, minConfidence) as Array<EntryRow & { rank: number }>;
    for (const row of rows) {
      const entry = rowToEntry(row);
      addHit(hits, entry, 2 * (1 / (1 + Math.abs(row.rank))), 'fts');
    }
  }

  if (tags !== null && tags !== undefined) {
    const wanted = new Set(
      tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    );
    if (wanted.size > 0) {
      const rows = db.query(TAGGED_SQL).all(minConfidence) as EntryRow[];
      for (const row of rows) {
        const entry = rowToEntry(row);
        let overlap = 0;
        for (const tag of entry.tags) {
          if (wanted.has(tag)) overlap += 1;
        }
        if (overlap > 0) addHit(hits, entry, overlap, 'tag');
      }
    }
  }

  const results: KnowledgeSearchResult[] = [];
  for (const hit of hits.values()) {
    results.push({
      entry: hit.entry,
      relevance: hit.score * hit.entry.confidence,
      match_source: [...new Set(hit.sources)],
    });
  }
  results.sort((left, right) => right.relevance - left.relevance);
  return JSON.stringify(results.slice(0, limit));
}

export function knowledgeRemove(id: string): boolean {
  const result = requireDatabase().query('DELETE FROM entries WHERE id = ?1').run(id);
  return result.changes > 0;
}

export function knowledgeConfirm(id: string): boolean {
  const result = requireDatabase()
    .query(
      "UPDATE entries SET confidence = 1.0, source = 'ai-confirmed', updated_at = ?1 WHERE id = ?2",
    )
    .run(nowIso(), id);
  return result.changes > 0;
}

export function knowledgeStats(): string {
  const db = requireDatabase();
  const totalRow = db.query('SELECT count(*) AS total FROM entries').get() as {
    total: number;
  } | null;
  const by_category: Record<string, number> = {};
  for (const row of db
    .query('SELECT category AS name, count(*) AS n FROM entries GROUP BY category')
    .all() as Array<{ name: string; n: number }>) {
    by_category[row.name] = row.n;
  }
  const by_source: Record<string, number> = {};
  for (const row of db
    .query('SELECT source AS name, count(*) AS n FROM entries GROUP BY source')
    .all() as Array<{ name: string; n: number }>) {
    by_source[row.name] = row.n;
  }
  const avgRow = db.query('SELECT COALESCE(avg(confidence),0) AS avg FROM entries').get() as {
    avg: number;
  } | null;
  const stats: KnowledgeStats = {
    total: totalRow?.total ?? 0,
    by_category,
    by_source,
    avg_confidence: avgRow?.avg ?? 0,
  };
  return JSON.stringify(stats);
}

export function knowledgeImport(markdown: string): string {
  const db = requireDatabase();
  const normalized = markdown.replaceAll('\r\n', '\n');
  const entries: KnowledgeEntry[] = [];

  for (const rawBlock of normalized.split('\n---\n')) {
    const block = rawBlock.trim();
    if (block.length === 0) continue;
    const lines = block.split('\n');
    const header = (lines[0] ?? '').replace(/^#+/, '').trim();
    const colon = header.indexOf(':');
    if (colon === -1) continue;
    const category = header.slice(0, colon).trim();
    const title = header.slice(colon + 1).trim();

    let tags = '';
    let scope: string | null = null;
    let contentStart = 1;
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.startsWith('tags:')) {
        tags = line
          .slice('tags:'.length)
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0)
          .join(',');
        contentStart = index + 1;
      } else if (line.startsWith('scope:')) {
        const value = line.slice('scope:'.length).trim();
        if (value.length > 0) scope = value;
        contentStart = index + 1;
      } else if (line.length === 0) {
        contentStart = index + 1;
        break;
      } else {
        break;
      }
    }

    const content = lines
      .slice(contentStart)
      .join('\n')
      .trim()
      .replaceAll('\n\\---\n', '\n---\n');
    if (content.length === 0) continue;

    const id = ulid();
    const now = nowIso();
    try {
      db.query(
        'INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,1.0,\'human\',?7,?8)',
      ).run(id, category, title, content, tags, scope, now, now);
    } catch {
      continue;
    }
    entries.push({
      id,
      category: category as KnowledgeEntry['category'],
      title,
      content,
      tags: splitTags(tags),
      scope,
      confidence: 1.0,
      source: 'human',
      created_at: now,
      updated_at: now,
    });
  }

  return JSON.stringify(entries);
}
