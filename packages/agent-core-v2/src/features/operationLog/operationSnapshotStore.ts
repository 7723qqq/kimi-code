import { isAbsolute, relative, resolve } from 'pathe';

import type {
  ISnapshotStore,
  SnapshotAgentMark,
  SnapshotAgentMarkInput,
  SnapshotPruneOptions,
  SnapshotPruneResult,
  SnapshotRecord,
  SnapshotRecordInput,
} from '#/features/snapshot/snapshot';

import { GitOperationBackend } from './gitOperationBackend';
import {
  OperationLogError,
  type OperationLogRetention,
  type OperationRecord,
  type OperationView,
} from './operationLog';
import { OperationLogStore } from './operationLogStore';

interface ProjectionContext {
  readonly backend: GitOperationBackend;
  readonly store: OperationLogStore;
}

export class OperationSnapshotStore implements ISnapshotStore {
  declare readonly _serviceBrand: undefined;

  private readonly repoRoot: string;
  private readonly ready: Promise<ProjectionContext>;

  constructor(repoRoot: string, retention: Partial<OperationLogRetention> = {}) {
    this.repoRoot = resolve(repoRoot);
    this.ready = this.open(retention);
  }

  async list(path: string): Promise<readonly SnapshotRecord[]> {
    const pathKey = this.pathKey(path);
    const { backend, store } = await this.ready;
    const records: SnapshotRecord[] = [];
    for (const operation of await store.list()) {
      const before =
        operation.beforeViewId === undefined ? undefined : await store.view(operation.beforeViewId);
      const beforeFile = before === undefined ? undefined : await backend.fileAt(before, pathKey);
      const after = await store.view(operation.viewId);
      const afterFile = await backend.fileAt(after, pathKey);
      if (beforeFile?.hash === afterFile?.hash) continue;
      records.push({
        version: 1,
        id: operation.id,
        path: pathKey,
        hash: beforeFile?.hash ?? '',
        size: beforeFile?.size ?? 0,
        at: operation.at,
        tool: operation.origin?.toolName ?? operation.kind,
        mode: beforeFile === undefined ? 'overwrite' : 'edit',
        sessionId: operation.origin?.sessionId,
        agentId: operation.origin?.agentId,
        previousId: operation.parents[0],
        afterHash: afterFile?.hash ?? '',
        afterSize: afterFile?.size ?? 0,
      });
    }
    return records;
  }

  async content(hash: string): Promise<Uint8Array | undefined> {
    if (hash === '') return undefined;
    const { backend } = await this.ready;
    return backend.readBlob(hash);
  }

  async agents(sessionId: string): Promise<readonly SnapshotAgentMark[]> {
    const marks = new Map<string, SnapshotAgentMark>();
    for (const operation of await this.operations()) {
      const origin = operation.origin;
      if (origin?.sessionId !== sessionId || origin.agentId === undefined) continue;
      if (marks.has(origin.agentId)) continue;
      marks.set(origin.agentId, {
        version: 1,
        agentId: origin.agentId,
        sessionId,
        at: operation.at,
        cwd: this.repoRoot,
      });
    }
    return [...marks.values()];
  }

  async operations(turnId?: number, agentId?: string): Promise<readonly OperationRecord[]> {
    const { store } = await this.ready;
    const operations = await store.list();
    return operations.filter(
      (operation) =>
        (turnId === undefined || operation.origin?.turnId === turnId) &&
        (agentId === undefined || operation.origin?.agentId === agentId),
    );
  }

  async view(id: string): Promise<OperationView> {
    const { store } = await this.ready;
    return store.view(id);
  }

  async fileAt(
    view: OperationView,
    path: string,
  ): Promise<{ readonly hash: string; readonly size: number } | undefined> {
    const { backend } = await this.ready;
    return backend.fileAt(view, this.pathKey(path));
  }

  async changedFiles(before: OperationView, after: OperationView): Promise<readonly string[]> {
    const { backend } = await this.ready;
    return backend.changedFiles(before, after);
  }

  record(_input: SnapshotRecordInput): Promise<SnapshotRecord> {
    return this.readOnly();
  }

  complete(
    _path: string,
    _id: string,
    _after: { readonly hash: string; readonly size: number },
  ): Promise<boolean> {
    return this.readOnly();
  }

  remove(_path: string, _id: string): Promise<boolean> {
    return this.readOnly();
  }

  markAgent(_input: SnapshotAgentMarkInput): Promise<void> {
    return this.readOnly();
  }

  prune(_options: SnapshotPruneOptions): Promise<SnapshotPruneResult> {
    return this.readOnly();
  }

  private async open(retention: Partial<OperationLogRetention>): Promise<ProjectionContext> {
    const backend = await GitOperationBackend.open({ repoRoot: this.repoRoot });
    return { backend, store: new OperationLogStore(backend.storageRoot, retention) };
  }

  private pathKey(path: string): string {
    const pathKey = relative(this.repoRoot, resolve(this.repoRoot, path)).replaceAll('\\', '/');
    if (pathKey === '' || pathKey === '..' || pathKey.startsWith('../') || isAbsolute(pathKey)) {
      throw new OperationLogError('invalid', 'Operation path is outside the repository');
    }
    return pathKey;
  }

  private readOnly(): never {
    throw new OperationLogError('invalid', 'Operation snapshot store is read-only');
  }
}
