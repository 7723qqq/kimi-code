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
const HEAD_SUCCESS_TTL_MS = 2_000;

export interface EnsureIndexOptions {
  readonly forceHead?: boolean;
  readonly forceRebuild?: boolean;
}

export interface GitMemoryIndexLoaderDeps {
  readonly process: IHostProcessService;
  readonly storeDir: string;
  readonly cwd: string;
  readonly log: ILogService;
  readonly now: () => number;
  readonly onIndexChanged: () => void;
  readonly onHeadChanged?: () => void;
  readonly onHeadUnavailable: (reason: GitUnavailableReason) => void;
}

export class GitMemoryIndexLoader {
  private index: GitMemoryIndex | undefined;
  private indexLoaded = false;
  private indexFailure: { readonly at: number } | undefined;
  private readonly loading = new Map<string, Promise<GitMemoryIndex | undefined>>();
  private readonly refresh = new Map<string, Promise<void>>();
  private headValue: RepoHead | undefined;
  private headLoaded = false;
  private headCheckedAt = Number.NEGATIVE_INFINITY;
  private headGeneration = 0;
  private headFailure: { readonly reason: GitUnavailableReason; readonly at: number } | undefined;
  private headLoading: Promise<void> | undefined;
  private rootValue = '';
  private prefixValue = '';
  private cleanedLegacyRoot = '';
  private cacheWrites: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GitMemoryIndexLoaderDeps) {}

  get repoRoot(): string {
    return this.rootValue;
  }

  get pathPrefix(): string {
    return this.prefixValue;
  }

  get observedHeadSha(): string | undefined {
    return this.headValue?.headSha;
  }

  get snapshotHeadSha(): string | undefined {
    return this.index?.headSha;
  }

  async ensureIndex(options: EnsureIndexOptions = {}): Promise<GitMemoryIndex | undefined> {
    const head = await this.ensureHead(options.forceHead === true);
    if (head === undefined) return this.index;
    if (this.indexLoaded && (!options.forceRebuild || this.index?.headSha === head.headSha))
      return this.index;
    if (
      this.indexFailure !== undefined &&
      this.deps.now() - this.indexFailure.at < TRANSIENT_FAILURE_COOLDOWN_MS
    ) {
      return this.index;
    }
    const identity = this.identity(head);
    let loading = this.loading.get(identity);
    if (loading === undefined) {
      const generation = this.headGeneration;
      loading = this.loadIndex(head, options.forceRebuild === true)
        .then((index) => {
          if (index === undefined) {
            if (generation === this.headGeneration) this.indexFailure = { at: this.deps.now() };
            return this.index;
          }
          if (generation !== this.headGeneration) return this.index;
          if (index.headSha !== head.headSha) {
            this.indexLoaded = false;
            return this.index ?? index;
          }
          this.index = index;
          this.deps.onIndexChanged();
          this.indexLoaded = true;
          this.indexFailure = undefined;
          return index;
        })
        .catch((error) => {
          this.deps.log.warn('git memory index load failed', { error });
          if (generation === this.headGeneration) this.indexFailure = { at: this.deps.now() };
          return this.index;
        })
        .finally(() => {
          this.loading.delete(identity);
        });
      this.loading.set(identity, loading);
    }
    return loading;
  }

  async ensureHead(force = false): Promise<RepoHead | undefined> {
    const now = this.deps.now();
    if (this.headLoaded && !force && now - this.headCheckedAt < HEAD_SUCCESS_TTL_MS)
      return this.headValue;
    if (this.headFailure !== undefined) {
      const cooldown =
        this.headFailure.reason === 'timeout'
          ? TRANSIENT_FAILURE_COOLDOWN_MS
          : DETERMINISTIC_HEAD_FAILURE_TTL_MS;
      if (now - this.headFailure.at < cooldown) return this.headValue;
    }
    if (this.headLoading === undefined) {
      const previous = this.headValue;
      this.headLoading = this.loadHead()
        .then((result) => {
          if (result.kind === 'ok') {
            this.headValue = result.head;
            this.headLoaded = true;
            this.headCheckedAt = this.deps.now();
            this.headFailure = undefined;
            if (previous !== undefined && this.identity(previous) !== this.identity(result.head)) {
              this.headGeneration += 1;
              this.indexLoaded = false;
              this.indexFailure = undefined;
              this.deps.onHeadChanged?.();
            }
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

  protected async loadIndex(
    head: RepoHead,
    forceRebuild = false,
  ): Promise<GitMemoryIndex | undefined> {
    await this.cleanLegacyIndex(head.repoRoot);

    const path = cachePath(this.deps.storeDir, head.repoRoot);
    if (!forceRebuild) {
      const cached = await readIndex(path, head.headSha, GIT_MEMORY_WINDOW);
      if (cached.kind === 'hit') return cached.index;
      if (cached.kind === 'miss') {
        const stale = await readAnyIndex(path);
        if (stale !== undefined) {
          this.scheduleRefresh(head, path, this.headGeneration);
          return stale;
        }
      } else {
        this.deps.log.warn('git memory cache was corrupted; rebuilding it');
      }
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

  private scheduleRefresh(head: RepoHead, path: string, generation: number): void {
    const identity = this.identity(head);
    if (this.refresh.has(identity)) return;
    const refresh = this.rebuild(head, path)
      .then((index) => {
        if (
          index !== undefined &&
          generation === this.headGeneration &&
          this.headValue !== undefined &&
          this.identity(this.headValue) === identity
        ) {
          this.index = index;
          this.indexLoaded = index.headSha === this.headValue?.headSha;
          this.indexFailure = undefined;
          this.deps.onIndexChanged();
        }
      })
      .catch((error) => {
        this.deps.log.warn('git memory refresh failed', { error });
      })
      .finally(() => {
        this.refresh.delete(identity);
      });
    this.refresh.set(identity, refresh);
  }

  private identity(head: RepoHead): string {
    return `${head.repoRoot}\0${head.prefix}\0${head.headSha}`;
  }

  private async rebuild(head: RepoHead, path: string): Promise<GitMemoryIndex | undefined> {
    const history = await readGitHistory(
      this.deps.process,
      head.repoRoot,
      GIT_MEMORY_WINDOW,
      head.headSha,
    );
    if (history.kind !== 'ok') return undefined;
    const dirs = await readRepoTree(this.deps.process, head.repoRoot, undefined, head.headSha);
    const index = buildIndex(
      head.repoRoot,
      history.headSha,
      GIT_MEMORY_WINDOW,
      history.commits,
      new Date().toISOString(),
      dirs ?? [],
    );
    const write = this.cacheWrites.then(async () => {
      if (this.headValue === undefined || this.identity(head) !== this.identity(this.headValue))
        return;
      const written = await writeIndex(path, index);
      if (!written)
        this.deps.log.warn('git memory cache could not be written; continuing without it');
    });
    this.cacheWrites = write.catch((error) => {
      this.deps.log.warn('git memory cache write failed', { error });
    });
    await write;
    return index;
  }
}
