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
// (kosong is a frozen kernel and agent-core-v2 may not import it). This file
// pins the DELIBERATE difference so neither side drifts silently: kosong marks
// the tail plus one stable-history message (four cache_control slots: system,
// tools, history, tail), while the v2 requester marks the tail only.
describe('anthropic cache breakpoints: kosong vs agent-core-v2', () => {
  it('kosong marks the tail plus a stable history breakpoint on a long conversation', () => {
    const list = messages(6);
    injectKosong(list as never);
    expect(markedIndexes(list)).toEqual([3, 5]);
  });

  it('kosong marks only the tail on a short conversation', () => {
    const list = messages(3);
    injectKosong(list as never);
    expect(markedIndexes(list)).toEqual([2]);
  });

  it('v2 marks the tail only, at every length', () => {
    for (const count of [1, 3, 6]) {
      const list = messages(count);
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
      expect(markedIndexes(list), `length ${count}`).toEqual([count - 1]);
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
