import { t } from '@moonshot-ai/kimi-i18n';

import { Service } from '#/_base/di/service';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { HelloWorldModeEnter, HelloWorldModeExit, helloWorldKey } from '../helloWorldOps';
import { HelloWorldInjection } from './injection/helloWorldInjection';
import { type IAgentHelloWorldService, type HelloWorldModeTrigger } from './helloWorld';

export class AgentHelloWorldService extends Service implements IAgentHelloWorldService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentReminderService reminder: IAgentReminderService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.agentState.contributeState(helloWorldKey);
    this._register(
      new HelloWorldInjection(
        { getTrigger: () => this.agentState.get(helloWorldKey) },
        reminder,
        this.context,
      ),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.isActive) return;
        if (event.toolCall.name !== 'Agent') return;
        event.veto(
          denyToolExecution(this.toolApproval.formatDenyMessage(agentDeniedInHelloWorldModeMessage())),
        );
      }),
    );
    this._register(
      eventBus.subscribe(TurnEnded, () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
  }

  enter(trigger: HelloWorldModeTrigger): void {
    if (this.agentState.get(helloWorldKey) !== null) return;
    void this.dispatcher.dispatch(
      new HelloWorldModeEnter({ agentId: this.agentCtx.agentId, trigger }),
    );
    this.telemetry.track2('hello_world_mode_entered', { trigger });
  }

  exit(): void {
    const trigger = this.agentState.get(helloWorldKey);
    if (trigger === null) return;
    const history = this.context.get();
    void this.dispatcher.dispatch(new HelloWorldModeExit({ agentId: this.agentCtx.agentId }));
    this.telemetry.track2('hello_world_mode_exited', { trigger });
    this.context.publishTrailingRemoval(history);
  }

  get isActive(): boolean {
    return this.agentState.get(helloWorldKey) !== null;
  }

  private get shouldAutoExit(): boolean {
    const trigger = this.agentState.get(helloWorldKey);
    return trigger === 'task' || trigger === 'tool';
  }
}

function agentDeniedInHelloWorldModeMessage(): string {
  return t('toolsV2.swarm.agentDeniedInSwarmMode');
}
