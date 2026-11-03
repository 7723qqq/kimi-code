import picomatch from 'picomatch';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { errorMessage } from '#/_base/utils/errorMessage';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { parseAppliesTo } from '#/app/memory/memoryPaths';
import { IMemoryRepo } from '#/app/memory/memoryRepo';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { buildIndex, cachePath, readAnyIndex, readIndex, writeIndex } from './cache';
import { GIT_MEMORY_FLAG_ID } from './flag';
import { readGitHistory, readRepoHead, readRepoMap, readRepoTree } from './gitReader';
import type { GitUnavailableReason, RepoHead, RepoHeadResult } from './gitReader';
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
  GIT_MEMORY_WINDOW,
} from './types';
import type { CommitRecord, GitMemoryIndex } from './types';

const PATH_PATTERN =
  /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|rb|vue|json|jsonc|md|yaml|yml|toml)/g;
const TRANSIENT_FAILURE_COOLDOWN_MS = 10_000;
const DETERMINISTIC_HEAD_FAILURE_TTL_MS = 60_000;

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

  private index: GitMemoryIndex | undefined;
  private indexLoaded = false;
  private indexFailure: { readonly at: number } | undefined;
  private loading: Promise<void> | undefined;
  private refresh: Promise<void> | undefined;
  private head: RepoHead | undefined;
  private headLoaded = false;
  private headFailure: { readonly reason: GitUnavailableReason; readonly at: number } | undefined;
  private headLoading: Promise<void> | undefined;
  protected repoRoot = '';
  protected pathPrefix = '';
  private readonly renderedPaths = new Set<string>();
  private readonly renderedCommits = new Set<string>();
  private readonly renderedMemories = new Set<string>();
  private memoryStoreWarned = false;
  private readonly memoryScopeCache = new Map<string, string[]>();
  private readonly directoryHistory = new Map<string, readonly CommitRecord[]>();

  constructor(
    @IHostProcessService private readonly process: IHostProcessService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
    @IMemoryStore private readonly memoryStore: IMemoryStore,
    @IMemoryRepo private readonly memoryRepo: IMemoryRepo,
  ) {
    super();
    this.reminders.register('git_memory_signal', ({ isNewTurn }) =>
      isNewTurn ? this.signalBlock(this.lastUserText()) : undefined,
    );
  }

  protected async loadIndex(): Promise<GitMemoryIndex | undefined> {
    const head = await this.ensureHead();
    if (head === undefined) return undefined;

    const path = cachePath(head.repoRoot);
    const cached = await readIndex(path, head.headSha, GIT_MEMORY_WINDOW);
    if (cached.kind === 'hit') return cached.index;
    if (cached.kind === 'miss') {
      const stale = await readAnyIndex(path);
      if (stale !== undefined) {
        this.scheduleRefresh(head, path);
        return stale;
      }
    } else {
      this.log.warn('git memory cache was corrupted; rebuilding it');
    }
    return this.rebuild(head, path);
  }

  private scheduleRefresh(head: RepoHead, path: string): void {
    if (this.refresh !== undefined) return;
    this.refresh = this.rebuild(head, path)
      .then((index) => {
        if (index !== undefined) this.index = index;
      })
      .catch((error) => {
        this.log.warn('git memory refresh failed', { error });
      })
      .finally(() => {
        this.refresh = undefined;
      });
  }

  private async rebuild(head: RepoHead, path: string): Promise<GitMemoryIndex | undefined> {
    const history = await readGitHistory(
      this.process,
      head.repoRoot,
      GIT_MEMORY_WINDOW,
      head.headSha,
    );
    if (history.kind !== 'ok') return undefined;
    const dirs = await readRepoTree(this.process, head.repoRoot);
    const index = buildIndex(
      head.repoRoot,
      history.headSha,
      GIT_MEMORY_WINDOW,
      history.commits,
      new Date().toISOString(),
      dirs ?? [],
    );
    const written = await writeIndex(path, index);
    if (!written) {
      this.log.warn('git memory cache could not be written; continuing without it');
    }
    return index;
  }

  async repoBlock(): Promise<string> {
    if (!this.enabled()) return '';
    try {
      const index = await this.ensureIndex();
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
    try {
      const index = await this.ensureIndex();
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
    try {
      const paths = this.extractPaths(message);
      if (paths.length === 0) return '';
      const index = await this.ensureIndex();
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
      const head = await this.ensureHead();
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
    if (this.pathPrefix.length === 0) return candidates;
    const prefixed = normalized.startsWith(this.pathPrefix)
      ? normalized
      : `${this.pathPrefix}${normalized}`;
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
    for (const entry of await this.memoryEntries()) {
      const patterns = this.memoryScopes(entry.path, entry.body);
      if (patterns.length === 0) continue;
      if (!patterns.some((pattern) => picomatch.isMatch(path, pattern))) continue;
      const sha = await this.memoryRepo.lastCommitSha(entry.path);
      if (sha === undefined) continue;
      if (this.renderedMemories.has(sha)) continue;
      this.renderedMemories.add(sha);
      views.push(this.memoryView(entry, sha));
    }
    return views;
  }

  private async unscopedMemories(): Promise<MemoryEntryView[]> {
    const views: MemoryEntryView[] = [];
    for (const entry of await this.memoryEntries()) {
      if (this.memoryScopes(entry.path, entry.body).length > 0) continue;
      const sha = await this.memoryRepo.lastCommitSha(entry.path);
      if (sha === undefined) continue;
      if (this.renderedMemories.has(sha)) continue;
      this.renderedMemories.add(sha);
      views.push(this.memoryView(entry, sha));
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

  private async ensureIndex(): Promise<GitMemoryIndex | undefined> {
    if (this.indexLoaded) return this.index;
    if (
      this.indexFailure !== undefined &&
      this.now() - this.indexFailure.at < TRANSIENT_FAILURE_COOLDOWN_MS
    ) {
      return undefined;
    }
    if (this.loading === undefined) {
      this.loading = this.loadIndex()
        .then((index) => {
          if (index === undefined) {
            if (this.head !== undefined) this.indexFailure = { at: this.now() };
            return;
          }
          this.index = index;
          this.indexLoaded = true;
          this.indexFailure = undefined;
        })
        .catch((error) => {
          this.log.warn('git memory index load failed', { error });
          if (this.head !== undefined) this.indexFailure = { at: this.now() };
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.loading;
    return this.index;
  }

  protected async ensureHead(): Promise<RepoHead | undefined> {
    if (this.headLoaded) return this.head;
    if (this.headFailure !== undefined) {
      const cooldown =
        this.headFailure.reason === 'timeout'
          ? TRANSIENT_FAILURE_COOLDOWN_MS
          : DETERMINISTIC_HEAD_FAILURE_TTL_MS;
      if (this.now() - this.headFailure.at < cooldown) return undefined;
    }
    if (this.headLoading === undefined) {
      this.headLoading = this.loadHead()
        .then((result) => {
          if (result.kind === 'ok') {
            this.head = result.head;
            this.headLoaded = true;
            this.headFailure = undefined;
            return;
          }
          this.headFailure = { reason: result.reason, at: this.now() };
          this.log.warn('git memory head lookup failed', {
            cwd: this.bootstrap.cwd,
            reason: result.reason,
            detail: result.detail,
          });
        })
        .catch((error) => {
          const detail = errorMessage(error);
          this.headFailure = { reason: 'timeout', at: this.now() };
          this.log.warn('git memory head lookup failed', {
            cwd: this.bootstrap.cwd,
            reason: 'timeout',
            detail,
          });
        })
        .finally(() => {
          this.headLoading = undefined;
        });
    }
    await this.headLoading;
    return this.head;
  }

  protected now(): number {
    return Date.now();
  }

  protected async loadHead(): Promise<RepoHeadResult> {
    const result = await readRepoHead(this.process, this.bootstrap.cwd);
    if (result.kind === 'unavailable') return result;
    this.repoRoot = result.head.repoRoot;
    this.pathPrefix = result.head.prefix;
    return result;
  }

  private toRepoPath(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    if (this.repoRoot.length > 0) {
      const root = this.repoRoot.replaceAll('\\', '/').replace(/\/$/, '');
      if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
    }
    const relative = normalized.replace(/^\.\//, '');
    if (this.pathPrefix.length === 0) return relative;
    if (relative.startsWith(this.pathPrefix)) return relative;
    return `${this.pathPrefix}${relative}`;
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

registerScopedService(
  LifecycleScope.Agent,
  IGitMemoryService,
  GitMemoryService,
  ScopeActivation.OnScopeCreated,
  'gitMemory',
);
