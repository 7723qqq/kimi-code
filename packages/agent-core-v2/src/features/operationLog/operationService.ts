import { resolve } from 'pathe';

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { resolveOperationLogRetention } from './configSection';
import { OPERATION_LOG_FLAG_ID } from './flag';
import { GitOperationBackend } from './gitOperationBackend';
import {
  OperationLogError,
  operationViewsEqual,
  type OperationActionInput,
  type OperationRecord,
  type OperationView,
} from './operationLog';
import { OperationLogStore } from './operationLogStore';

const executionLocks = new Map<string, Promise<void>>();
const orchestrationTools = new Set(['Agent', 'AgentSwarm']);

export interface IAgentOperationService {
  readonly _serviceBrand: undefined;
  listOperations(limit?: number): Promise<readonly OperationRecord[]>;
  undoOperation(): Promise<OperationRecord>;
  redoOperation(): Promise<OperationRecord>;
  restoreOperation(targetId: string): Promise<OperationRecord>;
  restoreBeforeTurn(turnId: number): Promise<OperationRecord | undefined>;
}

export const IAgentOperationService =
  createDecorator<IAgentOperationService>('agentOperationService');

export class AgentOperationService extends Service implements IAgentOperationService {
  declare readonly _serviceBrand: undefined;

  private readonly operationBackends = new Map<string, GitOperationBackend>();

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @IFlagService private readonly flags: IFlagService,
    @IHostClock private readonly clock: IHostClock,
    @IConfigService private readonly configuration: IConfigService,
  ) {
    super();
    this._register(
      toolExecutor.hooks.onExecuteTool.register('operation-log', async (context, next) => {
        await this.capture(context, next);
      }),
    );
  }

  listOperations(limit?: number): Promise<readonly OperationRecord[]> {
    const repoRoot = this.localRepoRoot();
    return this.withExecutionLock(repoRoot, async () => {
      const { store } = await this.openOperationStore(repoRoot);
      return store.list(limit);
    });
  }

  undoOperation(): Promise<OperationRecord> {
    return this.restore('undo');
  }

  redoOperation(): Promise<OperationRecord> {
    return this.restore('redo');
  }

  restoreOperation(targetId: string): Promise<OperationRecord> {
    return this.restore('restore', targetId);
  }

  restoreBeforeTurn(turnId: number): Promise<OperationRecord | undefined> {
    const repoRoot = this.localRepoRoot();
    return this.withExecutionLock(repoRoot, async () => {
      const { backend, store } = await this.openOperationStore(repoRoot);
      const operations = await store.list();
      const target = operations.findLast(
        (operation) =>
          operation.kind === 'capture' &&
          operation.origin?.sessionId === this.session.sessionId &&
          operation.origin.agentId === this.agent.agentId &&
          operation.origin.turnId !== undefined &&
          operation.origin.turnId >= turnId,
      );
      if (target === undefined) return;
      if (target.beforeViewId === undefined) {
        throw new OperationLogError('invalid', 'The operation has no before view');
      }
      const current = await backend.captureView();
      const head = await store.head();
      if (head === undefined) throw new OperationLogError('not-found', 'Operation log is empty');
      const parent = await store.get(head.operationId);
      const expected = await store.view(parent.viewId);
      if (!operationViewsEqual(current, expected)) {
        throw new OperationLogError(
          'view-mismatch',
          'The repository contains writes outside the operation log',
        );
      }
      const targetView = await store.view(target.beforeViewId);
      const input: OperationActionInput = {
        at: this.clock.now(),
        description: `Restore before turn ${String(turnId)}`,
        origin: { sessionId: this.session.sessionId, agentId: this.agent.agentId },
      };
      await backend.restoreView(expected, targetView);
      try {
        return await store.restoreBefore(target.id, input);
      } catch (error) {
        await backend.restoreView(targetView, expected);
        throw error;
      }
    });
  }

  private async capture(
    context: ResolvedToolExecutionHookContext,
    next: (context?: ResolvedToolExecutionHookContext) => Promise<void>,
  ): Promise<void> {
    if (
      !this.flags.enabled(OPERATION_LOG_FLAG_ID) ||
      orchestrationTools.has(context.toolCall.name)
    ) {
      await next(context);
      return;
    }
    const repoRoot = this.localRepoRoot();
    await this.withExecutionLock(repoRoot, () => this.captureLocked(repoRoot, context, next));
  }

  private localRepoRoot(): string {
    if (!this.flags.enabled(OPERATION_LOG_FLAG_ID)) {
      throw new OperationLogError('invalid', 'Operation Log is disabled');
    }
    const environment = this.environment.inspect();
    if (
      environment.identity.environmentId !== LOCAL_ENVIRONMENT_ID ||
      environment.status !== 'ready'
    ) {
      throw new OperationLogError(
        'invalid',
        'Operation capture requires a ready local environment',
      );
    }
    return resolve(this.environment.workspaceRoots().workDir);
  }

  private async withExecutionLock<T>(repoRoot: string, run: () => Promise<T>): Promise<T> {
    const previous = executionLocks.get(repoRoot) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    executionLocks.set(repoRoot, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (executionLocks.get(repoRoot) === tail) executionLocks.delete(repoRoot);
    }
  }

  private async openOperationStore(repoRoot: string): Promise<{
    readonly backend: GitOperationBackend;
    readonly store: OperationLogStore;
  }> {
    const backend = await this.operationBackend(repoRoot);
    const store = new OperationLogStore(
      backend.storageRoot,
      resolveOperationLogRetention(this.configuration),
    );
    return { backend, store };
  }

  private async operationBackend(repoRoot: string): Promise<GitOperationBackend> {
    const cached = this.operationBackends.get(repoRoot);
    if (cached !== undefined && (await cached.isRepositoryCurrent())) return cached;
    const backend = await GitOperationBackend.open({ repoRoot });
    this.operationBackends.set(repoRoot, backend);
    return backend;
  }

  override dispose(): void {
    this.operationBackends.clear();
    super.dispose();
  }

  private restore(
    kind: 'undo' | 'redo' | 'restore',
    targetId?: string,
  ): Promise<OperationRecord> {
    const repoRoot = this.localRepoRoot();
    return this.withExecutionLock(repoRoot, () => this.restoreLocked(repoRoot, kind, targetId));
  }

  private async restoreLocked(
    repoRoot: string,
    kind: 'undo' | 'redo' | 'restore',
    targetId?: string,
  ): Promise<OperationRecord> {
    const { backend, store } = await this.openOperationStore(repoRoot);
    const current = await backend.captureView();
    const head = await store.head();
    if (head === undefined) throw new OperationLogError('not-found', 'Operation log is empty');
    const parent = await store.get(head.operationId);
    const expected = await store.view(parent.viewId);
    if (!operationViewsEqual(current, expected)) {
      throw new OperationLogError(
        'view-mismatch',
        'The repository contains writes outside the operation log',
      );
    }
    const input: OperationActionInput = {
      at: this.clock.now(),
      description:
        kind === 'undo' ? 'Undo operation' : kind === 'redo' ? 'Redo operation' : 'Restore operation',
      origin: { sessionId: this.session.sessionId, agentId: this.agent.agentId },
    };
    let targetView: OperationView;
    let append: () => Promise<OperationRecord>;
    if (kind === 'undo') {
      if (head.undoTargetId === undefined) {
        throw new OperationLogError('nothing-to-undo', 'No operation is available to undo');
      }
      const target = await store.get(head.undoTargetId);
      if (target.beforeViewId === undefined) {
        throw new OperationLogError('nothing-to-undo', 'The first operation cannot be undone');
      }
      targetView = await store.view(target.beforeViewId);
      append = () => store.undo(input);
    } else if (kind === 'redo') {
      const redoTargetId = head.redoStack.at(-1);
      if (redoTargetId === undefined) {
        throw new OperationLogError('nothing-to-redo', 'No operation is available to redo');
      }
      const target = await store.get(redoTargetId);
      targetView = await store.view(target.viewId);
      append = () => store.redo(input);
    } else {
      if (targetId === undefined) {
        throw new OperationLogError('invalid', 'A restore target is required');
      }
      const target = await store.get(targetId);
      targetView = await store.view(target.viewId);
      append = () => store.restore(targetId, input);
    }
    await backend.restoreView(expected, targetView);
    try {
      return await append();
    } catch (error) {
      await backend.restoreView(targetView, expected);
      throw error;
    }
  }

  private async captureLocked(
    repoRoot: string,
    context: ResolvedToolExecutionHookContext,
    next: (context?: ResolvedToolExecutionHookContext) => Promise<void>,
  ): Promise<void> {
    const backend = await this.operationBackend(repoRoot);
    const store = new OperationLogStore(
      backend.storageRoot,
      resolveOperationLogRetention(this.configuration),
    );
    const before = await backend.captureView();
    const head = await store.head();
    if (head !== undefined) {
      const operation = await store.get(head.operationId);
      const expected = await store.view(operation.viewId);
      if (!operationViewsEqual(before, expected)) {
        throw new OperationLogError(
          'view-mismatch',
          'The repository contains writes outside the operation log',
        );
      }
    }
    let failed = false;
    let executionError: unknown;
    try {
      await next(context);
    } catch (error) {
      failed = true;
      executionError = error;
    }
    const after = await backend.captureView();
    if (!operationViewsEqual(before, after)) {
      await store.capture(
        after,
        {
          at: this.clock.now(),
          description: context.execution.description ?? context.toolCall.name,
          origin: {
            sessionId: this.session.sessionId,
            agentId: this.agent.agentId,
            turnId: context.turnId,
            toolCallId: context.toolCall.id,
            toolName: context.toolCall.name,
          },
        },
        before,
      );
    }
    if (failed) throw executionError;
  }
}
