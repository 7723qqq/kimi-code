import { afterEach, describe, expect, it } from 'vitest';

import type { ChatProvider, Message, StreamedMessage, Tool } from '@moonshot-ai/kosong';

import { createScopedTestHost } from '#/_base/di/test';
import { IProtocolHandlerRegistry } from '#/kosong';

function stubProvider(): ChatProvider {
  const stream: StreamedMessage = {
    async *[Symbol.asyncIterator]() {
      // empty
    },
    id: null,
    usage: null,
    finishReason: null,
    rawFinishReason: null,
  };
  return {
    name: 'stub',
    modelName: 'stub-model',
    thinkingEffort: null,
    generate(_systemPrompt: string, _tools: Tool[], _history: Message[]): Promise<StreamedMessage> {
      return Promise.resolve(stream);
    },
    withThinking(): ChatProvider {
      return this;
    },
  };
}

describe('ProtocolHandlerRegistry', () => {
  it('creates a built-in handler by type', () => {
    const host = createScopedTestHost();
    afterEach(() => host.core.dispose());
    const registry = host.core.accessor.get(IProtocolHandlerRegistry);
    const provider = registry.create({ type: 'kimi', model: 'kimi-model', apiKey: 'sk-test' });
    expect(provider.name).toBe('kimi');
    expect(provider.modelName).toBe('kimi-model');
  });

  it('lets a registered factory override a built-in type', () => {
    const host = createScopedTestHost();
    afterEach(() => host.core.dispose());
    const registry = host.core.accessor.get(IProtocolHandlerRegistry);
    const stub = stubProvider();
    registry.register('kimi', () => stub);
    expect(registry.create({ type: 'kimi', model: 'x' })).toBe(stub);
  });
});
