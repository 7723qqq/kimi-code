import { join } from 'pathe';

import { Service } from '#/_base/di/service';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import type { EnvironmentLease } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { IHostClock } from '#/os/interface/hostClock';
import type { HostFileStat } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { SubagentSpawned } from '#/session/subagent/mirrorAgentRun';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { resolveWorkspacePath } from '#/session/workspaceContext/workspacePaths';

import { OPERATION_LOG_FLAG_ID } from '#/features/operationLog/flag';
import { OperationSnapshotStore } from '#/features/operationLog/operationSnapshotStore';

import { FileSnapshotStore, snapshotContentHash, snapshotPathKey } from './fileSnapshotStore';
import {
  SNAPSHOT_DIR_NAME,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_PRUNE_INTERVAL_MS,
  SNAPSHOT_PRUNE_MAX_AGE_MS,
  SNAPSHOT_PRUNE_MAX_BYTES_PER_PATH,
  SNAPSHOT_PRUNE_MAX_PER_PATH,
  SNAPSHOT_PRUNE_MIN_OBJECT_AGE_MS,
  resolveSnapshotTarget,
  type ISnapshotService,
  type ISnapshotStore,
  type SnapshotTarget,
} from './snapshot';

let nextPruneAt = 0;

const snapshotWriteLocks = new Map<string, Promise<void>>();
const MAX_PENDING = 512;

function writtenContent(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const content = (args as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

type PreImage =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'oversize'; readonly size: number }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

export class SnapshotService extends Service implements ISnapshotService {
  declare readonly _serviceBrand: undefined;

  readonly store: ISnapshotStore;

  private readonly pending = new Map<
    string,
    {
      readonly path: string;
      readonly id: string;
      readonly hash: string;
      readonly after?: { readonly hash: string; readonly size: number };
    }
  >();
  private readonly releases = new Map<string, () => void>();

  constructor(
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @IBootstrapService bootstrap: IBootstrapService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IHostClock private readonly clock: IHostClock,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IEventBus eventBus: IEventBus,
    @IFlagService private readonly flags?: IFlagService,
  ) {
    super();
    if (this.flags?.enabled(OPERATION_LOG_FLAG_ID) === true) {
      this.store = new OperationSnapshotStore(workspaceCtx.workDir);
      return;
    }
    this.store = new FileSnapshotStore(join(bootstrap.storeDir, SNAPSHOT_DIR_NAME));
    this._register(
      toolExecutor.hooks.onExecuteTool.register('snapshot', async (context, next) => {
        await this.captureBeforeExecution(context);
        return next();
      }),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('snapshot', async (context, next) => {
        await this.onDidExecuteTool(
          context.toolCall?.id,
          context.outcome,
          context.result.isError === true,
        );
        return next();
      }),
    );
    this._register(
      eventBus.subscribe(SubagentSpawned, (event) => {
        this.onSubagentSpawned(event);
      }),
    );
    void this.pruneIfDue().catch(onUnexpectedError);
  }

  async list(path: string) {
    const lease = await this.environment.acquireWhenReady(['fs']);
    try {
      const semantics = lease.environment.path;
      if (semantics === undefined) throw new Error('Snapshot path semantics are unavailable');
      return await this.store.list(
        resolveWorkspacePath(semantics, this.workspaceCtx.workDir, path),
      );
    } finally {
      lease.dispose();
    }
  }

  private async captureBeforeExecution(
    context: ResolvedToolExecutionHookContext,
  ): Promise<void> {
    const target = resolveSnapshotTarget(context.execution.display, context.args);
    if (target === undefined) return;
    const content = target.mode === 'overwrite' ? writtenContent(context.args) : undefined;
    await this.capture(context.toolCall.id, target, content);
  }

  private async onDidExecuteTool(
    callId: string | undefined,
    outcome: string,
    failed: boolean,
  ): Promise<void> {
    if (callId === undefined) return;
    try {
      const entry = this.pending.get(callId);
      if (entry === undefined) return;
      this.pending.delete(callId);
      if (outcome !== 'executed') {
        await this.store.remove(entry.path, entry.id);
        return;
      }
      if (failed) {
        const after = await this.readPreImage(entry.path);
        if (after.kind !== 'bytes') return;
        const hash = snapshotContentHash(after.bytes);
        if (entry.hash !== '' && hash === entry.hash) {
          await this.store.remove(entry.path, entry.id);
        } else {
          await this.store.complete(entry.path, entry.id, {
            hash,
            size: after.bytes.byteLength,
          });
        }
        return;
      }
      if (entry.hash === '') return;
      if (entry.after !== undefined) {
        await this.store.complete(entry.path, entry.id, entry.after);
        return;
      }
      const after = await this.readPreImage(entry.path);
      if (after.kind !== 'bytes') return;
      await this.store.complete(entry.path, entry.id, {
        hash: snapshotContentHash(after.bytes),
        size: after.bytes.byteLength,
      });
    } finally {
      this.release(callId);
    }
  }

  private onSubagentSpawned(event: SubagentSpawned): void {
    if (event.callerAgentId !== this.agentCtx.agentId) return;
    void this.store
      .markAgent({
        agentId: event.subagentId,
        sessionId: this.sessionCtx.sessionId,
        at: this.clock.now(),
        cwd: this.sessionCtx.cwd,
        profileName: event.subagentName,
        ...(event.parentAgentId === undefined ? {} : { parentAgentId: event.parentAgentId }),
        ...(event.swarmIndex === undefined ? {} : { swarmIndex: event.swarmIndex }),
      })
      .catch(onUnexpectedError);
  }

  private async pruneIfDue(): Promise<void> {
    const now = this.clock.now();
    if (now.getTime() < nextPruneAt) return;
    nextPruneAt = now.getTime() + SNAPSHOT_PRUNE_INTERVAL_MS;
    await this.store.prune({
      now,
      maxPerPath: SNAPSHOT_PRUNE_MAX_PER_PATH,
      maxBytesPerPath: SNAPSHOT_PRUNE_MAX_BYTES_PER_PATH,
      maxAgeMs: SNAPSHOT_PRUNE_MAX_AGE_MS,
      minObjectAgeMs: SNAPSHOT_PRUNE_MIN_OBJECT_AGE_MS,
    });
  }

  private async capture(
    callId: string,
    target: SnapshotTarget,
    content: string | undefined,
  ): Promise<void> {
    this.releases.set(callId, await this.acquire(target.path));
    try {
      await this.captureInner(callId, target, content);
    } catch (error) {
      onUnexpectedError(error);
      this.release(callId);
    }
  }

  private async acquire(path: string): Promise<() => void> {
    const key = snapshotPathKey(path);
    const previous = snapshotWriteLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    snapshotWriteLocks.set(key, tail);
    await previous;
    return () => {
      release();
      if (snapshotWriteLocks.get(key) === tail) snapshotWriteLocks.delete(key);
    };
  }

  private release(callId: string): void {
    const release = this.releases.get(callId);
    if (release === undefined) return;
    this.releases.delete(callId);
    release();
  }

  private async captureInner(
    callId: string,
    target: SnapshotTarget,
    content: string | undefined,
  ): Promise<void> {
    const pre = await this.readPreImage(target.path);
    if (pre.kind === 'missing') return;
    const at = this.clock.now();
    const record =
      pre.kind === 'bytes'
        ? await this.store.record({
            path: target.path,
            at,
            tool: target.tool,
            mode: target.mode,
            size: pre.bytes.byteLength,
            bytes: pre.bytes,
            sessionId: this.sessionCtx.sessionId,
            agentId: this.agentCtx.agentId,
          })
        : await this.store.record({
            path: target.path,
            at,
            tool: target.tool,
            mode: target.mode,
            size: pre.kind === 'oversize' ? pre.size : 0,
            skipped: pre.kind === 'oversize' ? 'max-size' : 'unreadable',
            sessionId: this.sessionCtx.sessionId,
            agentId: this.agentCtx.agentId,
          });
    this.pending.set(callId, {
      path: target.path,
      id: record.id,
      hash: record.hash,
      ...(content === undefined
        ? {}
        : {
            after: {
              hash: snapshotContentHash(new TextEncoder().encode(content)),
              size: Buffer.byteLength(content, 'utf8'),
            },
          }),
    });
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  private async readPreImage(path: string): Promise<PreImage> {
    let lease: EnvironmentLease;
    try {
      lease = await this.environment.acquireWhenReady(['fs']);
    } catch (error) {
      if (error instanceof EnvironmentError) return { kind: 'unreadable' };
      throw error;
    }
    try {
      const fs = lease.environment.fs;
      const semantics = lease.environment.path;
      if (fs === undefined || semantics === undefined) return { kind: 'unreadable' };
      const absolute = resolveWorkspacePath(semantics, this.workspaceCtx.workDir, path);
      let info: HostFileStat;
      try {
        info = await fs.stat(absolute);
      } catch (error) {
        return isHostFsNotFound(error) ? { kind: 'missing' } : { kind: 'unreadable' };
      }
      if (!info.isFile) return { kind: 'unreadable' };
      if (info.size > SNAPSHOT_MAX_BYTES) return { kind: 'oversize', size: info.size };
      try {
        const bytes = await fs.readBytes(absolute, info.size + 1);
        if (bytes.byteLength > SNAPSHOT_MAX_BYTES) {
          return { kind: 'oversize', size: bytes.byteLength };
        }
        if (bytes.byteLength !== info.size) return { kind: 'unreadable' };
        return { kind: 'bytes', bytes };
      } catch {
        return { kind: 'unreadable' };
      }
    } finally {
      lease.dispose();
    }
  }
}
