/**
 * Cache-breakpoint injection through the vendored Anthropic base.
 *
 * The base must delegate to the shared kosong breakpoint module (tail +
 * stable-history strategy) instead of re-declaring its own — a local
 * tail-only copy silently degraded v2-engine cache hit rates once the shared
 * module gained the history breakpoint. These probes pin the shared behavior
 * at the generate() boundary so any future re-declaration fails here instead
 * of production.
 */

import { describe, expect, it, vi } from 'vitest';

import { CACHE_CONTROL } from '@moonshot-ai/kosong/providers/anthropic-cache-breakpoints';

import type { Message, Role } from '#/kosong/contract/message';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';

interface CapturedBlock {
  type: string;
  text?: string;
  cache_control?: { type: 'ephemeral' };
}

function msg(role: Role, text: string): Message {
  return { role, content: [{ type: 'text', text }], toolCalls: [] };
}

function makeResponse(): Record<string, unknown> {
  return {
    id: 'msg_test',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: 'ok' }],
  };
}

/** Run generate() against a mocked SDK client and return the wire messages
 *  plus the parts surfaced by the streamed-message adapter. */
async function captureMessages(
  history: Message[],
): Promise<{ contents: CapturedBlock[][]; parts: unknown[] }> {
  const create = vi.fn().mockResolvedValue(makeResponse());
  const provider = new AnthropicChatProvider({
    model: 'claude-sonnet-4-5',
    apiKey: '',
    defaultMaxTokens: 1024,
    stream: false,
    clientFactory: () => ({ messages: { create } }) as never,
  });
  const stream = await provider.generate('', [], history);
  const parts: unknown[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  expect(create).toHaveBeenCalledTimes(1);
  const params = create.mock.calls[0]![0] as Record<string, unknown>;
  const contents = (
    params['messages'] as Array<{ role: string; content: CapturedBlock[] }>
  ).map((m) => m.content);
  return { contents, parts };
}

describe('vendored anthropic cache breakpoints', () => {
  it('injects history and tail breakpoints at >=4 messages', async () => {
    const { contents, parts } = await captureMessages([
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', 'a2'),
      msg('user', 'u3'),
    ]);

    // History breakpoint on the last block of index len-3 == 2, tail on the
    // last message's last block; everything in between stays clean.
    expect(contents[2]!.at(-1)!.cache_control).toEqual(CACHE_CONTROL);
    expect(contents[4]!.at(-1)!.cache_control).toEqual(CACHE_CONTROL);
    expect(contents[0]!.at(-1)!.cache_control).toBeUndefined();
    expect(contents[1]!.at(-1)!.cache_control).toBeUndefined();
    expect(contents[3]!.at(-1)!.cache_control).toBeUndefined();
    // The non-stream response body flows through the message adapter.
    expect(parts).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('injects only the tail breakpoint when fewer than 4 messages', async () => {
    const { contents } = await captureMessages([msg('user', 'u1'), msg('assistant', 'a1')]);

    expect(contents[1]!.at(-1)!.cache_control).toEqual(CACHE_CONTROL);
    expect(contents[0]!.at(-1)!.cache_control).toBeUndefined();
  });
});
