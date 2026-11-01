import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { CompactionCompleted } from '#/agent/fullCompaction/compactionOps';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import type { CacheBreakDetectedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TokenUsage } from '#human/llm/usage';

import {
  IAgentCacheBreakService,
  type CacheBreakCause,
  type CacheBreakObservation,
  type CacheBreakObserveInput,
  type CacheBreakSnapshot,
} from './cacheBreak';

const CACHE_BREAK_MIN_DROP_TOKENS = 2000;
const CACHE_BREAK_DROP_RATIO = 0.95;

export class AgentCacheBreakService extends Service implements IAgentCacheBreakService {
  declare readonly _serviceBrand: undefined;

  private baseline: CacheBreakSnapshot | undefined;

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly logger: ILogService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this._register(
      eventBus.subscribe((event) => {
        if (event instanceof CompactionCompleted) this.reset();
      }),
    );
  }

  observe(input: CacheBreakObserveInput): CacheBreakObservation | undefined {
    const { usage, cache } = input;
    if (cache === undefined) return undefined;
    if (isUnmeasured(usage)) return undefined;
    const now = input.now ?? Date.now();
    const current: CacheBreakSnapshot = {
      model: cache.modelAlias,
      effort: cache.thinkingEffort ?? '',
      projection: cache.projection,
      messageCount: cache.messageCount,
      usage,
      at: now,
    };
    const previous = this.baseline;
    this.baseline = current;
    if (previous === undefined) return undefined;
    const previousRead = previous.usage.inputCacheRead;
    const currentRead = usage.inputCacheRead;
    if (currentRead >= previousRead * CACHE_BREAK_DROP_RATIO) return undefined;
    if (previousRead - currentRead <= CACHE_BREAK_MIN_DROP_TOKENS) return undefined;
    const cause = classifyCacheBreak(previous, current);
    const observation: CacheBreakObservation = {
      cause,
      previous,
      current,
      cacheReadDropRatio: (previousRead - currentRead) / previousRead,
      intervalMs: now - previous.at,
    };
    this.logger.warn(
      `[cache] prompt-cache break detected (${cause}): cache read dropped ${previousRead - currentRead} ` +
        `tokens (${Math.round(observation.cacheReadDropRatio * 100)}%) between steps, ` +
        `${(observation.intervalMs / 1000).toFixed(1)}s after the previous request ` +
        `(model ${previous.model} -> ${current.model}, effort ${previous.effort} -> ${current.effort})`,
    );
    const properties: CacheBreakDetectedEvent = {
      turn_id: input.turnId,
      step_no: input.step,
      cause,
      prev_model: previous.model,
      curr_model: current.model,
      prev_effort: previous.effort,
      curr_effort: current.effort,
      prev_projection: previous.projection,
      curr_projection: current.projection,
      prev_message_count: previous.messageCount,
      curr_message_count: current.messageCount,
      prev_input_cache_read: previousRead,
      curr_input_cache_read: currentRead,
      prev_input_other: previous.usage.inputOther,
      curr_input_other: usage.inputOther,
      prev_output: previous.usage.output,
      curr_output: usage.output,
      prev_input_cache_creation: previous.usage.inputCacheCreation,
      curr_input_cache_creation: usage.inputCacheCreation,
      cache_read_drop_ratio: observation.cacheReadDropRatio,
      interval_ms: observation.intervalMs,
    };
    this.telemetry.track2('cache_break_detected', properties);
    return observation;
  }

  reset(): void {
    this.baseline = undefined;
  }
}

function isUnmeasured(usage: TokenUsage): boolean {
  return (
    usage.inputOther === 0 &&
    usage.output === 0 &&
    usage.inputCacheRead === 0 &&
    usage.inputCacheCreation === 0
  );
}

function classifyCacheBreak(
  previous: Pick<CacheBreakSnapshot, 'model' | 'effort' | 'projection' | 'messageCount'>,
  current: Pick<CacheBreakSnapshot, 'model' | 'effort' | 'projection' | 'messageCount'>,
): CacheBreakCause {
  if (previous.model !== current.model) return 'model_switch';
  if (previous.effort !== current.effort) return 'effort_switch';
  if (previous.projection !== current.projection) return 'projection_change';
  if (
    previous.messageCount !== undefined &&
    current.messageCount !== undefined &&
    current.messageCount < previous.messageCount
  ) {
    return 'prefix_reset';
  }
  return 'unexplained';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCacheBreakService,
  AgentCacheBreakService,
  ScopeActivation.OnScopeCreated,
  'cacheBreak',
);
