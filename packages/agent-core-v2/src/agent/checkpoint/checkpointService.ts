/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

/** Hard cap on a single captured file (mirrors Reasonix's 32 MiB). */
export const CHECKPOINT_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Checkpoint groups kept per session (oldest evicted on overflow). */
export const CHECKPOINT_MAX_TURNS = 20;

export interface CheckpointRestoredPayload {
  readonly restored: readonly string[];
  readonly conflicts: readonly { readonly path: string; readonly reason: string }[];
}

export class CheckpointRestored extends Event2<CheckpointRestoredPayload> {
  static override readonly type = 'checkpoint.restored';
  static override readonly observable = true;
}
export interface CheckpointRestored extends CheckpointRestoredPayload {}

export interface IAgentCheckpointService {
  readonly _serviceBrand: undefined;
}

export const IAgentCheckpointService =
  createDecorator<IAgentCheckpointService>('agentCheckpointService');

interface FileSnapshot {
  readonly path: string;
  readonly existed: boolean | null;
  readonly preimageSha: string;
  readonly blobKey: string;
  afterSha: string | undefined;
}

interface CheckpointGroup {
  readonly turnId: number;
  contextLen: number;
  files: Map<string, FileSnapshot>;
  gaps: Set<string>;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class AgentCheckpointService extends Disposable implements IAgentCheckpointService {
  declare readonly _serviceBrand: undefined;

  private readonly checkpoints = new Map<number, CheckpointGroup>();
  private readonly storageScope: string;

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentConversationUndoParticipantRegistry
    undoRegistry: IAgentConversationUndoParticipantRegistry,
    @IAgentScopeContext agent: IAgentScopeContext,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this.storageScope = agent.scope('checkpoints');
    this._register(
      toolExecutor.onWillExecuteTool((event) => {
        const writePaths = collectWritePaths(event.execution.accesses);
        if (writePaths.length === 0) return;
        event.waitUntil(this.capturePaths(event.turnId, writePaths));
      }),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('checkpoint-after', async (ctx, next) => {
        await this.recordAfterWrite(ctx);
        await next(ctx);
      }),
    );
    this._register(
      undoRegistry.register({
        id: 'checkpoint',
        reconcileAfterUndo: () => this.restoreAfterUndo(),
      }),
    );
  }

  private ensureGroup(turnId: number): CheckpointGroup {
    let group = this.checkpoints.get(turnId);
    if (group === undefined) {
      group = {
        turnId,
        contextLen: this.context.get().length,
        files: new Map(),
        gaps: new Set(),
      };
      this.checkpoints.set(turnId, group);
      if (this.checkpoints.size > CHECKPOINT_MAX_TURNS) {
        const oldest = [...this.checkpoints.keys()].toSorted((a, b) => a - b)[0];
        if (oldest !== undefined) this.checkpoints.delete(oldest);
      }
    }
    return group;
  }

  private async capturePaths(turnId: number, paths: readonly string[]): Promise<void> {
    const group = this.ensureGroup(turnId);
    for (const path of paths) {
      if (group.files.has(path)) continue;
      const snapshot = await this.captureFile(path);
      if (snapshot === null) {
        group.gaps.add('unreadable');
        continue;
      }
      group.files.set(path, snapshot);
    }
  }

  private async captureFile(path: string): Promise<FileSnapshot | null> {
    let existed: boolean | null = true;
    let bytes: Uint8Array | undefined;
    try {
      const stat = await this.fs.stat(path);
      if (stat.size > CHECKPOINT_MAX_FILE_BYTES) {
        return null;
      }
      bytes = await this.fs.readBytes(path, CHECKPOINT_MAX_FILE_BYTES + 1);
      if (bytes.length > CHECKPOINT_MAX_FILE_BYTES) return null;
    } catch (error) {
      existed = isNotFound(error) ? false : null;
      bytes = undefined;
    }
    const key = `${sha256Bytes(new TextEncoder().encode(path)).slice(0, 16)}-${randomUUID()}.bin`;
    if (bytes !== undefined && bytes.length > 0) {
      await this.storage.write(this.storageScope, key, bytes, { atomic: true });
    }
    return {
      path,
      existed,
      preimageSha: bytes === undefined ? '' : sha256Bytes(bytes),
      blobKey: key,
      afterSha: undefined,
    };
  }

  private async recordAfterWrite(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed') return;
    const writePaths = collectWritePaths(ctx.accesses);
    if (writePaths.length === 0) return;
    const group = this.checkpoints.get(ctx.turnId);
    if (group === undefined) return;
    for (const path of writePaths) {
      const snapshot = group.files.get(path);
      if (snapshot === undefined) continue;
      try {
        const bytes = await this.fs.readBytes(path, CHECKPOINT_MAX_FILE_BYTES + 1);
        if (bytes.length <= CHECKPOINT_MAX_FILE_BYTES) snapshot.afterSha = sha256Bytes(bytes);
      } catch {
        snapshot.afterSha = undefined;
      }
    }
  }

  private async restoreAfterUndo(): Promise<void> {
    const currentLen = this.context.get().length;
    const restored: string[] = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    for (const [turnId, group] of this.checkpoints) {
      if (group.contextLen <= currentLen) continue;
      for (const [path, snapshot] of group.files) {
        const outcome = await this.restoreFile(path, snapshot);
        if (outcome === 'restored') restored.push(path);
        else if (outcome !== 'skipped') conflicts.push({ path, reason: outcome });
      }
      this.checkpoints.delete(turnId);
    }
    if (restored.length > 0 || conflicts.length > 0) {
      this.eventBus.publish(new CheckpointRestored({ restored, conflicts }));
    }
  }

  private async restoreFile(path: string, snapshot: FileSnapshot): Promise<string> {
    try {
      const current = await this.fs.readBytes(path, CHECKPOINT_MAX_FILE_BYTES + 1);
      if (snapshot.afterSha !== undefined && sha256Bytes(current) !== snapshot.afterSha) {
        return 'manual_edit';
      }
    } catch {
      if (!snapshot.existed) return 'skipped';
      return 'deleted';
    }
    if (!snapshot.existed) {
      if (snapshot.existed === null || snapshot.afterSha === undefined) return 'unknown_preimage';
      await this.fs.remove(path).catch(() => {});
      return 'restored';
    }
    const bytes = await this.storage.read(this.storageScope, snapshot.blobKey).catch(() => {});
    if (bytes === undefined) return 'missing_payload';
    await this.fs.writeBytes(path, bytes);
    return 'restored';
  }
}

function isNotFound(error: unknown): boolean {
  if (error instanceof HostFsError) return error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function collectWritePaths(
  accesses: readonly { kind: string; operation?: string; path?: string }[] | undefined,
): string[] {
  const paths: string[] = [];
  for (const access of accesses ?? []) {
    if (access.kind !== 'file') continue;
    if (access.operation === 'write' || access.operation === 'readwrite') {
      if (access.path !== undefined) paths.push(access.path);
    }
  }
  return paths;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCheckpointService,
  AgentCheckpointService,
  ScopeActivation.OnScopeCreated,
  'checkpoint',
);
