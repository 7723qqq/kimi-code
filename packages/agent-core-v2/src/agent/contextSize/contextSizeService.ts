import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessage } from '#/_base/utils/tokens';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import type { Message, TokenUsage } from '#/app/llmProtocol';

import { IAgentContextSizeService, type ContextSizeStatus } from './contextSize';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'context_size.measured': {
      length: number;
      tokens: number;
    };
  }
}

export class AgentContextSizeService extends Disposable implements IAgentContextSizeService {
  declare readonly _serviceBrand: undefined;

  private estimates: number[] = [];
  private measuredPrefixTokens: Array<number | null> = [0];
  // A measurement that arrived before its target prefix existed in `estimates`
  // (e.g. `llmRequester` measures `input + output` before the loop appends the
  // assistant message). Promoted into `measuredPrefixTokens` once a later splice
  // grows `estimates` to cover it.
  private pendingMeasurement: { readonly length: number; readonly tokens: number } | null = null;
  private lastEmitted: ContextSizeStatus = {
    contextTokens: 0,
    contextTokensWithPending: 0,
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentRecordService private readonly records: IAgentRecordService,
  ) {
    super();
    this._register(
      this.context.hooks.onSpliced.register('context-size', async (ctx, next) => {
        this.applySplice(ctx);
        await next();
      }),
    );
    this._register(
      records.define('context_size.measured', {
        resume: (r) => {
          this.applyMeasurement(r);
        },
      }),
    );
  }

  getStatus(): ContextSizeStatus {
    const measured = this.lastMeasuredPrefix();
    const pendingTokens = sum(this.estimates.slice(measured.length));
    return {
      contextTokens: measured.tokens,
      contextTokensWithPending: measured.tokens + pendingTokens,
    };
  }

  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void {
    // Only adopt the measurement when `input` still matches the live context.
    // This rejects stale readings (e.g. the context was spliced, or the request
    // used overridden messages) so a mismatched measurement cannot poison state.
    if (!matchesContext(input, this.context.get())) return;
    const length = input.length + output.length;
    const tokens = tokenUsageTotal(usage);
    const record: AgentRecord<'context_size.measured'> = {
      type: 'context_size.measured',
      length,
      tokens,
    };
    this.records.append(record);
    this.applyMeasurement(record);
  }

  private applySplice(context: {
    readonly start: number;
    readonly deleteCount: number;
    readonly messages: readonly ContextMessage[];
    readonly tokens?: number;
  }): void {
    const start = normalizeSpliceStart(context.start, this.estimates.length);
    const deleteCount = clampDeleteCount(context.deleteCount, this.estimates.length - start);
    const inserted = context.messages.map((message) => estimateTokensForMessage(message));
    this.estimates.splice(start, deleteCount, ...inserted);

    const previous = this.measuredPrefixTokens;
    const next = Array.from({ length: this.estimates.length + 1 }, () => null as number | null);
    const copied = Math.min(start, previous.length - 1);
    for (let index = 0; index <= copied; index++) {
      next[index] = previous[index] ?? null;
    }
    next[0] = 0;

    if (context.tokens !== undefined) {
      next[this.estimates.length] = Math.max(0, context.tokens);
    }

    const pending = this.pendingMeasurement;
    if (pending !== null) {
      if (pending.length <= this.estimates.length) {
        next[pending.length] = pending.tokens;
        this.pendingMeasurement = null;
      }
    }

    this.measuredPrefixTokens = next;
    this.emitIfChanged();
  }

  private applyMeasurement(record: AgentRecord<'context_size.measured'>): void {
    const length = normalizeMeasuredLength(record.length);
    const tokens = Math.max(0, record.tokens);
    if (length <= this.estimates.length) {
      this.measuredPrefixTokens[length] = tokens;
      this.emitIfChanged();
    } else {
      // The target prefix does not exist yet; defer until a splice grows the
      // context to cover it (see `pendingMeasurement`).
      this.pendingMeasurement = { length, tokens };
    }
  }

  private lastMeasuredPrefix(): { readonly length: number; readonly tokens: number } {
    for (let index = this.measuredPrefixTokens.length - 1; index >= 0; index--) {
      const tokens = this.measuredPrefixTokens[index];
      if (tokens !== null && tokens !== undefined) {
        return { length: index, tokens };
      }
    }
    return { length: 0, tokens: 0 };
  }

  private emitIfChanged(): void {
    const status = this.getStatus();
    if (status.contextTokens === this.lastEmitted.contextTokens) {
      return;
    }
    this.lastEmitted = status;
    this.records.signal({
      type: 'agent.status.updated',
      contextTokens: status.contextTokens,
    });
  }
}

function normalizeSpliceStart(start: number, length: number): number {
  if (start < 0) return Math.max(0, length + start);
  return Math.min(start, length);
}

function clampDeleteCount(deleteCount: number, max: number): number {
  if (!Number.isFinite(deleteCount) || deleteCount <= 0) return 0;
  return Math.min(deleteCount, Math.max(0, max));
}

function normalizeMeasuredLength(length: number): number {
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.floor(length));
}

function matchesContext(input: readonly Message[], context: readonly ContextMessage[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== context[index]) return false;
  }
  return true;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextSizeService,
  AgentContextSizeService,
  InstantiationType.Delayed,
  'contextSize',
);
