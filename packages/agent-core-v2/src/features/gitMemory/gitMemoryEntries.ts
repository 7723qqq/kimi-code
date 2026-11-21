import picomatch from 'picomatch';

import type { ILogService } from '#/_base/log/log';
import type { IAgentMemoryInjectionState } from '#/agent/injection/memoryInjectionState';
import { parseAppliesTo } from '#/app/memory/memoryPaths';
import type { IMemoryRepo } from '#/app/memory/memoryRepo';
import type { IMemoryStore } from '#/app/memory/memoryStore';
import { isMemoryVisible, type MemoryVisibilityContext } from '#/app/memory/memoryVisibility';

import type { GitMemoryRenderState } from './gitMemoryRenderState';
import type { MemoryEntryView } from './projection';

const MEMORY_BLOCK_MAX_ENTRIES = 8;
const MEMORY_SHA_HISTORY = 200;

interface MemoryRecord {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: number;
}

export class GitMemoryEntries {
  private entriesCache:
    | { readonly revision: number; readonly entries: readonly MemoryRecord[] }
    | undefined;
  private shaCache: { readonly revision: number; readonly map: Map<string, string> } | undefined;
  private warned = false;
  private contentRevision: number | undefined;
  private visibilityIdentity = '';
  private generation: number | undefined;

  constructor(
    private readonly store: IMemoryStore,
    private readonly repo: IMemoryRepo,
    private readonly injectionState: IAgentMemoryInjectionState,
    private readonly log: ILogService,
    private readonly renderState: GitMemoryRenderState,
    private readonly visibility: () => MemoryVisibilityContext,
  ) {}

  forPath(path: string): Promise<MemoryEntryView[]> {
    return this.guard((patterns) => patterns.some((pattern) => picomatch.isMatch(path, pattern)));
  }

  unscoped(): Promise<MemoryEntryView[]> {
    return this.guard((patterns) => patterns.length === 0);
  }

  private async guard(matches: (patterns: string[]) => boolean): Promise<MemoryEntryView[]> {
    try {
      return await this.collect(matches);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.log.warn('git memory entries unavailable; injecting git history only', { error });
      }
      return [];
    }
  }

  synchronize(): MemoryVisibilityContext {
    const visibility = this.visibility();
    const identity = JSON.stringify(visibility);
    const generation = this.injectionState.generation;
    if (
      this.contentRevision !== this.store.revision ||
      this.visibilityIdentity !== identity ||
      this.generation !== generation
    ) {
      this.generation = generation;
      if (this.contentRevision !== undefined) this.renderState.clear();
      this.contentRevision = this.store.revision;
      this.visibilityIdentity = identity;
      this.entriesCache = undefined;
      this.shaCache = undefined;
    }
    return visibility;
  }

  private async collect(matches: (patterns: string[]) => boolean): Promise<MemoryEntryView[]> {
    this.synchronize();
    const views: MemoryEntryView[] = [];
    const shas = await this.commitShas();
    for (const entry of await this.entries()) {
      if (views.length >= MEMORY_BLOCK_MAX_ENTRIES) break;
      const patterns = this.scopes(entry.path, entry.body);
      if (!matches(patterns)) continue;
      const sha = shas.get(entry.path);
      if (sha === undefined) continue;
      if (this.renderState.hasMemory(sha)) continue;
      const view = this.view(entry, sha);
      if (this.injectionState.has(view.body)) continue;
      views.push(view);
    }
    return views;
  }

  claim(entries: readonly MemoryEntryView[]): void {
    for (const entry of entries) this.renderState.markMemory(entry.sha);
    this.injectionState.mark(entries.map((entry) => entry.body));
  }

  private async entries(): Promise<readonly MemoryRecord[]> {
    const revision = this.store.revision;
    if (this.entriesCache !== undefined && this.entriesCache.revision === revision) {
      return this.entriesCache.entries;
    }
    if (this.entriesCache !== undefined) {
      this.renderState.clearMemories();
    }
    const paths = await this.store.list();
    const visibility = this.visibility();
    const entries: MemoryRecord[] = [];
    for (const path of paths) {
      if (!isMemoryVisible(path, visibility)) continue;
      const entry = await this.store.get(path);
      if (entry === undefined || !isMemoryVisible(path, visibility, entry)) continue;
      entries.push({
        path,
        title: entry.title,
        body: entry.body,
        updatedAt: entry.updatedAt,
      });
    }
    this.entriesCache = { revision, entries };
    return entries;
  }

  private async commitShas(): Promise<Map<string, string>> {
    const revision = this.store.revision;
    if (this.shaCache !== undefined && this.shaCache.revision === revision) {
      return this.shaCache.map;
    }
    const map = await this.repo.recentCommitShas(MEMORY_SHA_HISTORY);
    this.shaCache = { revision, map };
    return map;
  }

  private scopes(path: string, body: string): string[] {
    const cached = this.renderState.scopes(path);
    if (cached !== undefined) return cached;
    const parsed = parseAppliesTo(body);
    this.renderState.setScopes(path, parsed);
    return parsed;
  }

  private view(entry: MemoryRecord, sha: string): MemoryEntryView {
    return {
      sha,
      date: new Date(entry.updatedAt).toISOString().slice(0, 10),
      title: entry.title,
      body: entry.body,
    };
  }
}
