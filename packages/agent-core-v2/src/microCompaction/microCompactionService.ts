/**
 * `microCompaction` domain (L4) - `IMicroCompactionService` implementation.
 *
 * Tracks cache-miss compaction cutoffs over `contextMemory`, sizes context via
 * `contextSize`, resolves model capacity through `profile`, persists cutoffs
 * through `wireRecord`, gates behavior through `flag`, emits telemetry, and
 * participates in `turn` hooks. Bound at Agent scope.
 */

import type { ContentPart } from '@moonshot-ai/kosong';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  Disposable,
} from "#/_base/di";
import {
  estimateTokensForContentParts,
  estimateTokensForMessages,
} from "#/_base/utils/tokens";
import type { TelemetryProperties } from '#/telemetry';
import { IConfigRegistry, IConfigService } from '#/config';
import { IContextMemory } from '#/contextMemory';
import { IContextSizeService } from '#/contextSize';
import { IFlagService } from '#/flag';
import { IProfileService } from '#/profile';
import { ITelemetryService } from '#/telemetry';
import { ITurnService } from '#/turn';
import type { ContextMessage } from '../contextMemory';
import { IWireRecord } from '#/wireRecord';
import {
  IMicroCompactionService,
  type MicroCompactionConfig,
  type MicroCompactionEffect,
} from './microCompaction';
import {
  MICRO_COMPACTION_SECTION,
  MicroCompactionConfigSchema,
  type MicroCompactionConfigPatch,
} from './configSection';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'micro_compaction.apply': {
      cutoff: number;
    };
  }
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

export class MicroCompactionService
  extends Disposable
  implements IMicroCompactionService
{
  declare readonly _serviceBrand: undefined;
  private cutoff = 0;
  private microConfig: MicroCompactionConfig;
  private _lastAssistantAt: number | null = null;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IContextSizeService private readonly contextSize: IContextSizeService,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IFlagService private readonly flags: IFlagService,
    @IProfileService private readonly profile: IProfileService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ITurnService turn: ITurnService,
    @IConfigRegistry configRegistry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    configRegistry.registerSection(MICRO_COMPACTION_SECTION, MicroCompactionConfigSchema);
    this.microConfig = this.readConfig();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MICRO_COMPACTION_SECTION) {
          this.microConfig = this.readConfig();
        }
      }),
    );
    this._register(
      turn.hooks.beforeStep.register(
        'micro-compaction',
        async (_ctx, next) => {
          this.detect();
          await next();
        },
        { after: 'turn-before-step-event' },
      ),
    );
    this._register(
      this.wireRecord.register('micro_compaction.apply', (record) => {
        this.apply(record.cutoff);
      }),
    );
    this._register(
      this.wireRecord.register('full_compaction.complete', () => {
        this.reset();
      }),
    );
    this._register(
      this.context.hooks.onSpliced.register('micro-compaction', async (ctx, next) => {
        this.observeSplice(ctx);
        await next();
      }),
    );
  }

  get lastAssistantAt(): number | null {
    return this._lastAssistantAt;
  }

  private reset(maxCutoff = 0): void {
    this.cutoff = Math.min(this.cutoff, maxCutoff);
  }

  private apply(cutoff: number): void {
    this.wireRecord.append({
      type: 'micro_compaction.apply',
      cutoff,
    });
    this.cutoff = cutoff;
  }

  private detect(): void {
    if (!this.flags.enabled('micro_compaction')) return;

    const lastAssistantAt = this._lastAssistantAt;
    if (lastAssistantAt === null) return;

    const cacheAgeMs = Date.now() - lastAssistantAt;
    if (cacheAgeMs < this.microConfig.cacheMissedThresholdMs) return;

    const history = this.context.get();
    if (this.contextSizeRatio() < this.microConfig.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - this.microConfig.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff === nextCutoff) return;

    const effect = this.measureEffect(history, nextCutoff);
    const previousEffect = this.measureEffect(history, previousCutoff);
    const rawContextTokens = estimateTokensForMessages(history);
    const properties: TelemetryProperties = {
      ...this.microConfig,
      ...effect,
      tokensBefore:
        rawContextTokens -
        previousEffect.truncatedToolResultTokensBefore +
        previousEffect.truncatedToolResultTokensAfter,
      tokensAfter:
        rawContextTokens -
        effect.truncatedToolResultTokensBefore +
        effect.truncatedToolResultTokensAfter,
      previous_cutoff: previousCutoff,
      cutoff: nextCutoff,
      message_count: history.length,
      cache_age_ms: cacheAgeMs,
      thinkingLevel: this.profile.data().thinkingLevel,
    };
    this.telemetry.track('micro_compaction_finished', properties);
  }

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.flags.enabled('micro_compaction')) return messages;

    const result: ContextMessage[] = [];
    let index = 0;
    for (const message of messages) {
      if (this.shouldTruncate(message, index)) {
        result.push({
          ...message,
          content: [
            { type: 'text', text: this.microConfig.truncatedMarker } satisfies ContentPart,
          ],
        });
      } else {
        result.push(message);
      }
      index++;
    }
    return result;
  }

  private observeSplice(context: {
    readonly deleteCount: number;
    readonly messages: readonly ContextMessage[];
  }): void {
    if (this.context.get().length === 0) {
      this._lastAssistantAt = null;
      this.reset();
      return;
    }

    if (context.messages.some(isCompactionSummary)) {
      this.reset();
    } else if (context.deleteCount > 0) {
      this.reset(this.context.get().length);
    }

    if (context.messages.some(isAssistantCacheAnchor)) {
      this._lastAssistantAt = this.wireRecord.restoring?.time ?? Date.now();
    }
  }

  private shouldTruncate(message: ContextMessage, index: number): boolean {
    return (
      index < this.cutoff &&
      message.role === 'tool' &&
      message.toolCallId !== undefined &&
      estimateTokensForContentParts(message.content) >= this.microConfig.minContentTokens
    );
  }

  private readConfig(): MicroCompactionConfig {
    const config = this.config.get<MicroCompactionConfigPatch | undefined>(MICRO_COMPACTION_SECTION);
    return { ...DEFAULT_CONFIG, ...config };
  }

  private contextSizeRatio(): number {
    const maxContextTokens = this.profile.getModelCapabilities().max_context_tokens;
    if (maxContextTokens === undefined || maxContextTokens <= 0) return 1;
    return this.contextSize.getStatus().contextTokensWithPending / maxContextTokens;
  }

  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ): MicroCompactionEffect {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let truncatedToolResultTokensBefore = 0;
    let truncatedToolResultTokensAfter = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message === undefined || message.role !== 'tool' || message.toolCallId === undefined) {
        continue;
      }

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.microConfig.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.microConfig.truncatedMarker },
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

function isCompactionSummary(message: ContextMessage): boolean {
  return message.origin?.kind === 'compaction_summary';
}

function isAssistantCacheAnchor(message: ContextMessage): boolean {
  return message.role === 'assistant' && !isCompactionSummary(message);
}

registerScopedService(
  LifecycleScope.Agent,
  IMicroCompactionService,
  MicroCompactionService,
  InstantiationType.Eager,
  'microCompaction',
);
