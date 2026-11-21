import { describe, expect, it } from 'bun:test';

import type { StreamParseSink } from '#human/llm/protocol/format';
import { anthropicFormat } from '#human/llm/requester/bases/anthropic/format';
import { createOpenAIFormat } from '#human/llm/requester/bases/openai/format';
import type { TokenUsage } from '#human/llm/usage';

const openAIFormat = createOpenAIFormat();

function createSink() {
  const usages: Partial<TokenUsage>[] = [];
  const sink: StreamParseSink = {
    onDelta: () => {},
    onFinish: () => {},
    onUsage: (usage) => usages.push(usage),
  };
  return { sink, usages };
}

describe('openAIFormat stream usage', () => {
  it('emits usage from the usage chunk', () => {
    const { sink, usages } = createSink();
    const raw = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    openAIFormat.createStreamParser()({ choices: [], usage: raw }, sink);
    expect(usages).toEqual([
      { inputOther: 120, output: 30, inputCacheRead: 0, inputCacheCreation: 0, raw },
    ]);
  });

  it.each([undefined, null])(
    'falls back to first-choice usage when top-level usage is %s',
    (usage) => {
      const { sink, usages } = createSink();
      const raw = { prompt_tokens: 5, completion_tokens: 1 };
      openAIFormat.createStreamParser()({ choices: [{ usage: raw }], usage }, sink);
      expect(usages).toEqual([
        { inputOther: 5, output: 1, inputCacheRead: 0, inputCacheCreation: 0, raw },
      ]);
    },
  );

  it.each([
    { raw: { prompt_tokens: 120, completion_tokens: 30 }, inputOther: 120, output: 30 },
    { raw: {}, inputOther: 0, output: 0 },
  ])(
    'prefers top-level usage without adding choice totals: $raw',
    ({ raw, inputOther, output }) => {
      const { sink, usages } = createSink();
      openAIFormat.createStreamParser()(
        { choices: [{ usage: { prompt_tokens: 5, completion_tokens: 1 } }], usage: raw },
        sink,
      );
      expect(usages).toEqual([
        { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0, raw },
      ]);
    },
  );

  it('uses only the first choice for usage fallback', () => {
    const { sink, usages } = createSink();
    openAIFormat.createStreamParser()(
      { choices: [{ usage: null }, { usage: { prompt_tokens: 5, completion_tokens: 1 } }] },
      sink,
    );
    expect(usages).toEqual([]);
  });

  it('splits cached tokens out of the prompt total', () => {
    const { sink, usages } = createSink();
    const raw = {
      prompt_tokens: 200,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 12 },
    };
    openAIFormat.createStreamParser()({ usage: raw }, sink);
    expect(usages).toEqual([
      { inputOther: 120, output: 50, inputCacheRead: 80, inputCacheCreation: 0, raw },
    ]);
  });

  it('emits nothing for chunks without usage', () => {
    const { sink, usages } = createSink();
    const parse = openAIFormat.createStreamParser();
    parse({ choices: [] }, sink);
    parse({ usage: null }, sink);
    expect(usages).toEqual([]);
  });
});

describe('anthropicFormat stream usage', () => {
  it('emits message_start input usage and message_delta output usage as they arrive', () => {
    const { sink, usages } = createSink();
    const parse = anthropicFormat.createStreamParser();
    const startRaw = {
      input_tokens: 500,
      output_tokens: 1,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    };
    const deltaRaw = { output_tokens: 87 };
    parse({ type: 'message_start', message: { usage: startRaw } }, sink);
    parse({ type: 'message_delta', usage: deltaRaw }, sink);
    expect(usages).toEqual([
      {
        inputOther: 500,
        inputCacheRead: 300,
        inputCacheCreation: 100,
        raw: startRaw,
      },
      { output: 87, raw: deltaRaw },
    ]);
  });

  it('emits a message_delta usage on its own', () => {
    const { sink, usages } = createSink();
    anthropicFormat.createStreamParser()(
      { type: 'message_delta', usage: { output_tokens: 87 } },
      sink,
    );
    expect(usages).toEqual([{ output: 87, raw: { output_tokens: 87 } }]);
  });

  it('emits nothing for events without usage', () => {
    const { sink, usages } = createSink();
    anthropicFormat.createStreamParser()(
      { type: 'content_block_delta', delta: { text: 'hi' } },
      sink,
    );
    expect(usages).toEqual([]);
  });
});
