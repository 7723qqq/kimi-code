// Historical coverage: issue #4964 and #4997; PR #5006 and #5012.
import { describe, expect, it } from 'bun:test';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';

import {
  asyncChunks,
  doneOutcome,
  failedOutcome,
  openAIChunk,
  openAICompletion,
  runGenerate,
  testModule,
} from '../harness';

describe('LLM delta finish boundaries', () => {
  it('as a user, I want incomplete streams to fail while non-streaming responses can complete without a finish event', async () => {
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => ({
        body: asyncChunks([openAIChunk({ content: 'incomplete text' })]),
        headers: {},
      }),
      send: async () => ({
        body: openAICompletion({ content: 'completed text' }),
        headers: {},
      }),
    };

    const incomplete = failedOutcome((await runGenerate(protocol, {
      module: testModule(),
    })).outcome);
    expect(incomplete.error).toMatchObject({
      kind: 'provider',
      retryable: true,
      message: expect.stringContaining('without a finish event'),
    });

    const nonStreaming = doneOutcome((await runGenerate(protocol, {
      module: testModule(),
      stream: false,
    })).outcome);
    expect(nonStreaming.message.content).toEqual([{ type: 'text', text: 'completed text' }]);
  });

  it('as a user, I want a provider error frame to preserve partial content and omit synthetic finish events', async () => {
    const protocol = {
      ...openAIResponsesProtocol,
      sendStream: async () => ({
        body: asyncChunks([
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'error', code: 'server_error', message: 'stream failed' },
        ]),
        headers: { 'x-request-id': 'req-stream-error' },
      }),
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
    });

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { kind: 'status', message: 'stream failed', retryable: true },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        attributes: { source: 'salvaged' },
      },
    });
    expect(result.events.some((event) => event.type === 'llm.timing')).toBe(true);
    expect(result.events.some((event) => event.type === 'llm.streaming.finish')).toBe(false);
    expect(result.events.at(-1)).toMatchObject({ type: 'llm.ended', outcome: { type: 'failed' } });
  });
});
