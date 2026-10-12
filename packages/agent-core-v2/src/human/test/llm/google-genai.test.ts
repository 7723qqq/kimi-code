import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import type { LlmRequestEvent } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'gemini-2.5-flash',
  baseUrl: 'https://example.test',
  apiKey: 'test-key',
  capability: UNKNOWN_CAPABILITY,
};

const messages = [createUserMessage('hi')];

const ABORT_EVENT = {
  type: 'llm.failed.remote',
  error: { kind: 'abort', message: 'The operation was aborted.' },
};

interface StuckStreamClient {
  readonly clientFactory: (request: { model: LlmModel }) => unknown;
  readonly captured: Record<string, unknown>[];
}

function createStuckStreamClient(): StuckStreamClient {
  const captured: Record<string, unknown>[] = [];
  return {
    captured,
    clientFactory: () => ({
      models: {
        generateContentStream: (params: Record<string, unknown>) => {
          captured.push(params);
          const config = params['config'] as { abortSignal?: AbortSignal } | undefined;
          const signal = config?.abortSignal;
          return Promise.resolve({
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise<IteratorResult<Record<string, unknown>>>((_resolve, reject) => {
                    if (signal === undefined) {
                      return;
                    }
                    const abort = (): void => {
                      reject(new DOMException('The operation was aborted.', 'AbortError'));
                    };
                    if (signal.aborted) {
                      abort();
                      return;
                    }
                    signal.addEventListener('abort', abort, { once: true });
                  }),
              };
            },
          });
        },
      },
    }),
  };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  const settled = promise.then(() => true);
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('google genai abort propagation', () => {
  it('hands the request signal to the SDK so a stuck stream is cancelled', async () => {
    const client = createStuckStreamClient();
    const requester = createGoogleGenAIRequester({
      clientFactory: client.clientFactory as never,
    });
    const controller = new AbortController();
    const events: LlmRequestEvent[] = [];
    const generate = requester.generate(
      { model },
      { messages },
      { signal: controller.signal, onEvent: (event) => events.push(event) },
    );
    await nextTick();
    controller.abort();

    expect(await settlesWithin(generate, 1000)).toBe(true);
    const config = client.captured.at(0)?.['config'] as { abortSignal?: AbortSignal } | undefined;
    expect(config?.abortSignal).toBe(controller.signal);
    expect(events).toContainEqual(ABORT_EVENT);
    expect(events.some((event) => event.type === 'llm.done')).toBe(false);
  });

  it('keeps the assembled config when attaching the abort signal', async () => {
    const client = createStuckStreamClient();
    const requester = createGoogleGenAIRequester({
      clientFactory: client.clientFactory as never,
    });
    const controller = new AbortController();
    const generate = requester.generate(
      { model, maxCompletionTokens: 256 },
      { messages },
      { signal: controller.signal },
    );
    await nextTick();

    const config = client.captured.at(0)?.['config'] as
      | { abortSignal?: AbortSignal; maxOutputTokens?: number }
      | undefined;
    expect(config?.maxOutputTokens).toBe(256);
    expect(config?.abortSignal).toBe(controller.signal);

    controller.abort();
    expect(await settlesWithin(generate, 1000)).toBe(true);
  });
});
