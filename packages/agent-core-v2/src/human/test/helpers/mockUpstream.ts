/**
 * A raw upstream double for the `human` LLM requesters.
 *
 * The requesters speak the vendor wire (OpenAI-style `/v1/chat/completions`
 * with SSE, multipart `/v1/files`, …) over a real socket, so the double answers
 * with wire-level frames rather than going through a protocol abstraction.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockScenario =
  | {
      readonly kind: 'text';
      readonly chunks: readonly string[];
      readonly choiceUsage?: Record<string, number>;
      /** Milliseconds between chunks, so callers can observe incremental arrival. */
      readonly gapMs?: number;
    }
  | { readonly kind: 'stall' }
  | { readonly kind: 'toolCall'; readonly name: string; readonly args: string }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'incomplete'; readonly chunks: readonly string[] }
  | { readonly kind: 'truncate'; readonly chunks: readonly string[] };

export interface MockRequest {
  readonly method: string;
  readonly path: string;
  readonly model: string;
  readonly stream: boolean;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface MockUpstream {
  readonly baseUrl: string;
  readonly requests: MockRequest[];
  scenario(next: MockScenario): void;
  /** Release responses held back by the `stall` scenario (used as a reset). */
  releaseStall(): void;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

function sseWrite(response: ServerResponse, event: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** OpenAI chat-completions SSE: content deltas, then `data: [DONE]`. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function streamTextFor(
  url: string,
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'text' }>,
): Promise<void> {
  if (url.endsWith('/messages')) return streamAnthropicText(response, scenario);
  if (url.endsWith('/responses')) return streamResponsesText(response, scenario);
  if (url.includes('streamGenerateContent')) return streamGoogleText(response, scenario);
  return streamText(response, scenario);
}

/** Anthropic `/messages` SSE. */
async function streamAnthropicText(
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'text' }>,
): Promise<void> {
  const send = (event: string, data: Record<string, unknown>): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', { type: 'message_start', message: { id: 'msg_mock', role: 'assistant', content: [] } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const chunk of scenario.chunks) {
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
    if (scenario.gapMs !== undefined && scenario.gapMs > 0) await sleep(scenario.gapMs);
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: scenario.chunks.length },
  });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

/** OpenAI `/responses` SSE. */
async function streamResponsesText(
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'text' }>,
): Promise<void> {
  const send = (event: string, data: Record<string, unknown>): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('response.created', { type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } });
  for (const chunk of scenario.chunks) {
    send('response.output_text.delta', { type: 'response.output_text.delta', delta: chunk });
    if (scenario.gapMs !== undefined && scenario.gapMs > 0) await sleep(scenario.gapMs);
  }
  send('response.output_text.done', { type: 'response.output_text.done', text: scenario.chunks.join('') });
  send('response.completed', { type: 'response.completed', response: { id: 'resp_mock', status: 'completed' } });
  response.end();
}

/** Google GenAI `:streamGenerateContent` (newline-delimited JSON). */
async function streamGoogleText(
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'text' }>,
): Promise<void> {
  // The GenAI SDK streams `:streamGenerateContent` with `alt=sse`: one JSON
  // object per `data:` frame.
  const frames = scenario.chunks.map((text) => ({ candidates: [{ content: { parts: [{ text }], role: 'model' } }] }));
  for (const frame of frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (scenario.gapMs !== undefined && scenario.gapMs > 0) await sleep(scenario.gapMs);
  }
  response.end();
}


async function streamText(response: ServerResponse, scenario: Extract<MockScenario, { kind: 'text' }>): Promise<void> {
  for (const chunk of scenario.chunks) {
    sseWrite(response, {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model: 'mock',
      choices: [{ index: 0, delta: { content: chunk } }],
    });
    if (scenario.gapMs !== undefined && scenario.gapMs > 0) await sleep(scenario.gapMs);
  }
  const usage = scenario.choiceUsage;
  if (usage !== undefined) {
    sseWrite(response, {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage,
    });
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

function streamToolCallFor(
  url: string,
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'toolCall' }>,
): void {
  if (url.endsWith('/messages')) return streamAnthropicToolCall(response, scenario);
  if (url.endsWith('/responses')) return streamResponsesToolCall(response, scenario);
  if (url.includes('streamGenerateContent')) return streamGoogleToolCall(response, scenario);
  streamToolCall(response, scenario);
}

/** Google GenAI functionCall frame. */
function streamGoogleToolCall(
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'toolCall' }>,
): void {
  const args = JSON.parse(scenario.args) as Record<string, unknown>;
  const frame = {
    candidates: [
      {
        content: { parts: [{ functionCall: { name: scenario.name, args } }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
  };
  response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end();
}

/** Anthropic `/messages` tool_use block. */
function streamAnthropicToolCall(
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'toolCall' }>,
): void {
  const send = (event: string, data: Record<string, unknown>): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', { type: 'message_start', message: { id: 'msg_mock', role: 'assistant', content: [] } });
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tool_mock', name: scenario.name, input: {} },
  });
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: scenario.args },
  });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

/** OpenAI `/responses` function call. */
function streamResponsesToolCall(
  response: ServerResponse,
  scenario: Extract<MockScenario, { kind: 'toolCall' }>,
): void {
  const send = (event: string, data: Record<string, unknown>): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('response.created', { type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } });
  send('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: scenario.name, arguments: '' },
  });
  // The parser keys function-call argument frames by `item_id`.
  send('response.function_call_arguments.delta', {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_mock',
    output_index: 0,
    delta: scenario.args,
  });
  send('response.function_call_arguments.done', {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_mock',
    output_index: 0,
    arguments: scenario.args,
  });
  send('response.output_item.done', {
    type: 'response.output_item.done',
    item_id: 'fc_mock',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_mock',
      call_id: 'call_mock',
      name: scenario.name,
      arguments: scenario.args,
      status: 'completed',
    },
  });
  send('response.completed', {
    type: 'response.completed',
    response: { id: 'resp_mock', status: 'completed', output: [] },
  });
  response.end();
}

function streamToolCall(response: ServerResponse, scenario: Extract<MockScenario, { kind: 'toolCall' }>): void {
  sseWrite(response, {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    model: 'mock',
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name: scenario.name, arguments: '' } }] },
      },
    ],
  });
  sseWrite(response, {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    model: 'mock',
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: scenario.args } }] },
        finish_reason: 'tool_calls',
      },
    ],
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

export function startMockUpstream(initial: MockScenario = { kind: 'text', chunks: ['ok'] }): MockUpstream {
  let scenario: MockScenario = initial;
  const requests: MockRequest[] = [];
  const held: ServerResponse[] = [];
  let server: Server | undefined;

  server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let parsed: unknown;
      try {
        parsed = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      const record = (parsed ?? {}) as Record<string, unknown>;
      requests.push({
        method: request.method ?? 'GET',
        // Record the pathname: SDKs append queries (`?alt=sse`, `?key=…`) that
        // callers assert past when matching wire routes.
        path: (request.url ?? '/').split('?')[0] ?? '/',
        model: typeof record['model'] === 'string' ? record['model'] : '',
        stream: record['stream'] === true,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')]),
        ),
        body: parsed,
      });

      if (scenario.kind === 'stall') {
        held.push(response);
        return;
      }

      if (scenario.kind === 'status') {
        response.writeHead(scenario.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'mock status' } }));
        return;
      }

      const url = request.url ?? '';
      const isGoogle = url.includes('streamGenerateContent');
      response.writeHead(200, {
        'content-type': isGoogle ? 'application/json' : 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (scenario.kind === 'text') await streamTextFor(url, response, scenario);
      else if (scenario.kind === 'toolCall') streamToolCallFor(url, response, scenario);
      else if (scenario.kind === 'incomplete') {
        for (const chunk of scenario.chunks) {
          sseWrite(response, {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: 'mock',
            choices: [{ index: 0, delta: { content: chunk } }],
          });
        }
        // No `[DONE]`: the client has to notice the stream ended short.
        response.end();
      } else {
        for (const chunk of scenario.chunks) {
          sseWrite(response, {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: 'mock',
            choices: [{ index: 0, delta: { content: chunk } }],
          });
        }
        // Truncation: let the buffered frames reach the client, then drop the
        // connection mid-body so the reader sees a broken stream, not a clean end.
        await sleep(0);
        response.socket?.end();
        response.socket?.destroy();
      }
    })();
  });

  server.listen(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;

  return {
    // The requesters append paths like `/chat/completions`; the wire paths are
    // the `/v1/...` routes, so the base carries the version prefix.
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    scenario(next: MockScenario): void {
      scenario = next;
    },
    releaseStall(): void {
      for (const pending of held.splice(0)) {
        pending.writeHead(200, { 'content-type': 'text/event-stream' });
        pending.write('data: [DONE]\n\n');
        pending.end();
      }
    },
    close: async () => {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => {
        if (server === undefined) resolve();
        else server.close(() => resolve());
      });
      server = undefined;
    },
  };
}

export interface MockFilesRequest {
  readonly method: string;
  readonly path: string;
  readonly purpose: string;
  readonly filename: string;
  readonly partType: string;
  readonly authorization: string;
  readonly bytes: number;
}

export interface MockFilesApi {
  readonly baseUrl: string;
  readonly requests: MockFilesRequest[];
  close(): Promise<void>;
}

/**
 * Multipart `/v1/files` double: captures purpose/filename/type/auth per part and
 * answers with a `ms://file_mock`-shaped id unless a failure is configured.
 */
export function startMockFilesApi(
  options: { readonly status?: number; readonly body?: unknown } = {},
): MockFilesApi {
  const requests: MockFilesRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf-8');

      // Parse the multipart body properly: split on the boundary and read each
      // part's Content-Disposition, so field values survive any header layout.
      const fields = new Map<string, string>();
      let filename = '';
      const contentType = request.headers['content-type'] ?? '';
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
      const marker = boundary?.[1] ?? boundary?.[2];
      if (marker !== undefined) {
        for (const part of raw.toString('utf-8').split(`--${marker}`)) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headers = part.slice(0, headerEnd);
          const body = part.slice(headerEnd + 4).replace(/\r\n$/, '');
          const nameMatch = /name="([^"]*)"/.exec(headers);
          const fileMatch = /filename="([^"]*)"/.exec(headers);
          const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
          if (fileMatch?.[1] !== undefined) {
            filename = fileMatch[1];
            // The part's Content-Type carries the mime type of the upload.
            if (typeMatch?.[1] !== undefined) fields.set('type', typeMatch[1].trim());
          }
          if (nameMatch?.[1] !== undefined) fields.set(nameMatch[1], body);
        }
      }

      requests.push({
        method: request.method ?? 'GET',
        // Record the pathname: SDKs append queries that callers assert past.
        path: (request.url ?? '/').split('?')[0] ?? '/',
        purpose: fields.get('purpose') ?? '',
        filename,
        partType: fields.get('type') ?? '',
        authorization: request.headers.authorization ?? '',
        bytes: raw.byteLength,
      });

      if (options.status !== undefined) {
        response.writeHead(options.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(options.body ?? { error: { message: 'mock failure' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'file_mock' }));
    })();
  });

  server.listen(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;

  return {
    // The client appends `/files` to the base; the wire route is `/v1/files`.
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
