import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { normalizeResultUrl } from '#/app/auth/webSearch/providers/fusion';
import type { UrlFetchKind } from '#/app/web/tools/fetch-url-types';

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

export interface CachedPageEntry {
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title: string;
  readonly content: string;
  readonly kind: UrlFetchKind;
  readonly contentType: string;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

export interface PassageDocument {
  readonly url: string;
  readonly title: string;
  readonly content: string;
}

export interface RankedPassage {
  readonly url: string;
  readonly title: string;
  readonly heading: string;
  readonly text: string;
  readonly score: number;
}

export interface WebCacheOptions {
  readonly dbPath?: string;
  readonly defaultTtlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;
const TARGET_CHUNK_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 150;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  normalized_url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  url, title, content, content='pages', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, url, title, content) VALUES (new.rowid, new.url, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, title, content) VALUES('delete', old.rowid, old.url, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, title, content) VALUES('delete', old.rowid, old.url, old.title, old.content);
  INSERT INTO pages_fts(rowid, url, title, content) VALUES (new.rowid, new.url, new.title, new.content);
END;
CREATE INDEX IF NOT EXISTS idx_pages_normalized_url ON pages(normalized_url);
CREATE INDEX IF NOT EXISTS idx_pages_expires_at ON pages(expires_at);
`;

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

export function extractMarkdownTitle(content: string): string {
  const firstHeading = /^#\s+(.+)$/m.exec(content);
  if (firstHeading?.[1] !== undefined) return firstHeading[1].trim();
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine !== undefined ? firstLine.slice(0, 120) : '';
}

interface TextChunk {
  readonly heading: string;
  readonly text: string;
}

export function chunkContent(content: string, maxChunkChars = TARGET_CHUNK_CHARS): readonly TextChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: TextChunk[] = [];
  let currentHeading = '';
  let buffer = '';

  const flushBuffer = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length === 0) {
      buffer = '';
      return;
    }
    if (trimmed.length <= maxChunkChars) {
      chunks.push({ heading: currentHeading, text: trimmed });
      buffer = '';
      return;
    }
    let start = 0;
    while (start < trimmed.length) {
      let end = Math.min(trimmed.length, start + maxChunkChars);
      if (end < trimmed.length) {
        const paraBreak = trimmed.lastIndexOf('\n', end);
        const spaceBreak = trimmed.lastIndexOf(' ', end);
        if (paraBreak > start + maxChunkChars * 0.4) end = paraBreak;
        else if (spaceBreak > start + maxChunkChars * 0.4) end = spaceBreak;
      }
      chunks.push({ heading: currentHeading, text: trimmed.slice(start, end).trim() });
      if (end >= trimmed.length) break;
      start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    }
    buffer = '';
  };

  for (const line of lines) {
    const headingMatch = /^#{1,4}\s+(.+)$/.exec(line.trim());
    if (headingMatch?.[1] !== undefined) {
      flushBuffer();
      currentHeading = headingMatch[1].trim();
      buffer = `${line}\n`;
      continue;
    }
    if (buffer.length + line.length + 1 > maxChunkChars && buffer.trim().length >= maxChunkChars * 0.6) {
      flushBuffer();
    }
    buffer += `${line}\n`;
  }
  flushBuffer();

  return chunks;
}

export function tokenizeForSearch(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim();
  if (normalized.length === 0) return [];
  const tokens: string[] = [];
  for (const part of normalized.split(/\s+/)) {
    if (part.length === 0) continue;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(part)) {
      if (part.length <= 2) {
        tokens.push(part);
      } else {
        for (let i = 0; i < part.length - 1; i += 1) {
          tokens.push(part.slice(i, i + 2));
        }
      }
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

export function rankPassages(
  query: string,
  documents: readonly PassageDocument[],
  limit = 6,
): RankedPassage[] {
  const queryTokens = tokenizeForSearch(query);
  const allChunks: Array<{ doc: PassageDocument; chunk: TextChunk; tokens: string[] }> = [];

  for (const doc of documents) {
    for (const chunk of chunkContent(doc.content)) {
      const tokens = tokenizeForSearch(`${doc.title} ${chunk.heading} ${chunk.text}`);
      if (tokens.length > 0) allChunks.push({ doc, chunk, tokens });
    }
  }

  if (allChunks.length === 0) return [];
  if (queryTokens.length === 0) {
    return allChunks.slice(0, limit).map(({ doc, chunk }) => ({
      url: doc.url,
      title: doc.title,
      heading: chunk.heading,
      text: chunk.text,
      score: 1,
    }));
  }

  const df = new Map<string, number>();
  let totalLength = 0;
  for (const entry of allChunks) {
    totalLength += entry.tokens.length;
    const unique = new Set(entry.tokens);
    for (const q of queryTokens) {
      if (unique.has(q)) df.set(q, (df.get(q) ?? 0) + 1);
    }
  }
  const avgDl = Math.max(1, totalLength / allChunks.length);
  const k1 = 1.5;
  const b = 0.75;
  const n = allChunks.length;

  const scored: RankedPassage[] = [];
  for (const entry of allChunks) {
    const tfMap = new Map<string, number>();
    for (const tok of entry.tokens) {
      tfMap.set(tok, (tfMap.get(tok) ?? 0) + 1);
    }
    let score = 0;
    const dl = entry.tokens.length;
    for (const q of queryTokens) {
      const tf = tfMap.get(q) ?? 0;
      if (tf === 0) continue;
      const docFreq = df.get(q) ?? 0;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + (b * dl) / avgDl);
      score += idf * (num / den);
    }
    if (score > 0) {
      scored.push({
        url: entry.doc.url,
        title: entry.doc.title,
        heading: entry.chunk.heading,
        text: entry.chunk.text,
        score: Math.round(score * 10_000) / 10_000,
      });
    }
  }

  if (scored.length === 0) {
    return allChunks.slice(0, limit).map(({ doc, chunk }) => ({
      url: doc.url,
      title: doc.title,
      heading: chunk.heading,
      text: chunk.text,
      score: 0,
    }));
  }

  scored.sort((a, bItem) => bItem.score - a.score);
  return scored.slice(0, limit);
}

function buildFtsQuery(raw: string): string | undefined {
  const words = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 2);
  if (words.length === 0) return undefined;
  return words.map((word) => `"${word.replaceAll('"', '')}"`).join(' OR ');
}

interface SqlitePageRow {
  url: string;
  normalized_url: string;
  title: string;
  content: string;
  kind: string;
  content_type: string;
  fetched_at: number;
  expires_at: number;
}

export class WebCache {
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly memory = new Map<string, CachedPageEntry>();
  private db: SqliteDatabase | undefined;
  private closed = false;

  constructor(options: WebCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = Math.max(10, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? (() => Date.now());
    if (options.dbPath !== undefined) {
      const sqlite = loadSqlite();
      if (sqlite !== undefined) {
        if (options.dbPath !== ':memory:') {
          mkdirSync(dirname(options.dbPath), { recursive: true });
        }
        this.db = new sqlite.Database(options.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec(SCHEMA_SQL);
      }
    }
  }

  get isSqliteBacked(): boolean {
    return this.db !== undefined;
  }

  get(url: string): CachedPageEntry | undefined {
    if (this.closed) return undefined;
    const now = this.now();
    const norm = normalizeResultUrl(url);
    if (this.db !== undefined) {
      const row = this.db
        .query(
          'SELECT url, normalized_url, title, content, kind, content_type, fetched_at, expires_at FROM pages WHERE (url = ?1 OR normalized_url = ?2) AND expires_at > ?3 LIMIT 1',
        )
        .get(url, norm, now) as SqlitePageRow | null;
      if (row === null || row === undefined) return undefined;
      return {
        url: row.url,
        normalizedUrl: row.normalized_url,
        title: row.title,
        content: row.content,
        kind: row.kind === 'passthrough' ? 'passthrough' : 'extracted',
        contentType: row.content_type,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
      };
    }

    const mem = this.memory.get(norm);
    if (mem === undefined) return undefined;
    if (mem.expiresAt <= now) {
      this.memory.delete(norm);
      return undefined;
    }
    this.memory.delete(norm);
    this.memory.set(norm, mem);
    return mem;
  }

  put(
    input: {
      readonly url: string;
      readonly title?: string;
      readonly content: string;
      readonly kind: UrlFetchKind;
      readonly contentType?: string;
      readonly ttlMs?: number;
    },
  ): CachedPageEntry {
    const now = this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const norm = normalizeResultUrl(input.url);
    const title = input.title ?? extractMarkdownTitle(input.content);
    const entry: CachedPageEntry = {
      url: input.url,
      normalizedUrl: norm,
      title,
      content: input.content,
      kind: input.kind,
      contentType: input.contentType ?? '',
      fetchedAt: now,
      expiresAt: now + ttlMs,
    };
    if (this.closed) return entry;

    if (this.db !== undefined) {
      this.db.query('DELETE FROM pages WHERE expires_at <= ?1').run(now);
      this.db
        .query(
          'INSERT OR REPLACE INTO pages (url, normalized_url, title, content, kind, content_type, fetched_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
        )
        .run(
          entry.url,
          entry.normalizedUrl,
          entry.title,
          entry.content,
          entry.kind,
          entry.contentType,
          entry.fetchedAt,
          entry.expiresAt,
        );
      this.pruneDbOverflow();
      return entry;
    }

    for (const [key, value] of this.memory.entries()) {
      if (value.expiresAt <= now) this.memory.delete(key);
    }
    if (this.memory.has(norm)) this.memory.delete(norm);
    this.memory.set(norm, entry);
    while (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
    return entry;
  }

  searchPassages(query: string, limit = 6): RankedPassage[] {
    if (this.closed) return [];
    const now = this.now();
    const docs: PassageDocument[] = [];
    if (this.db !== undefined) {
      const ftsQuery = buildFtsQuery(query);
      if (ftsQuery !== undefined) {
        const rows = this.db
          .query(
            'SELECT p.url, p.title, p.content FROM pages_fts f JOIN pages p ON p.rowid = f.rowid WHERE pages_fts MATCH ?1 AND p.expires_at > ?2 ORDER BY rank LIMIT 15',
          )
          .all(ftsQuery, now) as Array<{ url: string; title: string; content: string }>;
        for (const row of rows) {
          docs.push({ url: row.url, title: row.title, content: row.content });
        }
      }
      if (docs.length === 0) {
        const recent = this.db
          .query(
            'SELECT url, title, content FROM pages WHERE expires_at > ?1 ORDER BY fetched_at DESC LIMIT 15',
          )
          .all(now) as Array<{ url: string; title: string; content: string }>;
        for (const row of recent) {
          docs.push({ url: row.url, title: row.title, content: row.content });
        }
      }
    } else {
      for (const entry of this.memory.values()) {
        if (entry.expiresAt > now) {
          docs.push({ url: entry.url, title: entry.title, content: entry.content });
        }
      }
    }
    return rankPassages(query, docs, limit);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.memory.clear();
    this.db?.close();
    this.db = undefined;
  }

  private pruneDbOverflow(): void {
    if (this.db === undefined) return;
    const countRow = this.db.query('SELECT count(*) AS count FROM pages').get() as {
      count: number;
    } | null;
    const total = countRow?.count ?? 0;
    if (total <= this.maxEntries) return;
    const excess = total - this.maxEntries;
    this.db
      .query(
        'DELETE FROM pages WHERE url IN (SELECT url FROM pages ORDER BY fetched_at ASC LIMIT ?1)',
      )
      .run(excess);
  }
}
