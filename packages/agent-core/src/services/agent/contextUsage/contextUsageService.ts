import type { TokenUsage } from '@moonshot-ai/kosong';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import type { CompactionResult } from '../../../agent/compaction';
import { estimateTokensForMessage } from '../../../utils/tokens';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IEventBus } from '../eventBus/eventBus';
import { IProfileService } from '../profile/profile';
import type { ContextMessage } from '../types';
import {
  IContextUsageService,
  type ContextTokenStatus,
} from './contextUsage';

declare module '../types' {
  interface AgentEventMap {
    'context.token_status.changed': {
      status: ContextTokenStatus;
    };
  }
}

export class ContextUsageService
  extends Disposable
  implements IContextUsageService
{
  declare readonly _serviceBrand: undefined;

  private estimates: number[] = [];
  private totalEstimatedTokens = 0;
  private coveredMessageCount = 0;
  private coveredEstimatedTokens = 0;
  private contextTokens = 0;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IEventBus private readonly events: IEventBus,
    @IProfileService private readonly profile: IProfileService,
  ) {
    super();
    this._register(
      this.context.hooks.onSpliced.register('context-usage', async (ctx, next) => {
        this.applySplice(ctx);
        await next();
      }),
    );
    this._register(
      this.events.on((event) => {
        if (event.type === 'config.updated' && event.changed.modelAlias !== undefined) {
          this.emitChanged();
        }
      }),
    );
  }

  getStatus(): ContextTokenStatus {
    return {
      contextTokens: this.contextTokens,
      contextTokensWithPending:
        this.contextTokens + this.totalEstimatedTokens - this.coveredEstimatedTokens,
    };
  }

  coverThrough(indexExclusive: number, usage?: TokenUsage): void {
    const nextCovered = Math.max(
      this.coveredMessageCount,
      Math.min(Math.max(0, indexExclusive), this.estimates.length),
    );
    const newlyCovered = sum(this.estimates.slice(this.coveredMessageCount, nextCovered));
    const totalUsage = usage === undefined ? 0 : tokenUsageTotal(usage);
    this.contextTokens = totalUsage > 0 ? totalUsage : this.contextTokens + newlyCovered;
    this.coveredEstimatedTokens += newlyCovered;
    this.coveredMessageCount = nextCovered;
    this.emitChanged();
  }

  applyCompactionResult(result: Pick<CompactionResult, 'tokensAfter'>): void {
    this.contextTokens = result.tokensAfter;
    this.coveredMessageCount = this.estimates.length;
    this.coveredEstimatedTokens = this.totalEstimatedTokens;
    this.emitChanged();
  }

  private applySplice(context: {
    readonly start: number;
    readonly deleteCount: number;
    readonly messages: readonly ContextMessage[];
  }): void {
    const start = normalizeSpliceStart(context.start, this.estimates.length);
    const inserted = context.messages.map((message) => estimateTokensForMessage(message));
    const removed = this.estimates.splice(start, context.deleteCount, ...inserted);
    const insertedTokens = sum(inserted);
    const removedTokens = sum(removed);
    this.totalEstimatedTokens += insertedTokens - removedTokens;

    if (start < this.coveredMessageCount) {
      this.contextTokens = this.totalEstimatedTokens;
      this.coveredMessageCount = this.estimates.length;
      this.coveredEstimatedTokens = this.totalEstimatedTokens;
    }
    this.emitChanged();
  }

  private emitChanged(): void {
    const status = this.getStatus();
    this.events.emit({ type: 'context.token_status.changed', status });
    const maxContextTokens = this.maxContextTokens();
    this.events.emit({
      type: 'agent.status.updated',
      contextTokens: status.contextTokens,
      maxContextTokens,
      contextUsage:
        maxContextTokens !== undefined && maxContextTokens > 0
          ? status.contextTokens / maxContextTokens
          : undefined,
    });
  }

  private maxContextTokens(): number | undefined {
    try {
      return this.profile.getModelCapabilities().max_context_tokens;
    } catch {
      return undefined;
    }
  }
}

function normalizeSpliceStart(start: number, length: number): number {
  if (start < 0) return Math.max(0, length + start);
  return Math.min(start, length);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

registerSingleton(
  IContextUsageService,
  new SyncDescriptor(ContextUsageService, [], true),
);
