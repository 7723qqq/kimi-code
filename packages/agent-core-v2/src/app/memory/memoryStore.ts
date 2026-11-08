import { MiniDb } from '@moonshot-ai/minidb';
import { join } from 'pathe';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';

import type { MemoryEntry, MemoryScope, MemorySearchResult } from './memoryPaths';
import { buildSnippet, detectType, extractTitle, parseMemoryPath } from './memoryPaths';

const TEXT_INDEX_NAME = 'memory_body';
const META_PREFIX = '__meta__:';
const RECONCILE_INTERVAL_MS = 600_000;
const STORE_SUBDIR = 'memory';

export interface IMemoryStore {
  readonly _serviceBrand: undefined;

  readonly revision: number;

  readonly readOnly: boolean;

  setReadOnly(value: boolean): void;

  get(path: string): Promise<MemoryEntry | undefined>;

  put(entry: MemoryEntry): Promise<void>;

  delete(path: string): Promise<void>;

  list(): Promise<readonly string[]>;

  search(
    query: string,
    limit?: number,
    filter?: { readonly scope: MemoryScope; readonly scopeId: string },
  ): Promise<readonly MemorySearchResult[]>;

  reconcile(): Promise<void>;
}

export const IMemoryStore = createDecorator<IMemoryStore>('memoryStore');

export class MemoryStore extends Disposable implements IMemoryStore {
  declare readonly _serviceBrand: undefined;

  private dbPromise: Promise<MiniDb> | undefined;
  private contentRevision = 0;
  private readOnlyFlag = false;
  private seeded = false;
  private readonly dir: string;
  private readonly memoryBaseDir: string;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.dir = join(this.bootstrap.storeDir, STORE_SUBDIR);
    this.memoryBaseDir = join(this.bootstrap.homeDir, 'memory');
    this._register(
      toDisposable(() => {
        void this.close();
      }),
    );
  }

  private async openDb(): Promise<MiniDb> {
    if (this.dbPromise !== undefined) return this.dbPromise;
    this.dbPromise = MiniDb.open({
      dir: this.dir,
      valueCodec: 'json',
      valueMode: 'memory',
      fsyncPolicy: 'everysec',
    }).catch((error) => {
      const wrapped = new Error(
        `memory store at ${this.dir} failed to open (${error instanceof Error ? error.message : String(error)}); user data was not touched and the memory feature stays unavailable until the store is repaired`,
        { cause: error },
      );
      this.log.error('memory.store.open.failed', { dir: this.dir, error: wrapped });
      throw wrapped;
    });
    const db = await this.dbPromise;
    try {
      await db.createTextIndex(TEXT_INDEX_NAME, { fields: ['body'] });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already exists')) {
        this.log.warn('memory.store.textIndex.create.failed', { error });
      }
    }
    return db;
  }

  private async ensureFresh(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    const db = await this.openDb();
    const marker = db.get(`${META_PREFIX}reconciled`) as { readonly at?: number } | undefined;
    const at = typeof marker?.at === 'number' ? marker.at : 0;
    if (Date.now() - at < RECONCILE_INTERVAL_MS) return;
    await this.reconcile();
  }

  async get(path: string): Promise<MemoryEntry | undefined> {
    await this.ensureFresh();
    const db = await this.openDb();
    const raw = db.get(path);
    return raw as MemoryEntry | undefined;
  }

  get revision(): number {
    return this.contentRevision;
  }

  get readOnly(): boolean {
    return this.readOnlyFlag;
  }

  setReadOnly(value: boolean): void {
    this.readOnlyFlag = value;
  }

  async put(entry: MemoryEntry): Promise<void> {
    if (this.readOnlyFlag) {
      throw new Error('memory store is read-only: associative memory has absorbed it');
    }
    this.contentRevision += 1;
    const db = await this.openDb();
    await db.set(entry.path, entry);
  }

  async delete(path: string): Promise<void> {
    if (this.readOnlyFlag) {
      throw new Error('memory store is read-only: associative memory has absorbed it');
    }
    this.contentRevision += 1;
    const db = await this.openDb();
    await db.del(path);
  }

  async list(): Promise<readonly string[]> {
    await this.ensureFresh();
    const db = await this.openDb();
    const entries = db.query({});
    return entries.map((e) => e.key).filter((key) => !key.startsWith(META_PREFIX));
  }

  async search(
    query: string,
    limit = 10,
    filter?: { readonly scope: MemoryScope; readonly scopeId: string },
  ): Promise<readonly MemorySearchResult[]> {
    await this.ensureFresh();
    const db = await this.openDb();
    const overFetch = Math.min(limit * 3, 50);
    const hits = db.search(TEXT_INDEX_NAME, query, { op: 'OR', limit: overFetch });

    const results: MemorySearchResult[] = [];
    for (const hit of hits) {
      const entry = db.get(hit.key) as MemoryEntry | undefined;
      if (entry === undefined) continue;
      const parsed = parseMemoryPath(entry.path);
      if (parsed === undefined) continue;
      if (filter !== undefined && (parsed.scope !== filter.scope || parsed.scopeId !== filter.scopeId))
        continue;

      const normalizedScore = hit.score;
      if (normalizedScore < 0.15) continue;

      results.push({
        path: entry.path,
        scope: entry.scope,
        scopeId: entry.scopeId,
        type: entry.type,
        title: entry.title,
        snippet: buildSnippet(entry.body, query),
        score: normalizedScore,
      });
    }

    return results.slice(0, limit);
  }

  async reconcile(): Promise<void> {
    this.contentRevision += 1;
    const { stat } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');

    const db = await this.openDb();
    const diskFiles = await this.walkDir(this.memoryBaseDir, '');

    const indexedKeys = new Set<string>();
    for (const entry of db.query({})) {
      if (entry.key.startsWith(META_PREFIX)) continue;
      indexedKeys.add(entry.key);
    }

    for (const [relPath, fingerprint] of diskFiles) {
      const existing = db.get(relPath) as MemoryEntry | undefined;
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        indexedKeys.delete(relPath);
        continue;
      }

      const parsed = parseMemoryPath(relPath);
      if (parsed === undefined) continue;

      const fullPath = joinPath(this.memoryBaseDir, relPath);
      const body = await readFile(fullPath);
      const statInfo = await stat(fullPath);

      const entry: MemoryEntry = {
        path: relPath,
        scope: parsed.scope,
        scopeId: parsed.scopeId,
        type: detectType(body),
        title: extractTitle(body, parsed.fileName),
        body,
        fingerprint,
        updatedAt: statInfo.mtimeMs,
      };
      await db.set(relPath, entry);
      indexedKeys.delete(relPath);
    }

    for (const staleKey of indexedKeys) {
      await db.del(staleKey);
    }

    await db.set(`${META_PREFIX}reconciled`, { at: Date.now() });
    this.log.debug('memory.store.reconciled', {
      total: diskFiles.size,
      removed: indexedKeys.size,
    });
  }

  private async walkDir(base: string, relPrefix: string): Promise<Map<string, string>> {
    const { readdir, stat } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');
    const result = new Map<string, string>();

    let entries: string[];
    try {
      entries = await readdir(joinPath(base, relPrefix));
    } catch {
      return result;
    }

    for (const name of entries) {
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const full = joinPath(base, rel);
      const s = await stat(full);
      if (s.isDirectory()) {
        const sub = await this.walkDir(base, rel);
        for (const [k, v] of sub) result.set(k, v);
      } else if (s.isFile() && name.endsWith('.md')) {
        result.set(rel, `${s.size}-${s.mtimeMs}`);
      }
    }

    return result;
  }

  async close(): Promise<void> {
    const db = await this.dbPromise?.catch(() => undefined);
    await db?.close();
  }
}

async function readFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

registerScopedService(
  LifecycleScope.App,
  IMemoryStore,
  MemoryStore,
  ScopeActivation.OnScopeCreated,
  'memory',
);
