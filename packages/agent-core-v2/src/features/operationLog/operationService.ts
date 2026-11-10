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
import { OperationLogError, operationViewsEqual } from './operationLog';
import { OperationLogStore } from './operationLogStore';

const executionLocks = new Map<string, Promise<void>>();
const orchestrationTools = new Set(['Agent', 'AgentSwarm']);

export interface IAgentOperationService {
  readonly _serviceBrand: undefined;
}

export const IAgentOperationService =
  createDecorator<IAgentOperationService>('agentOperationService');

export class AgentOperationService extends Service implements IAgentOperationService {
  declare readonly _serviceBrand: undefined;

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
    const repoRoot = resolve(this.environment.workspaceRoots().workDir);
    const previous = executionLocks.get(repoRoot) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    executionLocks.set(repoRoot, tail);
    await previous;
    try {
      await this.captureLocked(repoRoot, context, next);
    } finally {
      release();
      if (executionLocks.get(repoRoot) === tail) executionLocks.delete(repoRoot);
    }
  }

  private async captureLocked(
    repoRoot: string,
    context: ResolvedToolExecutionHookContext,
    next: (context?: ResolvedToolExecutionHookContext) => Promise<void>,
  ): Promise<void> {
    const backend = await GitOperationBackend.open({ repoRoot });
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
          },
        },
        before,
      );
    }
    if (failed) throw executionError;
  }
}
