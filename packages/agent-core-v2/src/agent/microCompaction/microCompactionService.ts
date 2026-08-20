/**
 * `microCompaction` domain — `IAgentMicroCompactionService` implementation.
 *
 * Runs cache-miss micro compaction: `detect` (hooked before each step)
 * checks the `micro-compaction` flag, the prompt-cache miss threshold against
 * the last assistant output time (tracked through `loop`'s `onDidFinishStep`),
 * and the context usage ratio, then raises the wire-persisted cutoff to
 * `history.length - keepRecentMessages`. `compact` (applied to the outgoing
 * request messages in `llmRequester`) replaces old oversized tool results
 * with `truncatedMarker`, leaving history untouched. The cutoff persists on
 * the wire and resets on clear / compaction / undo (the latter through the
 * `context.spliced` event dispatching `micro_compaction.clamp`). Reports the
 * truncation effect through `telemetry` when the cutoff advances. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext, agentContextOfScope } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import type { MicroCompactionFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { estimateTokensForContentParts, estimateTokensForMessages } from '#/kosong/contract/tokens';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';

import { MICRO_COMPACTION_FLAG_ID } from './flag';
import {
  DEFAULT_MICRO_COMPACTION_CONFIG,
  IAgentMicroCompactionService,
  type MicroCompactionConfig,
} from './microCompaction';
import {
  microCompactionKey,
  MicroCompactionApplied,
  MicroCompactionClamped,
} from './microCompactionOps';

interface TruncationEffect {
  readonly truncatedToolResultCount: number;
  readonly truncatedToolResultTokensBefore: number;
  readonly truncatedToolResultTokensAfter: number;
}

// NOTE: stays Disposable — its own 'config' collides with the Fiber
export class AgentMicroCompactionService
  extends Disposable
  implements IAgentMicroCompactionService
{
  declare readonly _serviceBrand: undefined;

  private _config: MicroCompactionConfig = { ...DEFAULT_MICRO_COMPACTION_CONFIG };
  private lastAssistantAt: number | null = null;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this.agentState.contributeState(microCompactionKey);
    this._register(
      this.loop.hooks.onWillBeginStep.register('micro-compaction', async (_ctx, next) => {
        this.detect();
        await next();
      }),
    );
    this._register(
      this.loop.hooks.onDidFinishStep.register('micro-compaction', async (_ctx, next) => {
        this.lastAssistantAt = Date.now();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(ContextSpliced, (event) => {
        // Undo splice only: clear / compaction start at 0 (their zeroing is
        // handled by the state folds) and appends carry deleteCount 0.
        if (event.start > 0 && event.deleteCount > 0) {
          this.clampTo(event.start);
        }
      }),
    );
  }

  get config(): MicroCompactionConfig {
    return this._config;
  }

  setConfig(config: Partial<MicroCompactionConfig>): void {
    this._config = { ...this._config, ...config };
  }

  detect(): void {
    if (!this.flags.enabled(MICRO_COMPACTION_FLAG_ID)) return;

    const config = this.config;
    const history = this.context.get();
    const cacheAgeMs = this.lastAssistantAt === null ? null : Date.now() - this.lastAssistantAt;
    const cacheMissed = cacheAgeMs !== null && cacheAgeMs >= config.cacheMissedThresholdMs;
    if (!cacheMissed) return;

    const modelCapabilities = this.profile.data().modelCapabilities;
    const maxContextTokens =
      modelCapabilities.max_input_tokens ?? modelCapabilities.max_context_tokens;
    const contextTokens = this.tokenCounting.get(agentContextOfScope(this.scopeContext)).size;
    const contextUsageRatio =
      maxContextTokens !== undefined && maxContextTokens > 0 ? contextTokens / maxContextTokens : 1;
    if (contextUsageRatio < config.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - config.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff === nextCutoff) return;

    const effect = this.measureEffect(history, nextCutoff);
    const previousEffect = this.measureEffect(history, previousCutoff);
    const rawContextTokens = estimateTokensForMessages(history);
    // Whole-context length before/after this cutoff change, mirroring the
    // `tokens_before`/`tokens_after` fields on `compaction_finished` so the
    // two compaction paths can be compared on the same axis.
    const tokensBefore =
      rawContextTokens -
      previousEffect.truncatedToolResultTokensBefore +
      previousEffect.truncatedToolResultTokensAfter;
    const tokensAfter =
      rawContextTokens -
      effect.truncatedToolResultTokensBefore +
      effect.truncatedToolResultTokensAfter;
    const properties: MicroCompactionFinishedEvent = {
      keep_recent_messages: config.keepRecentMessages,
      min_content_tokens: config.minContentTokens,
      cache_missed_threshold_ms: config.cacheMissedThresholdMs,
      truncated_marker: config.truncatedMarker,
      min_context_usage_ratio: config.minContextUsageRatio,
      truncated_tool_result_count: effect.truncatedToolResultCount,
      truncated_tool_result_tokens_before: effect.truncatedToolResultTokensBefore,
      truncated_tool_result_tokens_after: effect.truncatedToolResultTokensAfter,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      previous_cutoff: previousCutoff,
      cutoff: nextCutoff,
      message_count: history.length,
      cache_age_ms: cacheAgeMs,
      thinking_effort: this.profile.data().thinkingLevel,
    };
    this.telemetry.track2('micro_compaction_finished', properties);
  }

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.flags.enabled(MICRO_COMPACTION_FLAG_ID)) return messages;

    const config = this.config;
    const cutoff = this.cutoff;
    if (cutoff <= 0) return messages;

    const result: ContextMessage[] = [];
    let changed = false;
    let i = 0;
    for (const message of messages) {
      if (
        i < cutoff &&
        message.role === 'tool' &&
        message.toolCallId !== undefined &&
        estimateTokensForContentParts(message.content) >= config.minContentTokens
      ) {
        changed = true;
        result.push({
          ...message,
          content: [{ type: 'text', text: config.truncatedMarker }],
        });
      } else {
        result.push(message);
      }
      i++;
    }
    return changed ? result : messages;
  }

  private apply(cutoff: number): void {
    void this.dispatcher.dispatch(new MicroCompactionApplied({ cutoff }));
  }

  reset(maxCutoff = 0): void {
    this.clampTo(maxCutoff);
  }

  private clampTo(maxCutoff: number): void {
    void this.dispatcher.dispatch(new MicroCompactionClamped({ maxCutoff }));
  }

  private get cutoff(): number {
    return this.agentState.get(microCompactionKey).cutoff;
  }

  private measureEffect(messages: readonly ContextMessage[], cutoff: number): TruncationEffect {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let truncatedToolResultTokensBefore = 0;
    let truncatedToolResultTokensAfter = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.config.truncatedMarker },
      ]);
      truncatedToolResultCount += 1;
      truncatedToolResultTokensBefore += contentTokens;
      truncatedToolResultTokensAfter += markerTokenCount;
    }
    return {
      truncatedToolResultCount,
      truncatedToolResultTokensBefore,
      truncatedToolResultTokensAfter,
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMicroCompactionService,
  AgentMicroCompactionService,
  ScopeActivation.OnScopeCreated,
  'microCompaction',
);
