import { describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#human/llm/capability';
import { emptyResponseError, validateStreamCompletion } from '#human/llm/empty-response';
import { NO_FINISH } from '#human/llm/finish-reason';
import {
  createMessageAccumulator,
  type AssistantMessage,
  type StreamedMessagePart,
} from '#human/message';
import type { LlmModel } from '#human/llm/model';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function accumulatedMessage(parts: readonly StreamedMessagePart[]): AssistantMessage {
  const accumulator = createMessageAccumulator();
  for (const part of parts) {
    accumulator.push(part);
  }
  return accumulator.finish();
}

describe('emptyResponseError', () => {
  it.each([
    {
      label: 'text',
      parts: [{ type: 'text', text: 'repeated output' }],
    },
    {
      label: 'tool call',
      parts: [{ type: 'function', id: 'call-repeat', name: 'Read', arguments: '{}' }],
    },
  ] satisfies { readonly label: string; readonly parts: StreamedMessagePart[] }[])(
    'rejects repeated output with $label',
    ({ parts }) => {
      const error = emptyResponseError(accumulatedMessage(parts), model, {
        finishReason: 'other',
        rawFinishReason: 'repeat',
      });
      expect(error).toMatchObject({
        kind: 'empty_response',
        retryable: true,
        finishReason: 'other',
        rawFinishReason: 'repeat',
      });
      expect(error?.message).toContain('repeated output');
    },
  );

  it('reports an empty response when the stream produced nothing', () => {
    const message = accumulatedMessage([]);
    const error = emptyResponseError(message, model, NO_FINISH);
    expect(error).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
    });
    expect(error?.message).toContain('empty response (no content, no tool calls)');
    expect(error?.message).toContain('Provider: test, model: test-model');

    const filtered = emptyResponseError(message, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered).toMatchObject({
      kind: 'empty_response',
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered?.message).toContain('filtered the response');
  });

  it.each([
    { label: 'text', parts: [{ type: 'text' as const, text: 'partial answer' }] },
    { label: 'whitespace', parts: [{ type: 'text' as const, text: '  \n' }] },
    {
      label: 'unfinished tool call',
      parts: [{ type: 'function' as const, id: 'call-1', name: 'Read', arguments: '{"path":' }],
    },
  ])('rejects $label when the stream has no finish event', ({ parts }) => {
    const error = validateStreamCompletion(accumulatedMessage(parts), model, undefined);
    expect(error).toMatchObject({
      kind: 'provider',
      retryable: true,
      message: expect.stringContaining('without a finish event'),
    });
  });

  it('keeps empty, reasoning-only and filtered response classifications ahead of missing finish', () => {
    expect(validateStreamCompletion(accumulatedMessage([]), model, undefined)).toMatchObject({
      kind: 'empty_response',
      retryable: true,
    });
    expect(
      validateStreamCompletion(
        accumulatedMessage([{ type: 'think', think: 'reasoning' }]),
        model,
        undefined,
      ),
    ).toMatchObject({ kind: 'empty_response', retryable: true });
    expect(
      validateStreamCompletion(accumulatedMessage([]), model, {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      }),
    ).toMatchObject({ kind: 'empty_response', retryable: false });
    expect(
      validateStreamCompletion(accumulatedMessage([{ type: 'text', text: 'complete' }]), model, {
        finishReason: null,
        rawFinishReason: null,
      }),
    ).toBeNull();
  });

  it('reports a think-only response but tolerates whitespace text', () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const error = emptyResponseError(thinkOnly, model, NO_FINISH);
    expect(error?.kind).toBe('empty_response');
    expect(error?.message).toContain('only thinking content');

    const whitespace = accumulatedMessage([{ type: 'text', text: '  \n' }]);
    expect(emptyResponseError(whitespace, model, NO_FINISH)).toBeNull();

    const thinkWithWhitespace = accumulatedMessage([
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: ' ' },
    ]);
    expect(emptyResponseError(thinkWithWhitespace, model, NO_FINISH)?.message).toContain(
      'only thinking content',
    );
  });

  it('returns null when the stream produced text or tool calls', () => {
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: 'hi' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'hi' },
        ]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
  });
});
