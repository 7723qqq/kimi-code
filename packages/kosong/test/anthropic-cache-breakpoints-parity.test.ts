import { describe, expect, it } from 'bun:test';

import { injectCacheControlOnLastBlock as injectKosong } from '#/providers/anthropic-cache-breakpoints';

import {
  assembleAnthropicRequest,
  defaultAnthropicMergeHistory,
} from '../../agent-core-v2/src/human/llm/requester/bases/anthropic/format';

interface Block {
  type: string;
  text?: string;
  cache_control?: { type: string };
}

interface Message {
  role: 'user' | 'assistant';
  content: Block[];
}

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: [{ type: 'text', text: `m${i}` }],
  }));
}

function markedIndexes(list: Message[]): number[] {
  const out: number[] = [];
  list.forEach((m, i) => {
    if (m.content.some((b) => b.cache_control !== undefined)) out.push(i);
  });
  return out;
}

// The breakpoint rule itself lives in @moonshot-ai/runtime-shared, but the two
// Anthropic call sites reach it through different wire shapes: kosong adapts
// MessageParam (content may be a plain string) and agent-core-v2 adapts its own
// AnthropicWireMessage through messageContent(). This file asserts both call
// sites still land the same marks, so a future adapter change that drops the
// stable-history breakpoint fails here instead of silently regressing the cache.
describe('anthropic cache breakpoints: kosong vs agent-core-v2', () => {
  function markV2(list: Message[]): number[] {
    assembleAnthropicRequest(
      { model: { model: 'claude-test' } } as never,
      {
        messages: list,
        tools: [],
        systemPrompt: undefined,
        kwargs: {},
        betas: [],
        useBetaApi: false,
      } as never,
    );
    return markedIndexes(list);
  }

  it('both sides mark the tail plus a stable history breakpoint on a long conversation', () => {
    const kosongList = messages(6);
    injectKosong(kosongList as never);
    expect(markedIndexes(kosongList)).toEqual([3, 5]);

    const v2List = messages(6);
    expect(markV2(v2List)).toEqual([3, 5]);
  });

  it('both sides mark only the tail on a short conversation', () => {
    const kosongList = messages(3);
    injectKosong(kosongList as never);
    expect(markedIndexes(kosongList)).toEqual([2]);

    const v2List = messages(3);
    expect(markV2(v2List)).toEqual([2]);
  });

  it('both sides agree at every length', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 10]) {
      const kosongList = messages(count);
      injectKosong(kosongList as never);
      const v2List = messages(count);
      expect(markV2(v2List), `length ${count}`).toEqual(markedIndexes(kosongList));
    }
  });
});

/**
 * The stable breakpoint is only useful if it lands where the previous request's
 * tail breakpoint did. That holds while the wire history grows by exactly two
 * messages per step — the assistant reply plus one merged user turn — which is
 * why reminders appended before a step must merge into the user message rather
 * than add one. These cases pin the cadence, not just the placement.
 */
describe('anthropic cache breakpoint cadence across requests', () => {
  interface WireMessage {
    role: 'user' | 'assistant';
    content: Block[];
  }

  function wireMessages(count: number): WireMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `m${i}` }],
    }));
  }

  function requestMarked(list: WireMessage[]): number[] {
    const merged = defaultAnthropicMergeHistory(list as never) as unknown as WireMessage[];
    assembleAnthropicRequest(
      { model: { model: 'claude-test' } } as never,
      {
        messages: merged,
        tools: [],
        systemPrompt: undefined,
        kwargs: {},
        betas: [],
        useBetaApi: false,
      } as never,
    );
    return merged.reduce<number[]>((out, message, index) => {
      if (message.content.some((block) => block.cache_control !== undefined)) out.push(index);
      return out;
    }, []);
  }

  it('lands each request on the previous tail when the wire grows by two', () => {
    let previousTail: number | undefined;
    for (const count of [3, 5, 7, 9]) {
      const marked = requestMarked(wireMessages(count));
      const tail = marked.at(-1)!;
      if (previousTail !== undefined) expect(marked[0], `length ${count}`).toBe(previousTail);
      previousTail = tail;
    }
  });

  it('keeps the cadence when a step-start reminder merges into the user turn', () => {
    const previous = wireMessages(5);
    const previousTail = requestMarked(previous).at(-1)!;

    const next: WireMessage[] = [
      ...wireMessages(6),
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>note</system-reminder>' }],
      },
    ];
    const merged = defaultAnthropicMergeHistory(next as never) as unknown as WireMessage[];
    expect(merged.length).toBe(7);

    const marked = requestMarked(next);
    expect(marked[0]).toBe(previousTail);
  });

  it('never lands the stable breakpoint on a tail message that a retry merged in place', () => {
    const previous = wireMessages(5);
    const previousTail = requestMarked(previous).at(-1)!;

    const retried: WireMessage[] = [
      ...wireMessages(5),
      { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
    ];
    const marked = requestMarked(retried);
    expect(marked.at(-1)).toBe(4);
    expect(marked[0]!).toBeLessThan(previousTail);
  });
});
