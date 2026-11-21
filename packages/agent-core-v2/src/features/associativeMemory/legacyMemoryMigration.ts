import type { ILogService } from '#/_base/log/log';
import { parseMemoryPath, type MemoryEntry } from '#/app/memory/memoryPaths';
import type { IMemoryStore } from '#/app/memory/memoryStore';
import { isMemoryVisible, type MemoryVisibilityContext } from '#/app/memory/memoryVisibility';

import type { AssociativeMemoryStore } from './store';
import type { LegacyMemoryOrigin } from './types';

interface MigrationDependencies {
  readonly source: Pick<IMemoryStore, 'revision' | 'list' | 'get'>;
  readonly visibility: () => MemoryVisibilityContext;
  readonly openStore: (scopeKey: string) => Promise<AssociativeMemoryStore>;
  readonly importEntry: (
    entry: MemoryEntry,
    store: AssociativeMemoryStore,
    noteId: string,
    origin: LegacyMemoryOrigin,
  ) => Promise<void>;
  readonly retireNote: (store: AssociativeMemoryStore, noteId: string) => Promise<void>;
  readonly now: () => number;
  readonly log: Pick<ILogService, 'warn'>;
}

function digest(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function sessionMemoryScopeKey(sessionId: string): string {
  return `session-${digest(sessionId).slice(0, 24)}`;
}

export class LegacyMemoryMigration {
  private pending: Promise<void> | undefined;
  private completedRevision: number | undefined;

  constructor(private readonly deps: MigrationDependencies) {}

  run(): Promise<void> {
    if (this.pending !== undefined) return this.pending;
    this.pending = this.migrate().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async migrate(): Promise<void> {
    let paths: readonly string[];
    try {
      paths = await this.deps.source.list();
    } catch (error) {
      this.deps.log.warn('associativeMemory.importLegacy.failed', { error });
      return;
    }
    const revision = this.deps.source.revision;
    if (typeof revision === 'number' && this.completedRevision === revision) return;
    const visibility = this.deps.visibility();
    let complete = true;
    for (const path of paths) {
      if (!isMemoryVisible(path, visibility)) continue;
      try {
        const entry = await this.deps.source.get(path);
        if (entry === undefined) continue;
        if (!isMemoryVisible(path, visibility, entry)) {
          complete = false;
          this.deps.log.warn('associativeMemory.importLegacy.invalidScope', { path });
          continue;
        }
        const parsed = parseMemoryPath(path)!;
        const scopeKey =
          parsed.scope === 'global'
            ? 'global'
            : parsed.scope === 'session'
              ? sessionMemoryScopeKey(visibility.sessionId)
              : visibility.projectId;
        const store = await this.deps.openStore(scopeKey);
        const originKey = digest(path);
        const origin: LegacyMemoryOrigin = {
          path,
          scope: parsed.scope,
          scopeId: parsed.scopeId,
          fingerprint: entry.fingerprint,
          contentHash: digest(entry.body),
        };
        await store.runExclusive(async () => {
          const previous = store.getMigration(originKey);
          if (
            previous?.version === 1 &&
            previous.fingerprint === origin.fingerprint &&
            previous.contentHash === origin.contentHash
          )
            return;
          const noteId = `legacy_${digest(`${originKey}\0${origin.fingerprint}\0${origin.contentHash}`).slice(0, 32)}`;
          await this.deps.importEntry(entry, store, noteId, origin);
          if (previous !== undefined && previous.noteId !== noteId) {
            await this.deps.retireNote(store, previous.noteId);
          }
          await store.putMigration(originKey, {
            ...origin,
            version: 1,
            noteId,
            completedAt: this.deps.now(),
          });
        });
      } catch (error) {
        complete = false;
        this.deps.log.warn('associativeMemory.importLegacy.entryFailed', { path, error });
      }
    }
    if (complete && typeof revision === 'number' && this.deps.source.revision === revision) {
      this.completedRevision = revision;
    }
  }
}
