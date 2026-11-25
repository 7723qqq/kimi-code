// Historical coverage: issue #96, #2226 and #2506; PR #3601.
import { describe, expect, it } from 'bun:test';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';

import { asyncChunks, doneOutcome, openAIChunk, runGenerate, testModule } from '../harness';

describe('LLM streamed message parts', () => {
  it('as a user, I want reasoning and text parts to keep their order and adjacent text to accumulate', async () => {
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => ({
        body: asyncChunks([
          openAIChunk({ reasoning_content: 'reasoning' }),
          openAIChunk({ content: 'answer' }),
          openAIChunk({ content: ' complete' }),
          openAIChunk({}, { finishReason: 'stop' }),
        ]),
        headers: {},
      }),
    };
    const result = await runGenerate(protocol, {
      module: testModule(),
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([
      { type: 'think', think: 'reasoning', reasoningKey: 'reasoning_content' },
      { type: 'text', text: 'answer complete' },
    ]);
    expect(result.events.filter((event) => event.type === 'llm.delta.part').map((event) => event.part.type)).toEqual([
      'think',
      'text',
      'text',
    ]);
  });
});
