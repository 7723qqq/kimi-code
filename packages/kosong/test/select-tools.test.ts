/**
 * select_tools progressive disclosure — kosong-side contract tests.
 *
 * Covers the two primitives this package contributes:
 *   - `Tool.deferred` stripping in `generate()` (single strip point for every
 *     provider call — the marker itself must never reach the wire);
 *   - the `dynamically_loaded_tools` capability bit (unknown/default-off semantics).
 *
 * The per-wire `Message.tools` serialization assertions that used to live here
 * went away with the standalone provider adapters.
 */

import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY, isUnknownCapability } from '#/capability';
import { catalogModelToCapability } from '#/catalog';
import { generate } from '#/generate';
import { isToolDeclarationOnlyMessage } from '#/message';
import type { Message, StreamedMessagePart } from '#/message';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '#/provider';
import type { Tool } from '#/tool';

const ADD_TOOL: Tool = {
  name: 'add',
  description: 'Add two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

const BUILTIN_TOOL: Tool = {
  name: '$web_search',
  description: 'Search the web',
  parameters: { type: 'object', properties: {} },
};

describe('generate() deferred tool stripping', () => {
  function createCapturingProvider(): { provider: ChatProvider; seenTools: () => Tool[] } {
    let captured: Tool[] = [];
    const stream: StreamedMessage = {
      id: null,
      usage: null,
      finishReason: 'completed',
      rawFinishReason: 'stop',
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        yield { type: 'text', text: 'ok' };
      },
    };
    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null as ThinkingEffort | null,
      generate: async (_systemPrompt, tools, _history) => {
        captured = tools;
        return stream;
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };
    return { provider, seenTools: () => captured };
  }

  it('strips deferred tools before the provider builds the request', async () => {
    const { provider, seenTools } = createCapturingProvider();
    await generate(
      provider,
      'sys',
      [ADD_TOOL, { ...BUILTIN_TOOL, deferred: true }],
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
    );
    expect(seenTools()).toEqual([ADD_TOOL]);
  });

  it('passes the identical array through when nothing is deferred', async () => {
    const { provider, seenTools } = createCapturingProvider();
    const tools = [ADD_TOOL, BUILTIN_TOOL];
    await generate(provider, 'sys', tools, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    expect(seenTools()).toBe(tools);
  });
});

describe('tool-declaration-only message classification', () => {
  const TOOLS_ONLY_MESSAGE: Message = {
    role: 'system',
    content: [],
    toolCalls: [],
    tools: [ADD_TOOL],
  };

  it('classifies tool-declaration-only messages', () => {
    expect(isToolDeclarationOnlyMessage(TOOLS_ONLY_MESSAGE)).toBe(true);
    expect(
      isToolDeclarationOnlyMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        toolCalls: [],
      }),
    ).toBe(false);
    // A message that also carries content is NOT skipped wholesale (only the
    // tools field stays off the wire via explicit field construction).
    expect(
      isToolDeclarationOnlyMessage({
        ...TOOLS_ONLY_MESSAGE,
        content: [{ type: 'text', text: 'x' }],
      }),
    ).toBe(false);
  });
});

describe('dynamically_loaded_tools capability bit', () => {
  const BASE_CAPABILITY = {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: false,
    max_context_tokens: 0,
  };

  it('defaults to false on UNKNOWN_CAPABILITY', () => {
    expect(UNKNOWN_CAPABILITY.dynamically_loaded_tools).toBe(false);
  });

  it('a capability that only has the bit set is not "unknown"', () => {
    expect(isUnknownCapability({ ...BASE_CAPABILITY, dynamically_loaded_tools: true })).toBe(false);
  });

  it('catalog entries map the capability, defaulting to false', () => {
    const base = { id: 'm', limit: { context: 1000 } };
    expect(catalogModelToCapability(base)?.capability.dynamically_loaded_tools).toBe(false);
    expect(
      catalogModelToCapability({ ...base, dynamically_loaded_tools: true })?.capability
        .dynamically_loaded_tools,
    ).toBe(true);
  });
});
