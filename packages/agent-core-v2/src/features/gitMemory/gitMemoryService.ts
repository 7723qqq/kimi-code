import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { IAgentReminderService } from '#/features/reminder/reminderService';

import { buildIndex, cachePath, readIndex, writeIndex } from './cache';
import { GIT_MEMORY_FLAG_ID } from './flag';
import { computeFacts } from './gitFacts';
import { readGitHistory, readRepoHead } from './gitReader';
import { renderFileBlock, renderRepoBlock, renderSignalBlock } from './render';
import { GIT_MEMORY_WINDOW } from './types';
import type { GitMemoryIndex } from './types';

const PATH_PATTERN =
  /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|rb|vue|json|jsonc|md|yaml|yml|toml)/g;
const SIGNAL_PATH_LIMIT = 2;

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
  private repoRoot = '';
  private pathPrefix = '';
  private readonly renderedPaths = new Set<string>();
  private readonly renderedGroups = new Set<string>();

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
    if (cached.kind === 'corrupt') {
      this.log.warn('git memory cache was corrupted; rebuilding it');
    }

    const history = await readGitHistory(this.process, head.repoRoot, GIT_MEMORY_WINDOW);
    if (history.kind !== 'ok') return undefined;
    const index = buildIndex(
      head.repoRoot,
      history.headSha,
      GIT_MEMORY_WINDOW,
      computeFacts(history.commits),
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
      return renderRepoBlock(index.facts);
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
      const groups = index.facts.fileChanges[key] ?? [];
      const partners = index.facts.filePartners[key] ?? [];
      if (groups.length === 0 && partners.length === 0) return '';
      this.renderedPaths.add(key);
      const block = renderFileBlock(key, groups, partners, this.renderedGroups);
      for (const group of groups) this.renderedGroups.add(group.sha);
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
      const entries = paths
        .map((path) => ({ path, groups: index.facts.fileChanges[path] ?? [] }))
        .filter((entry) => entry.groups.length > 0);
      if (entries.length === 0) return '';
      const block = renderSignalBlock(entries, this.renderedGroups);
      for (const entry of entries) {
        for (const group of entry.groups) this.renderedGroups.add(group.sha);
      }
      return block;
    } catch (error) {
      this.log.warn('git memory signal block failed', { error });
      return '';
    }
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
      if (unique.length >= SIGNAL_PATH_LIMIT) break;
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
