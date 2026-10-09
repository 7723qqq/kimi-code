import { estimateTokens, estimateTokensForMessage } from '#/llm/tokens';
import type { Message, ToolDescription } from '#/llm/message';
import { emptyUsage, type TokenUsage } from '#/llm/usage';

import type { AssistantEntry, HistoryMessage } from './turn';

export interface ContextUsagePrefix {
  systemPrompt?: string;
  tools?: readonly ToolDescription[];
}

export function calculateContextTokens(usage: TokenUsage): number {
  return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output;
}

export function estimateTextTokens(text: string): number {
  return estimateTokens(text);
}

export function estimateMessageTokens(message: Message): number {
  return estimateTokensForMessage(message);
}

export function estimateUsedContextTokens(
  history: readonly HistoryMessage[],
  prefix?: ContextUsagePrefix,
): number {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i] as HistoryMessage;
    if (entry.message.role !== 'assistant') continue;
    const tokens = calculateContextTokens((entry as AssistantEntry).meta?.usage ?? emptyUsage());
    if (tokens > 0) {
      lastUsageIndex = i;
      usageTokens = tokens;
      break;
    }
  }
  let tokens = usageTokens;
  for (let i = lastUsageIndex + 1; i < history.length; i++) {
    tokens += estimateMessageTokens((history[i] as HistoryMessage).message);
  }
  if (lastUsageIndex === -1 && prefix !== undefined) {
    if (prefix.systemPrompt !== undefined) {
      tokens += estimateTextTokens(prefix.systemPrompt);
    }
    if (prefix.tools !== undefined && prefix.tools.length > 0) {
      tokens += estimateTextTokens(JSON.stringify(prefix.tools));
    }
  }
  return tokens;
}
