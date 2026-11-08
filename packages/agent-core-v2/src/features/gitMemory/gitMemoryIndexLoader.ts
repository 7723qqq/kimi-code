import type { ILogService } from '#/_base/log/log';
import { errorMessage } from '#/_base/utils/errorMessage';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import {
  buildIndex,
  cachePath,
  readAnyIndex,
  readIndex,
  removeLegacyIndex,
  writeIndex,
} from './cache';
import { readGitHistory, readRepoHead, readRepoTree } from './gitReader';
import type { GitUnavailableReason, RepoHead, RepoHeadResult } from './gitReader';
import { GIT_MEMORY_WINDOW } from './types';
import type { GitMemoryIndex } from './types';

const TRANSIENT_FAILURE_COOLDOWN_MS = 10_000;
const DETERMINISTIC_HEAD_FAILURE_TTL_MS = 60_000;

export interface GitMemoryIndexLoaderDeps {
  readonly process: IHostProcessService;
  readonly storeDir: string;
  readonly cwd: string;
  readonly log: ILogService;
  readonly now: () => number;
  readonly onIndexChanged: () => void;
  readonly onHeadUnavailable: (reason: GitUnavailableReason) => void;
}

export class GitMemoryIndexLoader {
  private index: GitMemoryIndex | undefined;
  private indexLoaded = false;
  private indexFailure: { readonly at: number } | undefined;
  private loading: Promise<void> | undefined;
  private refresh: Promise<void> | undefined;
  private headValue: RepoHead | undefined;
  private headLoaded = false;
  private headFailure: { readonly reason: GitUnavailableReason; readonly at: number } | undefined;
  private headLoading: Promise<void> | undefined;
  private rootValue = '';
  private prefixValue = '';
  private cleanedLegacyRoot = '';

  constructor(private readonly deps: GitMemoryIndexLoaderDeps) {}

  get repoRoot(): string {
    return this.rootValue;
  }

  get pathPrefix(): string {
    return this.prefixValue;
  }

  async ensureIndex(): Promise<GitMemoryIndex | undefined> {
    if (this.indexLoaded) return this.index;
    if (
      this.indexFailure !== undefined &&
      this.deps.now() - this.indexFailure.at < TRANSIENT_FAILURE_COOLDOWN_MS
    ) {
      return undefined;
    }
    if (this.loading === undefined) {
      this.loading = this.loadIndex()
        .then((index) => {
          if (index === undefined) {
            if (this.headValue !== undefined) this.indexFailure = { at: this.deps.now() };
            return;
          }
          this.index = index;
          this.deps.onIndexChanged();
          this.indexLoaded = true;
          this.indexFailure = undefined;
        })
        .catch((error) => {
          this.deps.log.warn('git memory index load failed', { error });
          if (this.headValue !== undefined) this.indexFailure = { at: this.deps.now() };
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.loading;
    return this.index;
  }

  async ensureHead(): Promise<RepoHead | undefined> {
    if (this.headLoaded) return this.headValue;
    if (this.headFailure !== undefined) {
      const cooldown =
        this.headFailure.reason === 'timeout'
          ? TRANSIENT_FAILURE_COOLDOWN_MS
          : DETERMINISTIC_HEAD_FAILURE_TTL_MS;
      if (this.deps.now() - this.headFailure.at < cooldown) return undefined;
    }
    if (this.headLoading === undefined) {
      this.headLoading = this.loadHead()
        .then((result) => {
          if (result.kind === 'ok') {
            this.headValue = result.head;
            this.headLoaded = true;
            this.headFailure = undefined;
            return;
          }
          this.headFailure = { reason: result.reason, at: this.deps.now() };
          this.deps.log.warn('git memory head lookup failed', {
            cwd: this.deps.cwd,
            reason: result.reason,
            detail: result.detail,
          });
          this.deps.onHeadUnavailable(result.reason);
        })
        .catch((error) => {
          const detail = errorMessage(error);
          this.headFailure = { reason: 'timeout', at: this.deps.now() };
          this.deps.log.warn('git memory head lookup failed', {
            cwd: this.deps.cwd,
            reason: 'timeout',
            detail,
          });
          this.deps.onHeadUnavailable('timeout');
        })
        .finally(() => {
          this.headLoading = undefined;
        });
    }
    await this.headLoading;
    return this.headValue;
  }

  protected async loadIndex(): Promise<GitMemoryIndex | undefined> {
    const head = await this.ensureHead();
    if (head === undefined) return undefined;
    await this.cleanLegacyIndex(head.repoRoot);

    const path = cachePath(this.deps.storeDir, head.repoRoot);
    const cached = await readIndex(path, head.headSha, GIT_MEMORY_WINDOW);
    if (cached.kind === 'hit') return cached.index;
    if (cached.kind === 'miss') {
      const stale = await readAnyIndex(path);
      if (stale !== undefined) {
        this.scheduleRefresh(head, path);
        return stale;
      }
    } else {
      this.deps.log.warn('git memory cache was corrupted; rebuilding it');
    }
    return this.rebuild(head, path);
  }

  protected async loadHead(): Promise<RepoHeadResult> {
    const result = await readRepoHead(this.deps.process, this.deps.cwd);
    if (result.kind === 'unavailable') return result;
    this.rootValue = result.head.repoRoot;
    this.prefixValue = result.head.prefix;
    return result;
  }

  private async cleanLegacyIndex(repoRoot: string): Promise<void> {
    if (this.cleanedLegacyRoot === repoRoot) return;
    this.cleanedLegacyRoot = repoRoot;
    const removed = await removeLegacyIndex(repoRoot);
    if (removed) this.deps.log.debug('git memory legacy cache removed', { repoRoot });
  }

  private scheduleRefresh(head: RepoHead, path: string): void {
    if (this.refresh !== undefined) return;
    this.refresh = this.rebuild(head, path)
      .then((index) => {
        if (index !== undefined) {
          this.index = index;
          this.deps.onIndexChanged();
        }
      })
      .catch((error) => {
        this.deps.log.warn('git memory refresh failed', { error });
      })
      .finally(() => {
        this.refresh = undefined;
      });
  }

  private async rebuild(head: RepoHead, path: string): Promise<GitMemoryIndex | undefined> {
    const history = await readGitHistory(
      this.deps.process,
      head.repoRoot,
      GIT_MEMORY_WINDOW,
      head.headSha,
    );
    if (history.kind !== 'ok') return undefined;
    const dirs = await readRepoTree(this.deps.process, head.repoRoot);
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
      this.deps.log.warn('git memory cache could not be written; continuing without it');
    }
    return index;
  }
}
