/**
 * `swarm` domain — `IAgentSwarmService` implementation.
 *
 * Tracks swarm-mode enter/exit in the `wire` `SwarmModel` (mutated only through
 * the `swarm_mode.enter` / `swarm_mode.exit` Ops, read through `wire.getModel`),
 * derives `agent.status.updated` from the Ops' `toEvent`, announces the mode
 * through the `swarm_mode` context-injection provider (`SwarmInjection`),
 * mirrors replayable trailing-enter removal through `contextMemory`, and
 * auto-exits on turn end via `turn`. Bound at Agent scope — contributed into
 * every Agent scope by `SwarmFeature` (`features/swarm/swarmFeature`). The
 * service also
 * guards AgentSwarm batch exclusivity through an `onBeforeExecuteTool` veto
 * listener: an AgentSwarm call must be the only tool call in its batch;
 * anything else is vetoed with a `toolApproval.formatDenyMessage`-formatted
 * reason. A second veto listener denies the `Agent` tool while swarm mode is
 * active — the enter-reminder is a soft constraint; this veto is the hard
 * enforcement that prevents a single-shot Agent call from slipping through.
 * Solitary-tool exclusivity (an `AgentSwarm` or `SwarmDiscussion` call must be
 * the only tool call in its batch, mirroring v1's
 * `agent-swarm-exclusive-deny` policy) is enforced by the first veto listener.
 */

import { t } from '@moonshot-ai/kimi-i18n';
import { Service } from '#/_base/di/service';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';

import { SwarmInjection } from './injection/swarmInjection';
import type { IAgentSwarmService} from './swarm';
import { type SwarmModeTrigger } from './swarm';
import { swarmEnter, swarmExit, SwarmModel } from '../swarmOps';

export class AgentSwarmService extends Service implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IInstantiationService instantiation: IInstantiationService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this._register(
      instantiation.createInstance(SwarmInjection, {
        getTrigger: () => this.wire.getModel(SwarmModel),
      }),
    );
    this._register(
      eventBus.subscribe('turn.ended', () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        const solitaryTools = new Set(['AgentSwarm', 'SwarmDiscussion']);
        const solitaryCount = event.toolCalls.filter((toolCall) =>
          solitaryTools.has(toolCall.name),
        ).length;
        if (solitaryCount === 0 || (solitaryCount === 1 && event.toolCalls.length === 1)) {
          return;
        }
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              solitaryCount > 1
                ? (event.toolCalls.length > solitaryCount
                    ? t('toolsV2.swarm.solitaryMultipleDeniedMixed')
                    : t('toolsV2.swarm.solitaryMultipleDenied'))
                : t('toolsV2.swarm.solitaryMixedDenied'),
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.isActive) return;
        if (event.toolCall.name !== 'Agent') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(agentDeniedInSwarmModeMessage()),
          ),
        );
      }),
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this.wire.getModel(SwarmModel) !== null) return;
    this.wire.dispatch(swarmEnter({ trigger }));
  }

  exit(): void {
    if (this.wire.getModel(SwarmModel) === null) return;
    const history = this.context.get();
    this.wire.dispatch(swarmExit({}));
    this.context.publishTrailingRemoval(history);
  }

  get isActive(): boolean {
    return this.wire.getModel(SwarmModel) !== null;
  }

  private get shouldAutoExit(): boolean {
    const trigger = this.wire.getModel(SwarmModel);
    return trigger === 'task' || trigger === 'tool';
  }
}

function agentDeniedInSwarmModeMessage(): string {
  return t('toolsV2.swarm.agentDeniedInSwarmMode');
}
