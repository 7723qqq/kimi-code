import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import { estimateTokensForContentParts } from '../../utils/tokens';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

const ONE_TIME_CONTEXT_USAGE_TRIGGER_RATIO = 0.6;

export class MicroCompaction {
  private cutoff = 0;
  private contextUsageTriggered = false;
  readonly config: MicroCompactionConfig;

  constructor(
    public readonly agent: Agent,
    config?: Partial<MicroCompactionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  reset(maxCutoff = 0): void {
    this.cutoff = Math.min(this.cutoff, maxCutoff);
  }

  apply(cutoff: number): void {
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    });
    this.cutoff = cutoff;
  }

  detect(): void {
    if (!this.agent.experimentalFlags.enabled('micro_compaction')) return;

    const config = this.config;
    const { history, lastAssistantAt } = this.agent.context;
    const cacheAgeMs = lastAssistantAt === null ? null : Date.now() - lastAssistantAt;
    const cacheMissed = cacheAgeMs !== null && cacheAgeMs >= config.cacheMissedThresholdMs;

    const contextUsageRatio = this.contextUsageRatio();
    if (
      contextUsageRatio !== undefined &&
      !this.contextUsageTriggered &&
      contextUsageRatio >= ONE_TIME_CONTEXT_USAGE_TRIGGER_RATIO
    ) {
      const nextCutoff = Math.max(0, history.length - config.keepRecentMessages);
      if (nextCutoff > this.cutoff) {
        this.contextUsageTriggered = true;
        this.apply(nextCutoff);
        return;
      }
    }

    if (!cacheMissed) return;

    const cacheMissContextUsageRatio = contextUsageRatio ?? 1;
    if (cacheMissContextUsageRatio < config.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - config.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff !== nextCutoff) {
      const effect = this.measureEffect(history, nextCutoff);
      this.agent.telemetry.track('micro_compaction_applied', {
        ...config,
        ...effect,
        previous_cutoff: previousCutoff,
        cutoff: nextCutoff,
        message_count: history.length,
        cache_age_ms: cacheAgeMs,
      });
    }
  }

  private contextUsageRatio(): number | undefined {
    const maxContextTokens = this.agent.config.modelCapabilities.max_context_tokens;
    if (maxContextTokens === undefined || maxContextTokens <= 0) return undefined;
    return this.agent.context.tokenCountWithPending / maxContextTokens;
  }

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.agent.experimentalFlags.enabled('micro_compaction')) return messages;

    const config = this.config;
    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      if (
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        estimateTokensForContentParts(msg.content) >= config.minContentTokens
      ) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: config.truncatedMarker } satisfies ContentPart],
        });
      } else {
        result.push(msg);
      }
      i++;
    }
    return result;
  }

  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ) {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let beforeTokens = 0;
    let afterTokens = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.config.truncatedMarker },
      ]);
      truncatedToolResultCount += 1;
      beforeTokens += contentTokens;
      afterTokens += markerTokenCount;
    }
    return { truncatedToolResultCount, beforeTokens, afterTokens };
  }
}
