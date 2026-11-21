import { describe, expect, it } from 'bun:test';

import {
  createMessageAccumulator,
  type ContentPart,
  type StreamedMessagePart,
} from '@moonshot-ai/core/llm/message';
import type { LlmRequestEvent } from '#/llm/requester/requester';
import { createThinkingTagEventHandler } from '@moonshot-ai/core/llm/requester/thinking-tags';
import { createThinkingTagParser, normalizeThinkingTags } from '#/llm/thinking-tags';

function parse(chunks: readonly string[]): ContentPart[] {
  const parser = createThinkingTagParser();
  const accumulator = createMessageAccumulator();
  for (const text of chunks) {
    for (const part of parser.push({ type: 'text', text })) accumulator.push(part);
  }
  for (const part of parser.finish()) accumulator.push(part);
  return accumulator.finish().content;
}

const fixtures: readonly [string, ContentPart[]][] = [
  [
    '<thinking>reasoning</thinking>answer',
    [
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: 'answer' },
    ],
  ],
  [
    'before<think>reasoning</think>after',
    [
      { type: 'text', text: 'before' },
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: 'after' },
    ],
  ],
  [
    '<THINKING >reasoning</THINKING >answer',
    [
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: 'answer' },
    ],
  ],
  [
    '<think>one<thinking>two</thinking>three</think>answer',
    [
      { type: 'think', think: 'onetwothree' },
      { type: 'text', text: 'answer' },
    ],
  ],
  ['<think>unfinished', [{ type: 'think', think: 'unfinished' }]],
  ['<think>reasoning</thinking>tail', [{ type: 'think', think: 'reasoning</thinking>tail' }]],
  ['literal <thi', [{ type: 'text', text: 'literal <thi' }]],
  [
    '{"value":"<think>literal</think>"}',
    [{ type: 'text', text: '{"value":"<think>literal</think>"}' }],
  ],
  [
    '["<thinking>literal</thinking>"]',
    [{ type: 'text', text: '["<thinking>literal</thinking>"]' }],
  ],
  [
    '<<think>plan</think>answer',
    [
      { type: 'text', text: '<' },
      { type: 'think', think: 'plan' },
      { type: 'text', text: 'answer' },
    ],
  ],
  ['<`<think>literal</think>`', [{ type: 'text', text: '<`<think>literal</think>`' }]],
  [
    '<thinking-example>literal</thinking-example>',
    [{ type: 'text', text: '<thinking-example>literal</thinking-example>' }],
  ],
  ['`<think>literal</think>` answer', [{ type: 'text', text: '`<think>literal</think>` answer' }]],
  [
    '``<thinking>literal</thinking>`` answer',
    [{ type: 'text', text: '``<thinking>literal</thinking>`` answer' }],
  ],
  [
    '`backslash\\`<think>plan</think>answer',
    [
      { type: 'text', text: '`backslash\\`' },
      { type: 'think', think: 'plan' },
      { type: 'text', text: 'answer' },
    ],
  ],
  [
    '```xml\n<think>literal</think>\n```\n<think>real</think>answer',
    [
      { type: 'text', text: '```xml\n<think>literal</think>\n```\n' },
      { type: 'think', think: 'real' },
      { type: 'text', text: 'answer' },
    ],
  ],
  [
    '~~~xml\r\n<thinking>literal</thinking>\r\n~~~\r\n<thinking>real</thinking>',
    [
      { type: 'text', text: '~~~xml\r\n<thinking>literal</thinking>\r\n~~~\r\n' },
      { type: 'think', think: 'real' },
    ],
  ],
  [
    '    <think>indented code</think>\n<think>real</think>',
    [
      { type: 'text', text: '    <think>indented code</think>\n' },
      { type: 'think', think: 'real' },
    ],
  ],
  [
    '    code <think>literal</think>\n<think>real</think>answer',
    [
      { type: 'text', text: '    code <think>literal</think>\n' },
      { type: 'think', think: 'real' },
      { type: 'text', text: 'answer' },
    ],
  ],
  ['\\<think>literal</think>', [{ type: 'text', text: '\\<think>literal</think>' }]],
  [
    '&lt;thinking&gt;literal&lt;/thinking&gt;',
    [{ type: 'text', text: '&lt;thinking&gt;literal&lt;/thinking&gt;' }],
  ],
  [
    '<thinking>code `</thinking>` stays here</thinking>answer',
    [
      { type: 'think', think: 'code `</thinking>` stays here' },
      { type: 'text', text: 'answer' },
    ],
  ],
];

describe('thinking tag parsing', () => {
  it.each(fixtures)('parses %s independently of stream boundaries', (source, expected) => {
    expect(parse([source])).toEqual(expected);
    expect(parse(Array.from(source))).toEqual(expected);
    for (let split = 1; split < source.length; split++) {
      expect(parse([source.slice(0, split), source.slice(split)])).toEqual(expected);
    }
  });

  it('emits thinking before a closing marker arrives', () => {
    const parser = createThinkingTagParser();
    expect(parser.push({ type: 'text', text: '<think>working' })).toEqual([
      { type: 'think', think: 'working' },
    ]);
    expect(parser.push({ type: 'text', text: '</thi' })).toEqual([]);
    expect(parser.push({ type: 'text', text: 'nk>answer' })).toEqual([
      { type: 'text', text: 'answer' },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it('preserves native reasoning, media and signed text', () => {
    const native: ContentPart = {
      type: 'think',
      think: 'native',
      encrypted: 'signature',
      reasoningKey: 'reasoning_content',
    };
    const signed: ContentPart = {
      type: 'text',
      text: '<think>signed payload</think>',
      meta: { thought_signature_b64: 'signature' },
    };
    const media: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.test/image.png' },
    };
    const parts = normalizeThinkingTags([native, signed, media]);
    expect(parts).toEqual([native, signed, media]);
    expect(parts[0]).toBe(native);
    expect(parts[1]).toBe(signed);
  });

  it('does not carry an unclosed wrapper over a tool boundary', () => {
    const parser = createThinkingTagParser();
    const tool: StreamedMessagePart = {
      type: 'function',
      id: 'call',
      name: 'Read',
      arguments: '{}',
    };
    expect(parser.push({ type: 'text', text: '<think>plan' })).toEqual([
      { type: 'think', think: 'plan' },
    ]);
    expect(parser.push(tool)).toEqual([tool]);
    expect(parser.push({ type: 'text', text: 'answer' })).toEqual([
      { type: 'text', text: 'answer' },
    ]);
  });

  it('normalizes stored text parts without mutating their source', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: '<thi' },
      { type: 'text', text: 'nking>plan</thinking>answer' },
    ];
    const accumulator = createMessageAccumulator();
    for (const part of normalizeThinkingTags(parts)) accumulator.push(part);
    expect(accumulator.finish().content).toEqual([
      { type: 'think', think: 'plan' },
      { type: 'text', text: 'answer' },
    ]);
    expect(parts).toEqual([
      { type: 'text', text: '<thi' },
      { type: 'text', text: 'nking>plan</thinking>answer' },
    ]);
  });

  it('keeps the text stream intact across empty reasoning fields', () => {
    const parser = createThinkingTagParser();
    const empty: StreamedMessagePart = { type: 'think', think: '', reasoningKey: 'reasoning' };
    expect(parser.push({ type: 'text', text: '<thi' })).toEqual([]);
    expect(parser.push(empty)).toEqual([empty]);
    expect(parser.push({ type: 'text', text: 'nk>checking' })).toEqual([
      { type: 'think', think: 'checking' },
    ]);
    expect(parser.push(empty)).toEqual([empty]);
    expect(parser.push({ type: 'text', text: '</think>answer' })).toEqual([
      { type: 'text', text: 'answer' },
    ]);
  });

  it('reports buffered stream activity without publishing an empty text part', () => {
    const events: LlmRequestEvent[] = [];
    let buffered = 0;
    const emit = createThinkingTagEventHandler({
      onEvent: (event) => events.push(event),
      onBufferedPart: () => {
        buffered++;
      },
    })!;
    emit({ type: 'llm.streaming.part', part: { type: 'text', text: '<thi' } });
    expect(events).toEqual([]);
    expect(buffered).toBe(1);
    emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'nk>plan</think>answer' } });
    expect(buffered).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['llm.streaming.part', 'llm.streaming.part']);
  });

  it('leaves structured response text untouched', () => {
    const events: LlmRequestEvent[] = [];
    const emit = createThinkingTagEventHandler(
      { onEvent: (event) => events.push(event) },
      { type: 'json_object' },
    )!;
    const event: LlmRequestEvent = {
      type: 'llm.streaming.part',
      part: { type: 'text', text: '{"value":"<think>literal</think>"}' },
    };
    emit(event);
    expect(events).toEqual([event]);
  });

  it('keeps a tag prefix through a finish event that precedes its last delta', () => {
    const events: LlmRequestEvent[] = [];
    const emit = createThinkingTagEventHandler({ onEvent: (event) => events.push(event) })!;
    emit({ type: 'llm.streaming.part', part: { type: 'text', text: '<think>plan</thi' } });
    emit({
      type: 'llm.streaming.finish',
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
    });
    emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'nk>answer' } });
    emit({ type: 'llm.done' });
    expect(
      events.filter((event) => event.type === 'llm.streaming.part').map((event) => event.part),
    ).toEqual([
      { type: 'think', think: 'plan' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('flushes pending literals on failure and clears them before a retry', () => {
    const events: LlmRequestEvent[] = [];
    const emit = createThinkingTagEventHandler({ onEvent: (event) => events.push(event) })!;
    emit({ type: 'llm.streaming.part', part: { type: 'text', text: '<thi' } });
    emit({
      type: 'llm.failed.remote',
      error: { kind: 'provider', message: 'failed', retryable: true },
    });
    expect(events[0]).toEqual({ type: 'llm.streaming.part', part: { type: 'text', text: '<thi' } });
    emit({ type: 'llm.request.retrying' });
    emit({ type: 'llm.sent' });
    emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'answer' } });
    emit({ type: 'llm.done' });
    expect(events.at(-2)).toEqual({
      type: 'llm.streaming.part',
      part: { type: 'text', text: 'answer' },
    });
    expect(events.at(-1)).toEqual({ type: 'llm.done' });
  });
});
