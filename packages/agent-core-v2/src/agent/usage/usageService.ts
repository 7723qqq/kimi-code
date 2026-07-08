/**
 * `usage` domain (L3) — `IAgentUsageService` implementation.
 *
 * Accumulates the agent's token usage in the `wire` `UsageModel`, mutating it
 * only through the `usage.record` Op (`wire.dispatch(recordUsage(...))`) and
 * deriving `status()` snapshots from `wire.getModel`. The per-turn accumulator
 * (`currentTurn`) is live-only service state — it is not persisted and resets
 * on resume, matching v1. The usage slice of `agent.status.updated` is
 * published here after each live record (replay stays silent, like v1's
 * restore). Bound at Agent scope.
 */

import { addUsage, type TokenUsage } from '#/app/llmProtocol/usage';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import type { UsageStatus } from './usage';
import { IAgentUsageService } from './usage';
import {
  copyUsage,
  recordUsage,
  UsageModel,
  usageStatusFromState,
  type UsageRecordScope,
} from './usageOps';

export class AgentUsageService extends Disposable implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  private currentTurnId: number | undefined;
  private currentTurn: TokenUsage | undefined;

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus?: IEventBus,
  ) {
    super();
  }

  record(model: string, usage: TokenUsage, source?: LLMRequestSource): void {
    const usageScope: UsageRecordScope = source?.type === 'turn' ? 'turn' : 'session';
    this.wire.dispatch(recordUsage({ model, usage, usageScope }));

    const turnId = source?.type === 'turn' ? source.turnId : undefined;
    if (turnId !== undefined) {
      if (this.currentTurnId !== turnId) {
        this.currentTurnId = turnId;
        this.currentTurn = copyUsage(usage);
      } else {
        this.currentTurn =
          this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
      }
    }

    this.eventBus?.publish({ type: 'agent.status.updated', usage: this.status() });
  }

  status(): UsageStatus {
    return usageStatusFromState(this.wire.getModel(UsageModel), this.currentTurn);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  InstantiationType.Delayed,
  'usage',
);
