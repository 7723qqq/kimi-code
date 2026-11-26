import { Disposable, DisposableStore, MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { isAncestorOrSelf, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IProjectService } from '#/app/project/project';
import { IProjectPersistence } from '#/app/project/projectPersistence';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import type { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';
import { defineState } from '#/state/state';
import { IProjectStateService } from '#/project/state/projectState';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { watchCandidates } from '#human/utils/watch';

import type { IProjectDirs } from './projectDirs';
import { type WorkspaceAddDirInput, type WorkspaceAdditionalDirsResult } from './projectDirs';

const WATCH_DEBOUNCE_MS = 200;

export const workspaceDirsFileDirsKey = defineState<readonly string[]>(
  'workspaceDirs.fileDirs',
  () => [],
);
export const workspaceDirsEphemeralDirsKey = defineState<readonly string[]>(
  'workspaceDirs.ephemeralDirs',
  () => [],
);
export const workspaceDirsRegistryDirsKey = defineState<readonly string[]>(
  'workspaceDirs.registryDirs',
  () => [],
);
export const workspaceDirsPrimaryByWorkspaceKey = defineState<Readonly<Record<string, string>>>(
  'workspaceDirs.ISessionProjectInfo',
  () => ({}),
);

export class WorkspaceDirsService extends Disposable implements IProjectDirs {
  declare readonly _serviceBrand: undefined;

  private projectRoot: string;
  private configPath: string;
  private readonly legacyProjectConfig: boolean;
  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly localConfigWatcher = this._register(new MutableDisposable<IDisposable>());
  private mutationTail: Promise<void> = Promise.resolve();
  private registryReloadQueued = false;
  private changeBatchDepth = 0;
  private changePending = false;

  constructor(
    @IProjectContext private readonly workspace: IProjectContext,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @ILogService private readonly log: ILogService,
    @IProjectStateService private readonly states: IProjectStateService,
    @IProjectService private readonly workspaces: IProjectService,
    @IProjectPersistence private readonly workspaceStore: IProjectPersistence,
    private readonly environmentId = LOCAL_ENVIRONMENT_ID,
    private readonly followsPrimary = environmentId === LOCAL_ENVIRONMENT_ID,
  ) {
    super();
    this.states.contributeState(workspaceDirsFileDirsKey);
    this.states.contributeState(workspaceDirsEphemeralDirsKey);
    this.states.contributeState(workspaceDirsRegistryDirsKey);
    this.states.contributeState(workspaceDirsPrimaryByWorkspaceKey);
    this.projectRoot = workspace.cwd;
    this.configPath = '';
    this.legacyProjectConfig = workspace.meta.kind !== 'managed';
    this.ready = this.enqueue(() => this.reloadWorkspace(true));
    this._register(
      this.workspaceStore.onDidChange(() => {
        if (this.registryReloadQueued) return;
        this.registryReloadQueued = true;
        void this.enqueue(async () => {
          this.registryReloadQueued = false;
          await this.reloadWorkspace();
        }).catch((error) => {
          this.log.warn(`workspace registry reload failed: ${String(error)}`);
        });
      }),
    );
  }

  private get fileDirs(): readonly string[] {
    return this.states.get(workspaceDirsFileDirsKey);
  }

  private set fileDirs(value: readonly string[]) {
    this.states.set(workspaceDirsFileDirsKey, value);
  }

  private get ephemeralDirs(): readonly string[] {
    return this.states.get(workspaceDirsEphemeralDirsKey);
  }

  private set ephemeralDirs(value: readonly string[]) {
    this.states.set(workspaceDirsEphemeralDirsKey, value);
  }

  private get registryDirs(): readonly string[] {
    return this.states.get(workspaceDirsRegistryDirsKey);
  }

  private set registryDirs(value: readonly string[]) {
    this.states.set(workspaceDirsRegistryDirsKey, value);
  }

  get ISessionProjectInfo(): Readonly<Record<string, string>> {
    return this.states.get(workspaceDirsPrimaryByWorkspaceKey);
  }

  private set ISessionProjectInfo(value: Readonly<Record<string, string>>) {
    this.states.set(workspaceDirsPrimaryByWorkspaceKey, value);
  }

  private readonly ephemeralRefs = new Map<string, number>();

  get primary(): string {
    if (this.environmentId !== LOCAL_ENVIRONMENT_ID || !this.followsPrimary) {
      return this.workspace.cwd;
    }
    return this.ISessionProjectInfo[this.workspace.workspaceId] ?? this.workspace.meta.root;
  }

  get sharedAdditionalDirs(): readonly string[] {
    return [...new Set([...this.fileDirs, ...this.registryDirs])];
  }

  get additionalDirs(): readonly string[] {
    return [...new Set([...this.sharedAdditionalDirs, ...this.ephemeralDirs])];
  }

  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult> {
    return this.enqueue(() => this.applyAddDir(input));
  }

  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<IDisposable> {
    if (dirs.length === 0) return Promise.resolve({ dispose: () => {} });
    return this.enqueue(async () => {
      const resolved = await this.localConfig.resolveAdditionalDirs(baseDir, dirs, 'session');
      if (this.unionEphemeral(resolved)) {
        this.onDidChangeEmitter.fire();
      }
      let released = false;
      return {
        dispose: () => {
          if (released) return;
          released = true;
          if (this.releaseEphemeral(resolved)) {
            this.onDidChangeEmitter.fire();
          }
        },
      };
    });
  }

  private releaseEphemeral(dirs: readonly string[]): boolean {
    const before = this.additionalDirs;
    for (const dir of dirs) {
      const count = this.ephemeralRefs.get(dir);
      if (count === undefined) continue;
      if (count <= 1) {
        this.ephemeralRefs.delete(dir);
      } else {
        this.ephemeralRefs.set(dir, count - 1);
      }
    }
    this.ephemeralDirs = [...this.ephemeralRefs.keys()];
    return !sameStringList(before, this.additionalDirs);
  }

  reload(): Promise<void> {
    return this.enqueue(() => this.reloadWorkspace(true));
  }

  private async reloadWorkspace(reloadLocal = false): Promise<void> {
    await this.batchChanges(async () => {
      const previousPrimary = this.primary;
      await this.reloadFromRegistry();
      if (!this.legacyProjectConfig) return;
      const primaryChanged = previousPrimary !== this.primary;
      if (reloadLocal || primaryChanged || this.localConfigWatcher.value === undefined) {
        await this.reloadFromDisk();
      }
      if (primaryChanged || this.localConfigWatcher.value === undefined) {
        this.watchLocalToml();
      }
    });
  }

  sessionInfo(): ISessionProjectInfo {
    const currentDirs = (): readonly string[] => this.additionalDirs;
    const currentPrimary = (): Readonly<Record<string, string>> => this.ISessionProjectInfo;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get additionalDirs() {
        return currentDirs();
      },
      get ISessionProjectInfo() {
        return currentPrimary();
      },
    };
  }

  private async applyAddDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult> {
    const persist = input.persist ?? true;
    const onDisk = await this.localConfig.readAdditionalDirs(this.primary);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;

    const resolved = await this.localConfig.resolveAdditionalDirs(this.primary, [
      input.path,
    ]);
    const persisted = persist && (await this.registerDir(input.path, resolved[0]));
    const unshared = persist ? resolved.filter((dir) => !this.sharesDir(dir)) : resolved;
    if (this.unionEphemeral(unshared)) this.fireChange();
    return {
      projectRoot: onDisk.projectRoot,
      configPath: onDisk.configPath,
      additionalDirs: this.additionalDirs,
      persisted,
    };
  }

  private async registerDir(path: string, dir: string | undefined): Promise<boolean> {
    if (dir === undefined) {
      throw new Error(`additional dir ${path} did not resolve`);
    }
    const { workspaceId, cwd } = this.workspace;
    const target = (await this.workspaces.get(workspaceId)) ?? (await this.workspaces.reviveImplicit(workspaceId, cwd));
    const dirKey = workspaceRootKey(dir);
    if (workspaceRootKey(target.root) === dirKey || workspaceRootKey(this.workspace.cwd) === dirKey) return this.sharesDir(dir);
    if (!target.additionalDirs.some((kept) => workspaceRootKey(kept) === dirKey)) {
      await this.workspaces.update(target.id, {
        additionalDirs: [...target.additionalDirs, dir],
      });
      await this.reloadWorkspace(true);
    }
    return true;
  }

  private sharesDir(dir: string): boolean {
    const dirKey = workspaceRootKey(dir);
    return [this.primary, ...this.sharedAdditionalDirs].some((shared) => workspaceRootKey(shared) === dirKey);
  }

  private async reloadFromDisk(): Promise<void> {
    const onDisk = await this.localConfig.readAdditionalDirs(this.primary);
    this.projectRoot = onDisk.projectRoot;
    this.configPath = onDisk.configPath;
    if (this.setFileDirs(onDisk.additionalDirs)) this.fireChange();
  }

  private async reloadFromRegistry(): Promise<void> {
    const registered = await this.workspaces.list();
    const current = this.workspace.meta.kind === 'managed'
      ? undefined
      : await this.workspaces.get(this.workspace.workspaceId);
    const entries =
      this.workspace.meta.kind === 'managed'
        ? registered.filter((entry) => entry.id === this.workspace.workspaceId)
        : current === undefined
          ? registered
          : [current, ...registered.filter((entry) => entry.id !== current.id)];
    const cwdKey = workspaceRootKey(this.workspace.cwd);
    const local = this.environmentId === LOCAL_ENVIRONMENT_ID;
    const dirs: string[] = [];
    const primary: Record<string, string> = {};
    for (const entry of entries) {
      const ownEntry = entry.id === this.workspace.workspaceId;
      if (!ownEntry && entry.kind === 'managed') continue;
      const set = [entry.root, ...entry.additionalDirs];
      const currentEntry = this.followsPrimary && local && ownEntry;
      const cwdRegistered = set.some((dir) => workspaceRootKey(dir) === cwdKey);
      if (!currentEntry && (!cwdRegistered || !isAncestorOrSelf(entry.root, this.workspace.cwd))) {
        const inRepository = ownEntry && local && (await this.workspaces.acceptsWorkDir(entry, this.workspace.cwd));
        if (inRepository) {
          dirs.push(...entry.additionalDirs.filter((dir) => workspaceRootKey(dir) !== cwdKey));
          continue;
        }
        if (!cwdRegistered) continue;
      }
      primary[entry.id] = entry.root;
      const primaryKey = workspaceRootKey(entry.root);
      for (const dir of set) {
        const key = workspaceRootKey(dir);
        if (this.followsPrimary && currentEntry && key === primaryKey) continue;
        if ((!this.followsPrimary || !currentEntry) && key === cwdKey) continue;
        if (dirs.some((kept) => workspaceRootKey(kept) === key)) continue;
        dirs.push(dir);
      }
    }
    const beforeDirs = this.sharedAdditionalDirs;
    const beforePrimary = this.ISessionProjectInfo;
    this.registryDirs = dirs;
    this.ISessionProjectInfo = primary;
    if (
      !sameStringList(beforeDirs, this.sharedAdditionalDirs) ||
      !samePrimaryByProject(beforePrimary, primary)
    ) {
      this.fireChange();
    }
  }

  private setFileDirs(dirs: readonly string[]): boolean {
    const before = this.sharedAdditionalDirs;
    this.fileDirs = dirs;
    return !sameStringList(before, this.sharedAdditionalDirs);
  }

  private unionEphemeral(dirs: readonly string[]): boolean {
    const before = this.additionalDirs;
    for (const dir of dirs) {
      this.ephemeralRefs.set(dir, (this.ephemeralRefs.get(dir) ?? 0) + 1);
    }
    this.ephemeralDirs = [...this.ephemeralRefs.keys()];
    return !sameStringList(before, this.additionalDirs);
  }

  private watchLocalToml(): void {
    try {
      const handle = watchCandidates(this.projectRoot, [this.configPath], {
        ignored: subtreeWatchFilter(this.projectRoot, [this.configPath]),
      });
      const subscription = handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => {
          void this.enqueue(() => this.reloadFromDisk()).catch((error) => {
            this.log.warn(`local.toml reload failed: ${String(error)}`);
          });
        }, WATCH_DEBOUNCE_MS);
      });
      const watchers = new DisposableStore();
      watchers.add(handle);
      watchers.add(subscription);
      this.localConfigWatcher.value = watchers;
    } catch (error) {
      this.log.warn(`cannot watch project-local config ${this.configPath}: ${String(error)}`);
    }
  }

  private fireChange(): void {
    if (this.changeBatchDepth > 0) {
      this.changePending = true;
      return;
    }
    this.onDidChangeEmitter.fire();
  }

  private async batchChanges(work: () => Promise<void>): Promise<void> {
    this.changeBatchDepth += 1;
    try {
      await work();
    } finally {
      this.changeBatchDepth -= 1;
      if (this.changeBatchDepth === 0 && this.changePending) {
        this.changePending = false;
        this.onDidChangeEmitter.fire();
      }
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(work, work);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  override dispose(): void {
    super.dispose();
    void this.drainPendingMutations();
  }

  async disposeAsync(): Promise<void> {
    super.dispose();
    await this.drainPendingMutations();
  }

  private async drainPendingMutations(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.mutationTail;
      await pending;
    } while (pending !== this.mutationTail);
  }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function samePrimaryByProject(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

