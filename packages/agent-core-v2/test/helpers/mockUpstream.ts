export interface MockScenarioText {
  readonly kind: 'text';
  readonly chunks: readonly string[];
  readonly gapMs?: number;
}

export interface MockScenarioToolCall {
  readonly kind: 'toolCall';
  readonly name: string;
  readonly args: string;
}

export interface MockScenarioStatus {
  readonly kind: 'status';
  readonly status: number;
  readonly body?: string;
}

export interface MockScenarioStall {
  readonly kind: 'stall';
  readonly chunks?: readonly string[];
}

export interface MockScenarioTruncate {
  readonly kind: 'truncate';
  readonly chunks?: readonly string[];
}

export type MockScenario =
  | MockScenarioText
  | MockScenarioToolCall
  | MockScenarioStatus
  | MockScenarioStall
  | MockScenarioTruncate;

export interface MockUpstreamRequest {
  readonly at: number;
  readonly path: string;
  readonly bytes: number;
  readonly headers: Record<string, string>;
  readonly model: string | undefined;
  readonly stream: boolean | undefined;
  readonly tools: readonly unknown[];
  readonly messages: readonly { readonly role?: string }[];
  readonly rawBody: string;
}

export interface MockUpstream {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: MockUpstreamRequest[];
  scenario(next: MockScenario): void;
  releaseStall(): void;
  close(): Promise<void>;
}

const encoder = new TextEncoder();

const DEFAULT_SCENARIO: MockScenario = { kind: 'text', chunks: ['ok'] };

function chunkFrame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function usageFrame(promptTokens: number, completionTokens: number): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`;
}

function textFrames(chunks: readonly string[]): string[] {
  return chunks.map((text, index) =>
    chunkFrame(index === 0 ? { role: 'assistant', content: text } : { content: text }),
  );
}

function toolCallFrames(name: string, args: string): string[] {
  return [
    chunkFrame({
      role: 'assistant',
      tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name, arguments: '' } }],
    }),
    chunkFrame({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
  ];
}

export function startMockUpstream(initial: MockScenario = DEFAULT_SCENARIO): MockUpstream {
  let scenario: MockScenario = initial;
  const requests: MockUpstreamRequest[] = [];
  let releaseStall: (() => void) | undefined;
  const startedAt = performance.now();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: async (request) => {
      const rawBody = await request.text();
      let parsed: {
        model?: string;
        stream?: boolean;
        tools?: unknown[];
        messages?: { role?: string }[];
      } = {};
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        parsed = {};
      }
      requests.push({
        at: performance.now() - startedAt,
        path: new URL(request.url).pathname,
        bytes: Buffer.byteLength(rawBody, 'utf8'),
        headers: Object.fromEntries(request.headers.entries()),
        model: parsed.model,
        stream: parsed.stream,
        tools: parsed.tools ?? [],
        messages: parsed.messages ?? [],
        rawBody,
      });

      if (scenario.kind === 'status') {
        return new Response(scenario.body ?? 'mock upstream error', { status: scenario.status });
      }

      const streamHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
      if (scenario.kind === 'text' || scenario.kind === 'toolCall') {
        const frames =
          scenario.kind === 'text'
            ? [...textFrames(scenario.chunks), chunkFrame({}, 'stop')]
            : [...toolCallFrames(scenario.name, scenario.args), chunkFrame({}, 'tool_calls')];
        const body = `${frames.join('')}${usageFrame(5, frames.length)}data: [DONE]\n\n`;
        const gapMs = scenario.kind === 'text' ? (scenario.gapMs ?? 0) : 0;
        if (gapMs <= 0) {
          return new Response(body, { headers: streamHeaders });
        }
        const framesWithGap = body.split('\n\n').filter((part) => part.length > 0);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const frame of framesWithGap) {
              controller.enqueue(encoder.encode(`${frame}\n\n`));
              await Bun.sleep(gapMs);
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: streamHeaders });
      }

      const seed = scenario.chunks ?? [];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const text of seed) {
            controller.enqueue(encoder.encode(textFrames([text])[0] ?? ''));
          }
          if (scenario.kind === 'truncate') {
            setTimeout(() => {
              try {
                controller.error(new Error('mock upstream reset the connection'));
              } catch {}
            }, 10);
            return;
          }
          await new Promise<void>((resolve) => {
            releaseStall = resolve;
          });
          controller.close();
        },
      });
      return new Response(stream, { headers: streamHeaders });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error('mock upstream failed to bind a port');

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    scenario(next) {
      scenario = next;
    },
    releaseStall() {
      releaseStall?.();
      releaseStall = undefined;
    },
    async close() {
      releaseStall?.();
      releaseStall = undefined;
      await server.stop(true);
    },
  };
}
