import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { resolveSandboxPolicy, sandboxToolVeto } from './sandbox';

export interface ISandboxPolicyService {
  readonly _serviceBrand: undefined;
}

export const ISandboxPolicyService = createDecorator<ISandboxPolicyService>(
  'sandboxPolicyService',
);

export class SandboxPolicyService extends Service implements ISandboxPolicyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @ISessionContext sessionCtx: ISessionContext,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    const policy = resolveSandboxPolicy(config, sessionCtx.cwd);
    if (policy.mode === 'off') return;
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        const message = sandboxToolVeto(
          policy,
          event.toolCall.name,
          event.tool?.sideEffect,
          event.execution.accesses,
        );
        if (message !== undefined) event.veto(denyToolExecution(message));
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISandboxPolicyService,
  SandboxPolicyService,
  ScopeActivation.OnScopeCreated,
  'sandbox',
);
