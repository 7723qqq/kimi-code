import {
  createUserMessage,
  isContentPart,
  type Message,
} from '@moonshot-ai/kosong';

import { estimateTokensForMessages } from '../../../utils/tokens';
import { renderPrompt } from '../../../utils/render-prompt';
import compactionInstructionTemplate from '../../../agent/compaction/compaction-instruction.md?raw';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionSource,
  type CompactionStrategy,
} from '../../../agent/compaction';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextProjector } from '../contextProjector/contextProjector';
import { ILLMRequester } from '../llmRequester/llmRequester';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage, LLMEvent } from '../types';

export interface CompactInput {
  readonly source: CompactionSource;
  readonly customInstruction?: string;
  readonly signal?: AbortSignal;
}

export class FullCompaction {
  private readonly strategy: CompactionStrategy;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @ILLMRequester private readonly llmRequester: ILLMRequester,
    @ITurnRunner turnRunner: ITurnRunner,
  ) {
    this.strategy = new DefaultCompactionStrategy(
      () => DEFAULT_MAX_CONTEXT_TOKENS,
      DEFAULT_COMPACTION_CONFIG,
    );
    turnRunner.hooks.beforeStep.register('full-compaction', async (_ctx, next) => {
      if (this.strategy.shouldCompact(estimateTokensForMessages(this.projectedHistory()))) {
        await this.compact({ source: 'auto' });
      }
      await next();
    });
  }

  async compact(input: CompactInput): Promise<void> {
    const originalHistory = [...this.context.getHistory()];
    const projected = this.projector.project(originalHistory);
    const compactedCount = this.strategy.computeCompactCount(projected, input.source);
    if (compactedCount <= 0) return;

    const sourceMessages = originalHistory.slice(0, compactedCount);
    const messages = [
      ...this.projector.project(sourceMessages),
      createUserMessage(renderPrompt(compactionInstructionTemplate, {
        customInstruction: input.customInstruction ?? '',
      })),
    ];
    const summary = await collectSummary(
      this.llmRequester.request({ messages }, input.signal),
    );
    if (!historyUnchanged(this.context.getHistory(), originalHistory)) return;

    this.context.spliceHistory(
      0,
      compactedCount,
      createCompactionSummaryMessage(summary),
    );
  }

  private projectedHistory(): readonly Message[] {
    return this.projector.project(this.context.getHistory());
  }
}

const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

async function collectSummary(events: AsyncIterable<LLMEvent>): Promise<string> {
  const parts: string[] = [];
  for await (const event of events) {
    if (event.type !== 'part' || !isContentPart(event.part)) continue;
    if (event.part.type === 'text') {
      parts.push(event.part.text);
    }
  }
  return parts.join('').trim();
}

function createCompactionSummaryMessage(summary: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: summary }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function historyUnchanged(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length !== original.length) return false;
  return current.every((message, index) => message === original[index]);
}
