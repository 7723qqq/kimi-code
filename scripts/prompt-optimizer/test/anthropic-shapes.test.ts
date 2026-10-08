import { afterEach, describe, expect, test } from 'bun:test';

import { resolveCredentials } from '../src/llm-caller';

/**
 * The Anthropic path is exercised through a stubbed `fetch`, so the response
 * shapes that broke real runs are covered without a network call.
 *
 * Both shapes were observed from a live provider (MiniMax M3.1): HTTP 200 with
 * `content: null`, and a non-empty block list carrying no text — in each case
 * with a non-zero output token count, so the text was generated and dropped.
 * Treating either as an empty answer would score a provider fault as bad model
 * behaviour.
 */
const savedFetch = globalThis.fetch;
const savedKey = process.env['KIMI_API_KEY'];

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env['KIMI_API_KEY'];
  else process.env['KIMI_API_KEY'] = savedKey;
});

function stubFetch(body: unknown, init?: { status?: number; contentType?: string }): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'content-type': init?.contentType ?? 'application/json' },
    })) as unknown as typeof fetch;
}

async function callAnthropic(response: unknown) {
  process.env['KIMI_API_KEY'] = 'test-key';
  stubFetch(response);
  const { realCaller } = await import('../src/llm-caller');
  return realCaller('system', ['user'], {
    model: 'MiniMax Token Plan/MiniMax-M3.1-Flash-Preview',
    apiBaseUrl: 'https://example.invalid/anthropic',
    apiKey: '',
    concurrency: 1,
  });
}

async function callAnthropicWith(response: unknown): Promise<string> {
  return (await callAnthropic(response)).content;
}

async function callAnthropicToolCalls(response: unknown) {
  return callAnthropic(response);
}

const USAGE = { input_tokens: 100, output_tokens: 27 };

describe('a provider that drops the response body', () => {
  test('content: null is reported, not scored as an empty answer', async () => {
    await expect(
      callAnthropicWith({
        content: null,
        usage: USAGE,
        stop_reason: 'end_turn',
      }),
    ).rejects.toThrow(/no usable content/);
  });

  test('the message distinguishes a provider fault from an empty answer', async () => {
    await expect(
      callAnthropicWith({ content: null, usage: USAGE, stop_reason: 'end_turn' }),
    ).rejects.toThrow(/provider-side fault, not an empty model answer/);
  });

  test('the message carries the diagnostics needed to tell them apart', async () => {
    const attempt = callAnthropicWith({ content: null, usage: USAGE, stop_reason: 'end_turn' });
    await expect(attempt).rejects.toThrow(/content is null/);
    await expect(
      callAnthropicWith({ content: null, usage: USAGE, stop_reason: 'end_turn' }),
    ).rejects.toThrow(/output_tokens=27/);
  });

  test('blocks with no text, no tool call, but billed tokens are reported', async () => {
    await expect(
      callAnthropicWith({ content: [], usage: USAGE, stop_reason: 'end_turn' }),
    ).rejects.toThrow(/no text and no tool call though 27 output tokens were billed/);
  });

  // The defect a live run exposed: the non-streaming path dropped tool_use
  // blocks, so every `tool-called` assertion judged an always-empty list.
  test('a tool_use block is reported as a tool call', async () => {
    const result = await callAnthropicToolCalls({
      content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }],
      usage: USAGE,
      stop_reason: 'tool_use',
    });
    expect(result.toolCalls).toEqual([{ name: 'Read', input: '{"path":"a.ts"}' }]);
  });

  test('text and a tool call in one response are both kept', async () => {
    const result = await callAnthropicToolCalls({
      content: [
        { type: 'text', text: "I'll read it." },
        { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } },
      ],
      usage: USAGE,
      stop_reason: 'tool_use',
    });
    expect(result.content).toBe("I'll read it.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('Read');
  });

  test('a tool-only response is not treated as a dropped body', async () => {
    const result = await callAnthropicToolCalls({
      content: [{ type: 'tool_use', name: 'Grep', input: {} }],
      usage: USAGE,
      stop_reason: 'tool_use',
    });
    expect(result.content).toBe('');
    expect(result.toolCalls).toHaveLength(1);
  });

  test('a genuinely empty answer with no billed tokens is allowed through', async () => {
    // Not a fault: nothing was generated, so there is nothing to lose.
    await expect(
      callAnthropicWith({ content: [], usage: { input_tokens: 100, output_tokens: 0 } }),
    ).resolves.toBe('');
  });

  test('a normal response still parses', async () => {
    await expect(
      callAnthropicWith({
        content: [{ type: 'text', text: 'Hello!' }],
        usage: USAGE,
        stop_reason: 'end_turn',
      }),
    ).resolves.toBe('Hello!');
  });

  test('non-text blocks are skipped without error', async () => {
    await expect(
      callAnthropicWith({
        content: [
          { type: 'thinking', text: 'ignored' },
          { type: 'text', text: 'Kept.' },
        ],
        usage: USAGE,
      }),
    ).resolves.toBe('Kept.');
  });

  test('a provider error message is surfaced when present', async () => {
    await expect(
      callAnthropicWith({
        content: null,
        usage: USAGE,
        base_resp: { status_code: 0, status_msg: 'rate limited' },
      }),
    ).rejects.toThrow(/provider said "rate limited"/);
  });
});

describe('the resolved credential shape', () => {
  test('a MiniMax-style model resolves to its own provider', () => {
    // Guards the pairing fix: model and base URL must come from one block.
    const resolved = resolveCredentials({
      model: 'MiniMax Token Plan/MiniMax-M3.1-Flash-Preview',
      apiBaseUrl: '',
      apiKey: '',
      concurrency: 1,
    });
    expect(resolved.model).toBe('MiniMax Token Plan/MiniMax-M3.1-Flash-Preview');
    expect(resolved.type).toBe('anthropic');
  });
});
