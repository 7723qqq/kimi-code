import picomatch from 'picomatch';

import type { ILogService } from '#/_base/log/log';
import { alreadyRendered, markRendered } from '#/agent/injection/renderedLines';
import { parseAppliesTo } from '#/app/memory/memoryPaths';
import type { IMemoryRepo } from '#/app/memory/memoryRepo';
import type { IMemoryStore } from '#/app/memory/memoryStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';

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

  constructor(
    private readonly store: IMemoryStore,
    private readonly repo: IMemoryRepo,
    private readonly session: ISessionContext,
    private readonly log: ILogService,
    private readonly renderState: GitMemoryRenderState,
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

  private async collect(matches: (patterns: string[]) => boolean): Promise<MemoryEntryView[]> {
    const views: MemoryEntryView[] = [];
    const shas = await this.commitShas();
    for (const entry of await this.entries()) {
      if (views.length >= MEMORY_BLOCK_MAX_ENTRIES) break;
      const patterns = this.scopes(entry.path, entry.body);
      if (!matches(patterns)) continue;
      const sha = shas.get(entry.path);
      if (sha === undefined) continue;
      if (this.renderState.hasMemory(sha)) continue;
      this.renderState.markMemory(sha);
      const view = this.view(entry, sha);
      const sessionKey = this.session.sessionId;
      if (alreadyRendered(sessionKey, view.body)) continue;
      markRendered(sessionKey, [view.body]);
      views.push(view);
    }
    return views;
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
    const entries: MemoryRecord[] = [];
    for (const path of paths) {
      const entry = await this.store.get(path);
      if (entry === undefined) continue;
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
