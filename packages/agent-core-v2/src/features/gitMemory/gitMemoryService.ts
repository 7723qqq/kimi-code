import { t } from '@moonshot-ai/kimi-i18n';
import picomatch from 'picomatch';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { parseAppliesTo } from '#/app/memory/memoryPaths';
import { IMemoryRepo } from '#/app/memory/memoryRepo';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { LifecycleScope } from '#/app/scopes';
import { alreadyRendered, markRendered } from '#/agent/injection/renderedLines';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { GIT_MEMORY_FLAG_ID } from './flag';
import { readRepoMap } from './gitReader';
import type { GitUnavailableReason } from './gitReader';
import { GitMemoryIndexLoader } from './gitMemoryIndexLoader';
import type { GitMemoryIndexLoaderDeps } from './gitMemoryIndexLoader';
import {
  projectFileBlock,
  projectMemoryBlock,
  projectRepoBlock,
  projectRepoTree,
  projectSignalBlock,
} from './projection';
import type { MemoryEntryView } from './projection';
import {
  GIT_MEMORY_DIR_COMMITS,
  GIT_MEMORY_FILE_COMMITS,
  GIT_MEMORY_REPO_COMMITS,
  GIT_MEMORY_SIGNAL_COMMITS,
  GIT_MEMORY_SIGNAL_PATHS,
  GIT_MEMORY_TREE_DEPTH,
} from './types';
import type { CommitRecord, GitMemoryIndex } from './types';

const PATH_PATTERN =
  /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|rb|vue|json|jsonc|md|yaml|yml|toml)/g;

export const GIT_MEMORY_REPO_MAP_MAX_LINES = 2000;

export interface IGitMemoryService {
  readonly _serviceBrand: undefined;

  repoBlock(): Promise<string>;

  signalBlock(message: string): Promise<string>;

  fileBlock(path: string): Promise<string>;

  repoMap(path: string | undefined, depth: number): Promise<string>;
}

export const IGitMemoryService = createDecorator<IGitMemoryService>('gitMemoryService');

export class GitMemoryService extends Disposable implements IGitMemoryService {
  declare readonly _serviceBrand: undefined;

  private unavailableNotified = false;
  protected indexLoader: GitMemoryIndexLoader;
  private readonly renderedPaths = new Set<string>();
  private readonly renderedCommits = new Set<string>();
  private readonly renderedMemories = new Set<string>();
  private memoryStoreWarned = false;
  private readonly memoryScopeCache = new Map<string, string[]>();
  private shaCache: { readonly revision: number; readonly map: Map<string, string> } | undefined;
  private readonly directoryHistory = new Map<string, readonly CommitRecord[]>();
  private entriesCache:
    | {
        readonly revision: number;
        readonly entries: readonly {
          path: string;
          title: string;
          body: string;
          updatedAt: number;
        }[];
      }
    | undefined;

  constructor(
    @IHostProcessService private readonly process: IHostProcessService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
    @IMemoryStore private readonly memoryStore: IMemoryStore,
    @IMemoryRepo private readonly memoryRepo: IMemoryRepo,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
    this.indexLoader = this.createIndexLoader();
    this.reminders.register('git_memory_signal', ({ isNewTurn }) =>
      isNewTurn ? this.signalBlock(this.lastUserText()) : undefined,
    );
  }

  protected createIndexLoader(): GitMemoryIndexLoader {
    return new GitMemoryIndexLoader(this.indexLoaderDeps());
  }

  protected indexLoaderDeps(): GitMemoryIndexLoaderDeps {
    return {
      process: this.process,
      storeDir: this.bootstrap.storeDir,
      cwd: this.bootstrap.cwd,
      log: this.log,
      now: () => this.now(),
      onIndexChanged: () => {
        this.resetDerivedState();
      },
      onHeadUnavailable: (reason) => {
        this.notifyUnavailable(reason);
      },
    };
  }

  async repoBlock(): Promise<string> {
    if (!this.enabled()) return '';
    this.trimRenderState();
    try {
      const index = await this.indexLoader.ensureIndex();
      if (index === undefined) return '';
      const commits = index.commits.slice(0, GIT_MEMORY_REPO_COMMITS);
      const unscoped = await this.safeMemories(() => this.unscopedMemories());
      const parts: string[] = [];
      const repo = projectRepoBlock(commits);
      if (repo.length > 0) parts.push(repo);
      const tree = projectRepoTree(index.dirs, GIT_MEMORY_TREE_DEPTH);
      if (tree.length > 0) parts.push(tree);
      if (unscoped.length > 0) {
        parts.push(unscoped.map((entry) => projectMemoryBlock(entry)).join('\n'));
      }
      return parts.join('\n');
    } catch (error) {
      this.log.warn('git memory repo block failed', { error });
      return '';
    }
  }

  async fileBlock(path: string): Promise<string> {
    if (!this.enabled()) return '';
    this.trimRenderState();
    try {
      const index = await this.indexLoader.ensureIndex();
      if (index === undefined) return '';
      const key = this.toRepoPath(path);
      if (this.renderedPaths.has(key)) return '';
      const commits = this.commitsForPath(index, key);
      const memories = await this.safeMemories(() => this.memoriesForPath(key));
      const directory = directoryOf(key);
      const dirCommits = directory.length === 0 ? [] : this.commitsForDirectory(index, directory);
      if (commits.length === 0 && dirCommits.length === 0 && memories.length === 0) return '';
      this.renderedPaths.add(key);
      let block = projectFileBlock(key, commits, directory, dirCommits, this.renderedCommits);
      for (const commit of commits) this.renderedCommits.add(commit.sha);
      for (const commit of dirCommits) this.renderedCommits.add(commit.sha);
      if (memories.length > 0) {
        const rendered = memories.map((entry) => projectMemoryBlock(entry)).join('\n');
        block = block.length === 0 ? rendered : `${block}\n${rendered}`;
      }
      return block;
    } catch (error) {
      this.log.warn('git memory file block failed', { error });
      return '';
    }
  }

  async signalBlock(message: string): Promise<string> {
    if (!this.enabled()) return '';
    this.trimRenderState();
    try {
      const paths = this.extractPaths(message);
      if (paths.length === 0) return '';
      const index = await this.indexLoader.ensureIndex();
      if (index === undefined) return '';
      const blocks: string[] = [];
      for (const path of paths) {
        const commits = this.commitsForPath(index, path).slice(0, GIT_MEMORY_SIGNAL_COMMITS);
        if (commits.length === 0) continue;
        const block = projectSignalBlock(path, commits, this.renderedCommits);
        if (block.length === 0) continue;
        blocks.push(block);
        for (const commit of commits) this.renderedCommits.add(commit.sha);
      }
      if (blocks.length === 0) return '';
      return blocks.join('\n');
    } catch (error) {
      this.log.warn('git memory signal block failed', { error });
      return '';
    }
  }

  async repoMap(path: string | undefined, depth: number): Promise<string> {
    if (!this.enabled()) return '';
    try {
      const head = await this.indexLoader.ensureHead();
      if (head === undefined) return '';
      for (const candidate of this.repoPathCandidates(path)) {
        const entries = await readRepoMap(this.process, head.repoRoot, candidate);
        if (entries === undefined) return '';
        const lines = entries.filter((entry) => isWithinDepth(entry, candidate, depth));
        if (lines.length === 0) continue;
        const shown = lines.slice(0, GIT_MEMORY_REPO_MAP_MAX_LINES);
        if (shown.length < lines.length) {
          shown.push(
            `... and ${String(lines.length - shown.length)} more paths; narrow the path or raise the depth`,
          );
        }
        return shown.join('\n');
      }
      return '';
    } catch (error) {
      this.log.warn('git memory repo map failed', { error });
      return '';
    }
  }

  private repoPathCandidates(path: string | undefined): (string | undefined)[] {
    if (path === undefined || path.length === 0) return [undefined];
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    const candidates: (string | undefined)[] = [normalized];
    if (this.indexLoader.pathPrefix.length === 0) return candidates;
    const prefixed = normalized.startsWith(this.indexLoader.pathPrefix)
      ? normalized
      : `${this.indexLoader.pathPrefix}${normalized}`;
    if (prefixed !== normalized) candidates.push(prefixed);
    return candidates;
  }

  private commitsForPath(index: GitMemoryIndex, path: string): CommitRecord[] {
    const positions = index.byPath[path] ?? [];
    const commits: CommitRecord[] = [];
    for (const position of positions) {
      const commit = index.commits[position];
      if (commit !== undefined) commits.push(commit);
    }
    return commits.slice(0, GIT_MEMORY_FILE_COMMITS);
  }

  private commitsForDirectory(index: GitMemoryIndex, directory: string): readonly CommitRecord[] {
    const cached = this.directoryHistory.get(directory);
    if (cached !== undefined) return cached;
    const prefix = `${directory}/`;
    const commits: CommitRecord[] = [];
    for (const commit of index.commits) {
      if (!commit.files.some((file) => file.startsWith(prefix))) continue;
      commits.push(commit);
      if (commits.length >= GIT_MEMORY_DIR_COMMITS) break;
    }
    this.directoryHistory.set(directory, commits);
    return commits;
  }

  private async memoryEntries(): Promise<
    readonly { path: string; title: string; body: string; updatedAt: number }[]
  > {
    const revision = this.memoryStore.revision;
    if (this.entriesCache !== undefined && this.entriesCache.revision === revision) {
      return this.entriesCache.entries;
    }
    if (this.entriesCache !== undefined) {
        this.renderedMemories.clear();
    }
    const paths = await this.memoryStore.list();
    const entries: { path: string; title: string; body: string; updatedAt: number }[] = [];
    for (const path of paths) {
      const entry = await this.memoryStore.get(path);
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

  private async safeMemories(load: () => Promise<MemoryEntryView[]>): Promise<MemoryEntryView[]> {
    try {
      return await load();
    } catch (error) {
      if (!this.memoryStoreWarned) {
        this.memoryStoreWarned = true;
        this.log.warn('git memory entries unavailable; injecting git history only', { error });
      }
      return [];
    }
  }

  private async memoriesForPath(path: string): Promise<MemoryEntryView[]> {
    const views: MemoryEntryView[] = [];
    const shas = await this.commitShas();
    let chars = 0;
    for (const entry of await this.memoryEntries()) {
      if (views.length >= MEMORY_BLOCK_MAX_ENTRIES) break;
      if (chars >= MEMORY_BLOCK_MAX_CHARS) break;
      const patterns = this.memoryScopes(entry.path, entry.body);
      if (patterns.length === 0) continue;
      if (!patterns.some((pattern) => picomatch.isMatch(path, pattern))) continue;
      const sha = shas.get(entry.path);
      if (sha === undefined) continue;
      if (this.renderedMemories.has(sha)) continue;
      this.renderedMemories.add(sha);
      const view = this.memoryView(entry, sha);
      const sessionKey = this.session.sessionId;
      if (alreadyRendered(sessionKey, view.body)) continue;
      markRendered(sessionKey, [view.body]);
      chars += view.body.length;
      views.push(view);
    }
    return views;
  }

  private async unscopedMemories(): Promise<MemoryEntryView[]> {
    const views: MemoryEntryView[] = [];
    const shas = await this.commitShas();
    let chars = 0;
    for (const entry of await this.memoryEntries()) {
      if (views.length >= MEMORY_BLOCK_MAX_ENTRIES) break;
      if (chars >= MEMORY_BLOCK_MAX_CHARS) break;
      if (this.memoryScopes(entry.path, entry.body).length > 0) continue;
      const sha = shas.get(entry.path);
      if (sha === undefined) continue;
      if (this.renderedMemories.has(sha)) continue;
      this.renderedMemories.add(sha);
      const view = this.memoryView(entry, sha);
      const sessionKey = this.session.sessionId;
      if (alreadyRendered(sessionKey, view.body)) continue;
      markRendered(sessionKey, [view.body]);
      chars += view.body.length;
      views.push(view);
    }
    return views;
  }

  private memoryView(
    entry: { title: string; body: string; updatedAt: number },
    sha: string,
  ): MemoryEntryView {
    return {
      sha,
      date: new Date(entry.updatedAt).toISOString().slice(0, 10),
      title: entry.title,
      body: entry.body,
    };
  }

  private memoryScopes(path: string, body: string): string[] {
    const cached = this.memoryScopeCache.get(path);
    if (cached !== undefined) return cached;
    const parsed = parseAppliesTo(body);
    this.memoryScopeCache.set(path, parsed);
    return parsed;
  }

  private enabled(): boolean {
    try {
      return this.flags.enabled(GIT_MEMORY_FLAG_ID);
    } catch (error) {
      this.log.warn('git memory flag lookup failed', { error });
      return false;
    }
  }

  private notifyUnavailable(reason: GitUnavailableReason): void {
    if (this.unavailableNotified || !this.enabled()) return;
    this.unavailableNotified = true;
    const cwd = this.bootstrap.cwd;
    let message: string;
    switch (reason) {
      case 'not-a-repo':
        message = t('gitMemory.unavailable.notARepo', { cwd });
        break;
      case 'spawn-failed':
        message = t('gitMemory.unavailable.spawnFailed', { cwd });
        break;
      case 'permission':
        message = t('gitMemory.unavailable.permission', { cwd });
        break;
      case 'timeout':
        message = t('gitMemory.unavailable.timeout', { cwd });
        break;
    }
    void this.dispatcher.dispatch(
      new WarningIssued({
        agentId: this.scopeContext.agentId,
        code: 'git-memory-unavailable',
        message,
      }),
    );
  }

  private trimRenderState(): void {
    trimSet(this.renderedPaths);
    trimSet(this.renderedCommits);
    trimSet(this.renderedMemories);
    trimMap(this.directoryHistory);
    trimMap(this.memoryScopeCache);
  }

  private resetDerivedState(): void {
    this.renderedPaths.clear();
    this.renderedCommits.clear();
    this.renderedMemories.clear();
    this.memoryScopeCache.clear();
    this.directoryHistory.clear();
  }

  private async commitShas(): Promise<Map<string, string>> {
    const revision = this.memoryStore.revision;
    if (this.shaCache !== undefined && this.shaCache.revision === revision) {
      return this.shaCache.map;
    }
    const map = await this.memoryRepo.recentCommitShas(MEMORY_SHA_HISTORY);
    this.shaCache = { revision, map };
    return map;
  }

  protected now(): number {
    return Date.now();
  }

  private toRepoPath(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    if (this.indexLoader.repoRoot.length > 0) {
      const root = this.indexLoader.repoRoot.replaceAll('\\', '/').replace(/\/$/, '');
      if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
    }
    const relative = normalized.replace(/^\.\//, '');
    if (this.indexLoader.pathPrefix.length === 0) return relative;
    if (relative.startsWith(this.indexLoader.pathPrefix)) return relative;
    return `${this.indexLoader.pathPrefix}${relative}`;
  }

  private extractPaths(message: string): string[] {
    const found = message.match(PATH_PATTERN) ?? [];
    const unique: string[] = [];
    for (const item of found) {
      const key = this.toRepoPath(item);
      if (!unique.includes(key)) unique.push(key);
      if (unique.length >= GIT_MEMORY_SIGNAL_PATHS) break;
    }
    return unique;
  }

  private lastUserText(): string {
    const history = this.contextMemory.get();
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message?.role !== 'user') continue;
      for (const part of message.content ?? []) {
        if ('text' in part && part.text) return part.text;
      }
    }
    return '';
  }
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf('/');
  if (separator <= 0) return '';
  return path.slice(0, separator);
}

function isWithinDepth(entry: string, base: string | undefined, depth: number): boolean {
  if (base === undefined || base.length === 0) {
    return entry.split('/').length <= depth;
  }
  if (entry === base) return false;
  const prefix = `${base}/`;
  if (!entry.startsWith(prefix)) return false;
  return entry.slice(prefix.length).split('/').length <= depth;
}

const RENDER_STATE_CAP = 512;
const MEMORY_BLOCK_MAX_ENTRIES = 8;
const MEMORY_SHA_HISTORY = 200;
const MEMORY_BLOCK_MAX_CHARS = 4000;

function trimSet(set: Set<string>): void {
  while (set.size > RENDER_STATE_CAP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

function trimMap<K, V>(map: Map<K, V>): void {
  while (map.size > RENDER_STATE_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IGitMemoryService,
  GitMemoryService,
  ScopeActivation.OnScopeCreated,
  'gitMemory',
);
