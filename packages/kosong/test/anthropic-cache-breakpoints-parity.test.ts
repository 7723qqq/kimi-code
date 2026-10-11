import { describe, expect, it } from 'vitest';

import { injectCacheControlOnLastBlock as injectKosong } from '#/providers/anthropic-cache-breakpoints';

import { assembleAnthropicRequest } from '../../agent-core-v2/src/human/llm/requester/bases/anthropic/format';

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

// The two Anthropic providers keep separate copies of the breakpoint rule
// (kosong is a frozen kernel and agent-core-v2 may not import it). Both must
// mark the tail AND a stable-history breakpoint — the second one is what keeps
// a long conversation's prefix cached as new turns are appended, and the v2
// requester lost it once when its provider moved (see
// .changeset/v2-anthropic-cache-breakpoint.md). This file asserts they AGREE,
// so the next move that drops one is a test failure rather than a quiet cache
// regression.
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

  it('both sides share the same cacheable block-type set', async () => {
    const kosongTypes = (await import('#/providers/anthropic-cache-breakpoints')).CACHEABLE_TYPES;
    const formatSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL(
          '../../agent-core-v2/src/human/llm/requester/bases/anthropic/format.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const declared = /const CACHEABLE_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(formatSource);
    expect(declared, 'CACHEABLE_TYPES declaration found in the v2 format module').not.toBeNull();
    const v2Types = [...declared![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...kosongTypes].sort()).toEqual(v2Types.sort());
  });
});
