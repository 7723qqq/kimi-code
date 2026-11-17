export type MockProtocol = 'openai' | 'openai-responses' | 'anthropic' | 'google-genai';

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
  readonly protocol: MockProtocol;
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

function detectProtocol(path: string): MockProtocol {
  if (path.includes(':streamGenerateContent')) return 'google-genai';
  if (path.endsWith('/messages')) return 'anthropic';
  if (path.endsWith('/responses')) return 'openai-responses';
  return 'openai';
}

function sse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`;
}

function openAIText(chunks: readonly string[]): string {
  const frames = chunks.map(
    (text, index) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
        choices: [
          {
            index: 0,
            delta: index === 0 ? { role: 'assistant', content: text } : { content: text },
            finish_reason: null,
          },
        ],
      })}\n\n`,
  );
  frames.push(
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: chunks.length,
        total_tokens: 5 + chunks.length,
      },
    })}\n\n`,
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

function openAIResponsesText(chunks: readonly string[]): string {
  const frames = chunks.map((delta) =>
    sse('response.output_text.delta', {
      item_id: 'msg_mock',
      output_index: 0,
      content_index: 0,
      delta,
    }),
  );
  frames.push(
    sse('response.completed', {
      response: {
        id: 'resp_mock',
        status: 'completed',
        usage: {
          input_tokens: 5,
          output_tokens: chunks.length,
          total_tokens: 5 + chunks.length,
        },
      },
    }),
  );
  return frames.join('');
}

function anthropicText(chunks: readonly string[]): string {
  const frames = [
    sse('message_start', {
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'mock-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (const text of chunks) {
    frames.push(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }));
  }
  frames.push(
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: chunks.length },
    }),
    sse('message_stop', {}),
  );
  return frames.join('');
}

function googleText(chunks: readonly string[]): string {
  const frames = chunks.map(
    (text) =>
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text }], role: 'model' }, index: 0 }],
        modelVersion: 'mock-model',
      })}\n\n`,
  );
  frames.push(
    `data: ${JSON.stringify({
      candidates: [{ finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: chunks.length,
        totalTokenCount: 5 + chunks.length,
      },
    })}\n\n`,
  );
  return frames.join('');
}

function openAIToolCall(name: string, args: string): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'call_mock', type: 'function', function: { name, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function openAIResponsesToolCall(name: string, args: string): string {
  return [
    sse('response.output_item.added', {
      item_id: 'fc_mock',
      output_index: 0,
      item: { id: 'fc_mock', type: 'function_call', call_id: 'call_mock', name, arguments: '' },
    }),
    sse('response.function_call_arguments.delta', {
      item_id: 'fc_mock',
      output_index: 0,
      delta: args,
    }),
    sse('response.output_item.done', {
      item_id: 'fc_mock',
      output_index: 0,
      item: { id: 'fc_mock', type: 'function_call', call_id: 'call_mock', name, arguments: args },
    }),
    sse('response.completed', {
      response: {
        id: 'resp_mock',
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    }),
  ].join('');
}

function anthropicToolCall(name: string, args: string): string {
  return [
    sse('message_start', {
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'mock-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    sse('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_mock', name, input: {} },
    }),
    sse('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: args },
    }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', {
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sse('message_stop', {}),
  ].join('');
}

function googleToolCall(name: string, args: string): string {
  return `data: ${JSON.stringify({
    candidates: [
      {
        content: { parts: [{ functionCall: { name, args: JSON.parse(args) } }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  })}\n\n`;
}

function renderScenario(scenario: MockScenario, protocol: MockProtocol): string {
  if (scenario.kind === 'text') {
    switch (protocol) {
      case 'openai':
        return openAIText(scenario.chunks);
      case 'openai-responses':
        return openAIResponsesText(scenario.chunks);
      case 'anthropic':
        return anthropicText(scenario.chunks);
      case 'google-genai':
        return googleText(scenario.chunks);
    }
  }
  if (scenario.kind === 'toolCall') {
    switch (protocol) {
      case 'openai':
        return openAIToolCall(scenario.name, scenario.args);
      case 'openai-responses':
        return openAIResponsesToolCall(scenario.name, scenario.args);
      case 'anthropic':
        return anthropicToolCall(scenario.name, scenario.args);
      case 'google-genai':
        return googleToolCall(scenario.name, scenario.args);
    }
  }
  return '';
}

function streamFrames(body: string, gapMs: number): ReadableStream<Uint8Array> {
  const frames = body.split('\n\n').filter((frame) => frame.trim().length > 0);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`${frame}\n\n`));
        if (gapMs > 0) await Bun.sleep(gapMs);
      }
      controller.close();
    },
  });
}

export function startMockUpstream(initial: MockScenario = DEFAULT_SCENARIO): MockUpstream {
  let scenario: MockScenario = initial;
  const requests: MockUpstreamRequest[] = [];
  let releaseStall: (() => void) | undefined;
  const startedAt = performance.now();
  const streamHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: async (request) => {
      const rawBody = await request.text();
      const path = new URL(request.url).pathname;
      const protocol = detectProtocol(path);
      let parsed: {
        model?: string;
        stream?: boolean;
        tools?: unknown[];
        messages?: { role?: string }[];
        contents?: { role?: string }[];
        input?: { role?: string }[];
      } = {};
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        parsed = {};
      }
      requests.push({
        at: performance.now() - startedAt,
        path,
        protocol,
        bytes: Buffer.byteLength(rawBody, 'utf8'),
        headers: Object.fromEntries(request.headers.entries()),
        model: parsed.model,
        stream: parsed.stream,
        tools: parsed.tools ?? [],
        messages: parsed.messages ?? parsed.input ?? parsed.contents ?? [],
        rawBody,
      });

      if (scenario.kind === 'status') {
        return new Response(scenario.body ?? 'mock upstream error', { status: scenario.status });
      }

      if (scenario.kind === 'text' || scenario.kind === 'toolCall') {
        const body = renderScenario(scenario, protocol);
        const gapMs = scenario.kind === 'text' ? (scenario.gapMs ?? 0) : 0;
        return new Response(gapMs > 0 ? streamFrames(body, gapMs) : body, {
          headers: streamHeaders,
        });
      }

      const seed = scenario.chunks ?? [];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const text of seed) {
            const frame = renderScenario({ kind: 'text', chunks: [text] }, protocol);
            controller.enqueue(encoder.encode(`${frame.split('\n\n')[0] ?? ''}\n\n`));
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

export interface MockFilesApiRequest {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly bytes: number;
  readonly purpose: string | undefined;
  readonly filename: string | undefined;
  readonly partType: string | undefined;
}

export interface MockFilesApiResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export interface MockFilesApi {
  readonly baseUrl: string;
  readonly requests: MockFilesApiRequest[];
  respond(next: MockFilesApiResponse | readonly MockFilesApiResponse[]): void;
  close(): Promise<void>;
}

const DEFAULT_FILE_RESPONSE: MockFilesApiResponse = {
  body: { id: 'file_mock', status: 'ready', extract_status: 'ready' },
};

function readMultipartField(body: string, name: string): string | undefined {
  const match = new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]+)`).exec(body);
  return match?.[1];
}

function readMultipartFilename(body: string): string | undefined {
  return /filename="([^"]+)"/.exec(body)?.[1];
}

function readMultipartPartType(body: string): string | undefined {
  const marker = 'Content-Type:';
  const start = body.indexOf(marker);
  if (start < 0) return undefined;
  const rest = body.slice(start + marker.length);
  let end = 0;
  while (end < rest.length) {
    const code = rest.codePointAt(end);
    if (code === 13 || code === 10) break;
    end += 1;
  }
  const value = rest.slice(0, end).trim();
  return value.length > 0 ? value : undefined;
}

export function startMockFilesApi(
  initial: MockFilesApiResponse | readonly MockFilesApiResponse[] = DEFAULT_FILE_RESPONSE,
): MockFilesApi {
  const queue: MockFilesApiResponse[] = Array.isArray(initial) ? [...initial] : [initial as MockFilesApiResponse];
  const requests: MockFilesApiRequest[] = [];
  const startedAt = performance.now();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: async (request) => {
      const raw = new Uint8Array(await request.arrayBuffer());
      const text = new TextDecoder().decode(raw);
      requests.push({
        at: performance.now() - startedAt,
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization') ?? undefined,
        contentType: request.headers.get('content-type') ?? undefined,
        bytes: raw.byteLength,
        purpose: readMultipartField(text, 'purpose'),
        filename: readMultipartFilename(text),
        partType: readMultipartPartType(text),
      });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json', ...next.headers },
      });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error('mock files api failed to bind a port');

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    respond(next) {
      queue.length = 0;
      if (Array.isArray(next)) queue.push(...next);
      else queue.push(next as MockFilesApiResponse);
    },
    async close() {
      await server.stop(true);
    },
  };
}
