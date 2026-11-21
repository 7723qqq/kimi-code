import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createMessageAccumulator, createUserMessage } from '#/llm/message';
import type { LlmModel } from '@moonshot-ai/core/llm/model';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import { createOpenAIResponsesRequester } from '#/llm/requester/bases/openai-responses/requester';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmRequestEvent, LlmRequester } from '#/llm/requester/requester';

import { startMockUpstream, type MockUpstream } from '../../../../test/helpers/mockUpstream';

const FIRST_PART_BUDGET_MS = 1_000;
const BURST_BUDGET_MS = 5_000;
const BURST_PARTS = 500;
const SLOW_PARTS = 6;
const SLOW_GAP_MS = 5;

let upstream: MockUpstream;
let model: LlmModel;

beforeAll(() => {
  upstream = startMockUpstream();
  model = {
    provider: 'mock',
    model: 'mock-model',
    capability: UNKNOWN_CAPABILITY,
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-mock',
  };
});

afterAll(async () => {
  await upstream.close();
});

beforeEach(() => {
  upstream.scenario({ kind: 'text', chunks: ['ok'] });
  upstream.requests.length = 0;
  upstream.releaseStall();
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

function partsOf(events: readonly LlmRequestEvent[]): LlmRequestEvent[] {
  return events.filter((event) => event.type === 'llm.streaming.part');
}

describe('an upstream that answers immediately', () => {
  it('streams the first part within one second of a single request', async () => {
    const { events, elapsedMs } = await generate();
    const parts = partsOf(events);
    expect(parts).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
    expect(upstream.requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(FIRST_PART_BUDGET_MS);
  });

  it('asks for streaming and carries the tool catalog in the request body', async () => {
    await generate();
    const request = upstream.requests[0];
    expect(request?.stream).toBe(true);
    expect(request?.path).toBe('/v1/chat/completions');
    expect(request?.model).toBe('mock-model');
    expect(request?.headers['content-type']).toContain('application/json');
  }, 10_000);

  it('delivers every part of a burst without dropping or duplicating one', async () => {
    upstream.scenario({
      kind: 'text',
      chunks: Array.from({ length: BURST_PARTS }, (_, index) => `p${index}`),
    });
    const { events, elapsedMs } = await generate();
    expect(partsOf(events)).toHaveLength(BURST_PARTS);
    expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
    expect(upstream.requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(BURST_BUDGET_MS);
  });

  it('receives parts as they arrive instead of after the stream closes', async () => {
    upstream.scenario({
      kind: 'text',
      chunks: Array.from({ length: SLOW_PARTS }, () => 'x'),
      gapMs: SLOW_GAP_MS,
    });
    const arrivals: number[] = [];
    const startedAt = performance.now();
    await createOpenAIRequester().generate(
      { model },
      { messages: [createUserMessage('hi')] },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') arrivals.push(performance.now() - startedAt);
        },
      },
    );
    expect(arrivals).toHaveLength(SLOW_PARTS);
    const first = arrivals[0] ?? Number.POSITIVE_INFINITY;
    const last = arrivals.at(-1) ?? 0;
    expect(first).toBeLessThan(SLOW_GAP_MS * 4);
    expect(last - first).toBeGreaterThanOrEqual(SLOW_GAP_MS * (SLOW_PARTS - 2));
  });

  it('parses a tool-call stream into a tool call named by the upstream', async () => {
    upstream.scenario({ kind: 'toolCall', name: 'Read', args: '{"path":"a.ts"}' });
    const { events } = await generate();
    const toolParts = partsOf(events).filter(
      (event) => event.type === 'llm.streaming.part' && event.part.type === 'tool_call_part',
    );
    expect(toolParts.length).toBeGreaterThan(0);
    const finish = events.find((event) => event.type === 'llm.streaming.finish');
    expect(finish).toMatchObject({
      type: 'llm.streaming.finish',
      finish: { finishReason: 'tool_calls' },
    });
    expect(upstream.requests).toHaveLength(1);
  });

  it('surfaces a 500 as one failed request instead of retrying inside the requester', async () => {
    upstream.scenario({ kind: 'status', status: 500 });
    const { events, elapsedMs } = await generate();
    expect(events.filter((event) => event.type === 'llm.failed.remote')).toHaveLength(1);
    expect(events.some((event) => event.type === 'llm.done')).toBe(false);
    expect(upstream.requests).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(FIRST_PART_BUDGET_MS);
  });

  it('reports a truncated stream as a failure rather than a finished answer', async () => {
    upstream.scenario({ kind: 'truncate', chunks: ['half an ans'] });
    const { events } = await generate();
    expect(partsOf(events)).toHaveLength(1);
    expect(events.filter((event) => event.type === 'llm.failed.remote')).toHaveLength(1);
    expect(events.some((event) => event.type === 'llm.streaming.finish')).toBe(false);
    expect(upstream.requests).toHaveLength(1);
  });
});

const PROTOCOLS: readonly {
  readonly name: string;
  readonly pathSuffix: string;
  readonly create: () => LlmRequester;
}[] = [
  { name: 'openai', pathSuffix: '/chat/completions', create: () => createOpenAIRequester() },
  { name: 'openai-responses', pathSuffix: '/responses', create: () => createOpenAIResponsesRequester() },
  { name: 'anthropic', pathSuffix: '/messages', create: () => createAnthropicRequester() },
  { name: 'google-genai', pathSuffix: ':streamGenerateContent', create: () => createGoogleGenAIRequester() },
];

interface ProtocolCase {
  readonly name: string;
  readonly pathSuffix: string;
  readonly create: () => LlmRequester;
}

function describeProtocol(protocol: ProtocolCase): void {
  describe(`${protocol.name} upstream`, () => {
    async function generateProtocol(): Promise<LlmRequestEvent[]> {
      upstream.requests.length = 0;
      const events: LlmRequestEvent[] = [];
      await protocol
        .create()
        .generate(
          { model: { ...model, provider: protocol.name } },
          { messages: [createUserMessage('hi')] },
          { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
        );
      return events;
    }

    it('receives streamed text in order from one request', async () => {
      upstream.scenario({ kind: 'text', chunks: ['Hel', 'lo'] });
      const events = await generateProtocol();
      const text = partsOf(events)
        .map((event) =>
          event.type === 'llm.streaming.part' && event.part.type === 'text' ? event.part.text : '',
        )
        .join('');
      expect(text).toBe('Hello');
      const sentAt = events.findIndex((event) => event.type === 'llm.sent');
      const firstPartAt = events.findIndex((event) => event.type === 'llm.streaming.part');
      expect(sentAt).toBe(0);
      expect(firstPartAt).toBeGreaterThan(sentAt);
      expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.path.endsWith(protocol.pathSuffix)).toBe(true);
    });

    it.each(['think', 'thinking'])(
      'separates split %s tags from streamed answer text',
      async (tag) => {
        upstream.scenario({
          kind: 'text',
          chunks: [
            '<',
            tag.slice(0, 3),
            `${tag.slice(3)}>`,
            'Verifying focused source behavior',
            'Checking patch only',
            '</',
            tag,
            '>',
            'Answer',
          ],
        });
        const events = await generateProtocol();
        const accumulator = createMessageAccumulator();
        for (const event of events) {
          if (event.type === 'llm.streaming.part') accumulator.push(event.part);
        }
        expect(accumulator.finish().content).toEqual([
          { type: 'think', think: 'Verifying focused source behaviorChecking patch only' },
          { type: 'text', text: 'Answer' },
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
      },
    );

    it('flushes an unfinished tag prefix before the request completes', async () => {
      upstream.scenario({ kind: 'text', chunks: ['Answer <thi'] });
      const events = await generateProtocol();
      const text = partsOf(events)
        .map((event) =>
          event.type === 'llm.streaming.part' && event.part.type === 'text' ? event.part.text : '',
        )
        .join('');
      expect(text).toBe('Answer <thi');
    });

    it('turns a streamed tool call into a Read call', async () => {
      upstream.scenario({ kind: 'toolCall', name: 'Read', args: '{"path":"a.ts"}' });
      const events = await generateProtocol();
      const calls = partsOf(events).filter(
        (event) => event.type === 'llm.streaming.part' && event.part.type === 'function',
      );
      expect(calls.length).toBeGreaterThan(0);
      const call = calls[0];
      if (call?.type !== 'llm.streaming.part' || call.part.type !== 'function') {
        throw new Error('expected a function part');
      }
      expect(call.part.name).toBe('Read');
      expect(events.some((event) => event.type === 'llm.streaming.finish')).toBe(true);
      expect(upstream.requests).toHaveLength(1);
    });

    it('reports a 500 as a single failure', async () => {
      upstream.scenario({ kind: 'status', status: 500 });
      const events = await generateProtocol();
      expect(events.filter((event) => event.type === 'llm.failed.remote')).toHaveLength(1);
      expect(events.some((event) => event.type === 'llm.done')).toBe(false);
      expect(upstream.requests).toHaveLength(1);
    });
  });
}

for (const protocol of PROTOCOLS) describeProtocol(protocol);
