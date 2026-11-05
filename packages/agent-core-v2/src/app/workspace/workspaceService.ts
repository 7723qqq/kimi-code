import { basename, isAbsolute } from 'pathe';

import { randomUUID } from 'node:crypto';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IEventService } from '#/app/event/event';
import { LifecycleScope } from '#/app/scopes';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  IWorkspaceService,
  type Workspace,
  type WorkspaceCreate,
  type WorkspaceUpdate,
} from './workspace';
import {
  collectAliasIds,
  compactSessionIndexIfStale,
  dedupeByRoot,
  readSessionIndexEntries,
  readSessionIndexWorkDirs,
} from './workspaceAlias';
import { WorkspaceCreated, WorkspaceDeleted, WorkspaceUpdated } from './workspaceEvents';
import { IWorkspacePersistence, type WorkspaceCatalog } from './workspacePersistence';

export class WorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined;

  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IAppendLogStore private readonly appendLogs: IAppendLogStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly event: IEventService,
  ) {}

  list(): Promise<readonly Workspace[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      return dedupeByRoot(byId);
    });
  }

  get(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      return catalog.workspaces.find((ws) => ws.id === id);
    });
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    return this.runExclusive(async () => {
      let stat;
      try {
        stat = await this.hostFs.stat(root);
      } catch {
        stat = undefined;
      }
      if (stat !== undefined && !stat.isDirectory) {
        try {
          stat = await this.hostFs.stat(await this.hostFs.realpath(root));
        } catch {
          stat = undefined;
        }
      }
      if (stat !== undefined && !stat.isDirectory) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
      }
      await this.ensureMerged();
      let ws!: Workspace;
      let existing: Workspace | undefined;
      await this.store.update((catalog) => {
        const byId = new Map(catalog.workspaces.map((entry) => [entry.id, entry]));
        const deletedIds = new Set(catalog.deletedIds);
        const id = encodeWorkDirKey(root);
        existing = byId.get(id);
        if (existing === undefined) {
          const rootKey = workspaceRootKey(root);
          for (const entry of byId.values()) {
            if (isWorkDirKey(entry.id) && workspaceRootKey(entry.root) === rootKey) {
              existing = entry;
              break;
            }
          }
        }
        const now = Date.now();
        ws =
          existing !== undefined
            ? { ...existing, lastOpenedAt: now }
            : {
                id,
                root,
                name: name ?? basename(root),
                kind: 'implicit',
                additionalDirs: [],
                createdAt: now,
                lastOpenedAt: now,
              };
        byId.set(ws.id, ws);
        deletedIds.delete(ws.id);
        return {
          workspaces: [...byId.values()],
          deletedIds: [...deletedIds],
          idempotencyKeys: catalog.idempotencyKeys,
        };
      });
      this.event.publish(
        existing === undefined
          ? new WorkspaceCreated({ payload: { workspace: ws } })
          : new WorkspaceUpdated({ payload: { workspace: ws } }),
      );
      return ws;
    });
  }

  create(input: WorkspaceCreate): Promise<Workspace> {
    return this.runExclusive(async () => {
      await this.requireDirectory(input.root);
      const additionalDirs = await this.normalizeAdditionalDirs(
        input.root,
        input.additionalDirs ?? [],
      );
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const idempotencyKeys = { ...catalog.idempotencyKeys };
      const mapped =
        input.idempotencyKey === undefined ? undefined : idempotencyKeys[input.idempotencyKey];
      const existing =
        mapped === undefined ? undefined : catalog.workspaces.find((ws) => ws.id === mapped);
      if (existing !== undefined) return existing;
      const now = Date.now();
      const ws: Workspace = {
        id: `wm_${randomUUID()}`,
        root: input.root,
        name: input.name ?? basename(input.root),
        kind: 'managed',
        additionalDirs,
        createdAt: now,
        lastOpenedAt: now,
      };
      if (input.idempotencyKey !== undefined) idempotencyKeys[input.idempotencyKey] = ws.id;
      await this.store.save({
        workspaces: [...catalog.workspaces, ws],
        deletedIds: catalog.deletedIds,
        idempotencyKeys,
      });
      this.event.publish(new WorkspaceCreated({ payload: { workspace: ws } }));
      return ws;
    });
  }

  touch(id: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      await this.requireDirectory(existing.root);
      const touched: Workspace = { ...existing, lastOpenedAt: Date.now() };
      await this.store.save({
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? touched : ws)),
        deletedIds: catalog.deletedIds,
        idempotencyKeys: catalog.idempotencyKeys,
      });
      this.event.publish(new WorkspaceUpdated({ payload: { workspace: touched } }));
      return touched;
    });
  }

  setPrimary(id: string, path: string): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      const resolved = isAbsolute(path) ? path : `${existing.root}/${path}`;
      await this.requireDirectory(resolved);
      const resolvedKey = workspaceRootKey(resolved);
      if (resolvedKey === workspaceRootKey(existing.root)) return existing;
      const wasAdditional = existing.additionalDirs.some(
        (dir) => workspaceRootKey(dir) === resolvedKey,
      );
      if (!wasAdditional) {
        throw new Error2(
          ErrorCodes.FS_PATH_NOT_FOUND,
          `primary ${path} is not one of this workspace's source folders`,
        );
      }
      const updated: Workspace = {
        ...existing,
        root: resolved,
        additionalDirs: [
          ...existing.additionalDirs.filter((dir) => workspaceRootKey(dir) !== resolvedKey),
          existing.root,
        ],
      };
      await this.store.save({
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated : ws)),
        deletedIds: catalog.deletedIds,
        idempotencyKeys: catalog.idempotencyKeys,
      });
      this.event.publish(new WorkspaceUpdated({ payload: { workspace: updated } }));
      return updated;
    });
  }

  private async requireDirectory(root: string): Promise<void> {
    let stat;
    try {
      stat = await this.hostFs.stat(root);
    } catch (error) {
      const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} does not exist`);
      }
      throw error;
    }
    if (!stat.isDirectory) {
      try {
        stat = await this.hostFs.stat(await this.hostFs.realpath(root));
      } catch {}
    }
    if (!stat.isDirectory) {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
    }
  }

  private async normalizeAdditionalDirs(
    root: string,
    dirs: readonly string[],
  ): Promise<readonly string[]> {
    const rootKey = workspaceRootKey(root);
    const kept: string[] = [];
    for (const dir of dirs) {
      const resolved = isAbsolute(dir) ? dir : `${root}/${dir}`;
      await this.requireDirectory(resolved);
      const key = workspaceRootKey(resolved);
      if (key === rootKey) continue;
      if (kept.some((entry) => workspaceRootKey(entry) === key)) continue;
      kept.push(resolved);
    }
    return kept;
  }


  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      const updated: Workspace = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.additionalDirs !== undefined
          ? { additionalDirs: [...patch.additionalDirs] }
          : {}),
      };
      await this.store.save({
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated : ws)),
        deletedIds: catalog.deletedIds,
      });
      this.event.publish(new WorkspaceUpdated({ payload: { workspace: updated } }));
      return updated;
    });
  }

  delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = await this.loadCatalog();
      let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
      if (root === undefined) {
        root = (await readSessionIndexEntries(this.storage)).find(
          (line) => encodeWorkDirKey(line.workDir) === id,
        )?.workDir;
      }
      if (root === undefined) {
        await this.store.save({
          workspaces: catalog.workspaces.filter((ws) => ws.id !== id),
          deletedIds: [...new Set([...catalog.deletedIds, id])],
        });
        return;
      }
      const rootKey = workspaceRootKey(root);
      const aliasIds = collectAliasIds(
        catalog.workspaces,
        await readSessionIndexEntries(this.storage),
        root,
      );
      await this.store.save({
        workspaces: catalog.workspaces.filter((ws) => workspaceRootKey(ws.root) !== rootKey),
        deletedIds: [...new Set([...catalog.deletedIds, ...aliasIds])],
      });
      this.event.publish(new WorkspaceDeleted({ payload: { workspaceId: id, root } }));
    });
  }

  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const loaded = await this.store.load();
    if (loaded === undefined) {
      const rebuilt = await this.rebuildFromSessionIndex();
      await this.store.save({ workspaces: [...rebuilt.values()], deletedIds: [] });
    } else {
      const byId = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(loaded.deletedIds);
      if (await this.mergeFromSessionIndex(byId, deletedIds)) {
        await this.store.save({ workspaces: [...byId.values()], deletedIds: [...deletedIds] });
      }
    }
    this.merged = true;
    await this.compactSessionIndex();
  }

  private async compactSessionIndex(): Promise<void> {
    try {
      await compactSessionIndexIfStale({
        storage: this.storage,
        appendLogs: this.appendLogs,
        sessionDirExists: (dir) => this.sessionDirExists(dir),
      });
    } catch (error) {
      this.log.warn('session index compaction failed; will retry on the next startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sessionDirExists(dir: string): Promise<boolean> {
    try {
      return (await this.hostFs.stat(dir)).isDirectory;
    } catch (error) {
      const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      return true;
    }
  }

  private async loadCatalog(): Promise<WorkspaceCatalog> {
    return (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
  }

  private async mergeFromSessionIndex(
    byId: Map<string, Workspace>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workDir of await readSessionIndexWorkDirs(this.storage)) {
      const id = encodeWorkDirKey(workDir);
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, {
        id,
        root: workDir,
        name: basename(workDir),
        kind: 'implicit',
        additionalDirs: [],
        createdAt: now,
        lastOpenedAt: now,
      });
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, Workspace>> {
    const result = new Map<string, Workspace>();
    const now = Date.now();
    const seenRootKeys = new Set<string>();
    for (const entry of await readSessionIndexEntries(this.storage)) {
      if (!isAbsolute(entry.workDir)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      const id = encodeWorkDirKey(entry.workDir);
      result.set(id, {
        id,
        root: entry.workDir,
        name: basename(entry.workDir),
        kind: 'implicit',
        additionalDirs: [],
        createdAt: now,
        lastOpenedAt: now,
      });
    }
    return result;
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceService,
  WorkspaceService,
  ScopeActivation.OnScopeCreated,
  'workspace',
);
