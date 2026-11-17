import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmRequestEvent } from '#/llm/requester/requester';

const FIRST_PART_BUDGET_MS = 1_000;
const BURST_BUDGET_MS = 5_000;
const BURST_PARTS = 500;

function chunk(index: number, text: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fast',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fast-model',
    choices: [
      {
        index: 0,
        delta: index === 0 ? { role: 'assistant', content: text } : { content: text },
        finish_reason: null,
      },
    ],
  })}\n\n`;
}

function sseBody(parts: number): string {
  const lines: string[] = [];
  for (let index = 0; index < parts; index += 1) lines.push(chunk(index, 'x'));
  lines.push(
    `data: ${JSON.stringify({
      id: 'chatcmpl-fast',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fast-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: parts, total_tokens: 5 + parts },
    })}\n\n`,
  );
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

let server: ReturnType<typeof Bun.serve> | undefined;
let model: LlmModel;
let requests: string[] = [];
let partsPerResponse = 1;
let failureStatus: number | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      requests.push(new URL(request.url).pathname);
      if (failureStatus !== undefined) {
        return new Response('upstream failed', { status: failureStatus });
      }
      return new Response(sseBody(partsPerResponse), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    },
  });
  model = {
    provider: 'fast',
    model: 'fast-model',
    capability: UNKNOWN_CAPABILITY,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKey: 'sk-fast',
  };
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  requests = [];
  partsPerResponse = 1;
  failureStatus = undefined;
});

async function generate(): Promise<{ events: LlmRequestEvent[]; elapsedMs: number }> {
  const events: LlmRequestEvent[] = [];
  const startedAt = performance.now();
  await createOpenAIRequester().generate(
    { model },
    { messages: [createUserMessage('hi')] },
    { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
  );
  return { events, elapsedMs: performance.now() - startedAt };
}

describe('an upstream that answers immediately', () => {
  it('streams the first part within one second of a single request', async () => {
    const { events, elapsedMs } = await generate();
    const parts = events.filter((event) => event.type === 'llm.streaming.part');
    expect(parts).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
    expect(requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(FIRST_PART_BUDGET_MS);
  });

  it('delivers every part of a burst without dropping or duplicating one', async () => {
    partsPerResponse = BURST_PARTS;
    const { events, elapsedMs } = await generate();
    const parts = events.filter((event) => event.type === 'llm.streaming.part');
    expect(parts).toHaveLength(BURST_PARTS);
    expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
    expect(requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(BURST_BUDGET_MS);
  });

  it('surfaces a 500 as one failed request instead of retrying inside the requester', async () => {
    failureStatus = 500;
    const { events, elapsedMs } = await generate();
    expect(events.filter((event) => event.type === 'llm.failed.remote')).toHaveLength(1);
    expect(events.some((event) => event.type === 'llm.done')).toBe(false);
    expect(requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(FIRST_PART_BUDGET_MS);
  });
});
