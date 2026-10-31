import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { buildIndex, cachePath, readAnyIndex, readIndex, writeIndex } from './cache';
import { GIT_MEMORY_FLAG_ID } from './flag';
import { readGitHistory, readRepoHead } from './gitReader';
import type { RepoHead } from './gitReader';
import { projectFileBlock, projectRepoBlock, projectSignalBlock } from './projection';
import {
  GIT_MEMORY_FILE_COMMITS,
  GIT_MEMORY_REPO_COMMITS,
  GIT_MEMORY_SIGNAL_COMMITS,
  GIT_MEMORY_SIGNAL_PATHS,
  GIT_MEMORY_WINDOW,
} from './types';
import type { CommitRecord, GitMemoryIndex } from './types';

const PATH_PATTERN =
  /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|rb|vue|json|jsonc|md|yaml|yml|toml)/g;

export interface IGitMemoryService {
  readonly _serviceBrand: undefined;

  repoBlock(): Promise<string>;

  signalBlock(message: string): Promise<string>;

  fileBlock(path: string): Promise<string>;
}

export const IGitMemoryService = createDecorator<IGitMemoryService>('gitMemoryService');

export class GitMemoryService extends Disposable implements IGitMemoryService {
  declare readonly _serviceBrand: undefined;

  private index: GitMemoryIndex | undefined;
  private indexLoaded = false;
  private loading: Promise<void> | undefined;
  private refresh: Promise<void> | undefined;
  private repoRoot = '';
  private pathPrefix = '';
  private readonly renderedPaths = new Set<string>();
  private readonly renderedCommits = new Set<string>();

  constructor(
    @IHostProcessService private readonly process: IHostProcessService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
  ) {
    super();
    this.reminders.register('git_memory_signal', ({ isNewTurn }) =>
      isNewTurn ? this.signalBlock(this.lastUserText()) : undefined,
    );
  }

  protected async loadIndex(): Promise<GitMemoryIndex | undefined> {
    const head = await readRepoHead(this.process, this.bootstrap.cwd);
    if (head === undefined) return undefined;
    this.repoRoot = head.repoRoot;
    this.pathPrefix = head.prefix;

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

  private async rebuild(
    head: RepoHead,
    path: string,
  ): Promise<GitMemoryIndex | undefined> {
    const history = await readGitHistory(this.process, head.repoRoot, GIT_MEMORY_WINDOW);
    if (history.kind !== 'ok') return undefined;
    const index = buildIndex(
      head.repoRoot,
      history.headSha,
      GIT_MEMORY_WINDOW,
      history.commits,
      new Date().toISOString(),
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
      return projectRepoBlock(index.commits.slice(0, GIT_MEMORY_REPO_COMMITS));
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
      if (commits.length === 0) return '';
      this.renderedPaths.add(key);
      const block = projectFileBlock(key, commits, this.renderedCommits);
      for (const commit of commits) this.renderedCommits.add(commit.sha);
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

  private commitsForPath(index: GitMemoryIndex, path: string): CommitRecord[] {
    const positions = index.byPath[path] ?? [];
    const commits: CommitRecord[] = [];
    for (const position of positions) {
      const commit = index.commits[position];
      if (commit !== undefined) commits.push(commit);
    }
    return commits.slice(0, GIT_MEMORY_FILE_COMMITS);
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
    if (this.loading === undefined) {
      this.loading = this.loadIndex()
        .then((index) => {
          this.index = index;
          this.indexLoaded = true;
        })
        .catch((error) => {
          this.log.warn('git memory index load failed', { error });
          this.indexLoaded = true;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.loading;
    return this.index;
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

registerScopedService(
  LifecycleScope.Agent,
  IGitMemoryService,
  GitMemoryService,
  ScopeActivation.OnScopeCreated,
  'gitMemory',
);
