// Historical coverage: issue #4584; PR #4586 and #4628.
import { describe, expect, it } from 'bun:test';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';

import { asyncChunks, doneOutcome, openAIChunk, runGenerate, testModule } from '../harness';

describe('LLM streamed tool-call boundaries', () => {
  it('as a user, I want every streamed tool call to emit one complete tool_call_end', async () => {
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => ({
        body: asyncChunks([
          openAIChunk({
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Paris"}' },
            }],
          }),
          openAIChunk({
            tool_calls: [{
              index: 1,
              id: 'call_2',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"news"}' },
            }],
          }),
          openAIChunk({}, {
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 2, completion_tokens: 4 },
          }),
        ]),
        headers: {},
      }),
    };
    const result = await runGenerate(protocol, {
      module: testModule(),
    });

    expect(doneOutcome(result.outcome).message.toolCalls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    expect(result.events.filter((event) => event.type === 'llm.streaming.tool_call_end').map((event) => event.toolCall.id)).toEqual([
      'call_1',
      'call_2',
    ]);
    expect(result.events.filter((event) => event.type === 'llm.streaming.tool_call_end').map((event) => event.index)).toEqual([0, 1]);
  });
});
