import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { parseBooleanEnv } from '#/_base/utils/env';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  TEST_SCOPE_GUARD_ENV,
  TEST_SCOPE_REMINDER_VARIANT,
  repositoryRootOf,
  wholeSuiteRunWarning,
} from './testScopeGuard';

export interface IAgentTestScopeGuardService {
  readonly _serviceBrand: undefined;
}

export const IAgentTestScopeGuardService = createDecorator<IAgentTestScopeGuardService>(
  'agentTestScopeGuardService',
);

export class AgentTestScopeGuardService
  extends Disposable
  implements IAgentTestScopeGuardService
{
  declare readonly _serviceBrand: undefined;

  private readonly enabled: boolean;
  private repositoryRootPromise: Promise<string> | undefined;
  private warnedThisTurn = false;

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService bootstrap: IBootstrapService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this.enabled = parseBooleanEnv(bootstrap.getEnv(TEST_SCOPE_GUARD_ENV)) !== false;
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('test-scope-guard', async (ctx, next) => {
        await this.observe(ctx);
        await next(ctx);
      }),
    );
    this._register(
      eventBus.subscribe('turn.started', () => {
        this.warnedThisTurn = false;
      }),
    );
  }

  private async observe(ctx: ToolDidExecuteContext): Promise<void> {
    if (!this.enabled || this.warnedThisTurn) return;
    if (ctx.outcome !== 'executed') return;
    if (ctx.toolCall.name !== 'Bash') return;
    const args = ctx.args as Record<string, unknown> | undefined;
    const command = typeof args?.['command'] === 'string' ? args['command'] : undefined;
    if (command === undefined) return;
    const warning = wholeSuiteRunWarning({
      command,
      cwd: this.sessionContext.cwd,
      workspaceRoot: await this.repositoryRoot(),
    });
    if (warning === undefined) return;
    this.reminders.notify(warning, { variant: TEST_SCOPE_REMINDER_VARIANT });
    this.warnedThisTurn = true;
  }

  private repositoryRoot(): Promise<string> {
    this.repositoryRootPromise ??= repositoryRootOf({
      workDir: this.sessionContext.cwd,
      exists: (marker) => this.markerExists(marker),
    });
    return this.repositoryRootPromise;
  }

  private async markerExists(marker: string): Promise<boolean> {
    try {
      await this.fs.stat(marker);
      return true;
    } catch {
      return false;
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTestScopeGuardService,
  AgentTestScopeGuardService,
  ScopeActivation.OnScopeCreated,
  'testScopeGuard',
);
