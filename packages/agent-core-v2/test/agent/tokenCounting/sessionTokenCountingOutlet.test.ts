import { describe, expect, it } from 'bun:test';

import type { IConfigService } from '#/app/config/config';
import type { ISessionEventBus } from '#/app/event/eventBus';
import { createToolMessage, createUserMessage } from '#/llm-adapter/contract/message';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '#/llm-adapter/contract/tokens';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { SessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCountingService';

function outlet(): SessionTokenCountingService {
  const config = { get: () => undefined } as unknown as IConfigService;
  const eventBus = { subscribe: () => ({ dispose() {} }) } as unknown as ISessionEventBus;
  const lifecycle = { get: () => undefined } as unknown as IAgentLifecycleService;
  return new SessionTokenCountingService(config, eventBus, lifecycle);
}

const messages = [createUserMessage('hello'), createToolMessage('c1', 'output')];
const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }];

describe('session token counting outlet', () => {
  it('counts messages with the estimator the baseline pins', () => {
    expect(outlet().estimateMessages(messages)).toBe(estimateTokensForMessages(messages));
  });

  it('counts a single message with the same estimator', () => {
    expect(outlet().estimateMessage(messages[0]!)).toBe(estimateTokensForMessages([messages[0]!]));
  });

  it('counts tools with the estimator the compaction budget uses', () => {
    expect(outlet().estimateTools(tools)).toBe(estimateTokensForTools(tools));
  });

  it('counts text with the raw estimator', () => {
    expect(outlet().estimateText('hello')).toBe(estimateTokens('hello'));
  });

  it('sums the prompt budget from the same three estimators', () => {
    const size = outlet().requestSize({ systemPrompt: 'sys', messages, tools });
    expect(size).toBe(
      estimateTokens('sys') + estimateTokensForTools(tools) + estimateTokensForMessages(messages),
    );
  });
});
