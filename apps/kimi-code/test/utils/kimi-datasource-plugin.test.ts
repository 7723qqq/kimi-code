import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { resolveKimiCodeOAuthKey } from '@moonshot-ai/kimi-code-oauth';
import { describe, expect, it } from 'bun:test';

import { createHost, start } from '../../../../plugins/official/kimi-datasource/bin/kimi-datasource.mjs';

const RESPONSE_TIMEOUT_MS = 5_000;
const EXPIRES_AT = 4_102_444_800;

describe('kimi-datasource MCP server', () => {
  it('exposes the same two generic tools as the Python plugin', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const session = createSession({ env: { KIMI_CODE_HOME: kimiHome }, fetch: unreachableFetch });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'test-token');

      const initialized = await session.request('initialize', {});
      expect(initialized.error).toBeUndefined();
      expect(initialized.result).toEqual({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kimi-datasource', version: '3.4.0' },
      });

      const result = await session.request('tools/list', {});

      expect(result.error).toBeUndefined();
      const tools = (result.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((tool) => tool.name)).toEqual(['call_data_source_tool', 'get_data_source_desc']);
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers assistant text and writes response files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const textFile = join(tempDir, 'world-bank.csv');
    const binaryFile = join(tempDir, 'world-bank_payload.csv');
    const blockedFile = join(tempDir, 'blocked.csv');
    const requests: DatasourceRequest[] = [];

    const session = createSession({
      env: {
        KIMI_CODE_HOME: kimiHome,
        KIMI_DATASOURCE_API_URL: 'https://datasource.test',
      },
      fetch: (url, init) => {
        requests.push(recordRequest(url, init));
        return Promise.resolve(
          jsonResponse({
            is_success: true,
            result: {
              assistant: [{ type: 'text', text: 'assistant complete result' }],
              user: [{ type: 'text', text: '{"data_preview": null}' }],
            },
            files: [
              { name: textFile, content: 'country,value\nCN,1\n' },
              {
                name: binaryFile,
                content: Buffer.from('binary payload').toString('base64'),
                encoding: 'base64',
              },
              { name: blockedFile, content: 'blocked\n' },
            ],
          }),
        );
      },
    });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'test-token');

      await session.request('initialize', {});
      const result = await session.request('tools/call', {
        name: 'call_data_source_tool',
        arguments: {
          data_source_name: 'world_bank_open_data',
          api_name: 'world_bank_open_data',
          params: { filepath: textFile },
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('assistant complete result'),
          },
        ],
      });
      expect(JSON.stringify(result.result)).toContain('skipped returned file');
      expect(await readFile(textFile, 'utf8')).toBe('country,value\nCN,1\n');
      expect(await readFile(binaryFile, 'utf8')).toBe('binary payload');
      await expect(readFile(blockedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(requests).toEqual([
        {
          authorization: 'Bearer test-token',
          method: 'call_data_source_tool',
          params: {
            data_source_name: 'world_bank_open_data',
            api_name: 'world_bank_open_data',
            params: { filepath: textFile },
          },
          url: '/',
        },
      ]);
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses env-scoped credentials and derives the datasource URL from KIMI_CODE_BASE_URL', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const requests: DatasourceRequest[] = [];

    const baseUrl = 'https://api.dev.example.test/coding/v1';
    const oauthHost = 'https://auth.dev.example.test';
    const scopedCredential = kimiCodeEnvCredentialName({ oauthHost, baseUrl });

    const session = createSession({
      env: {
        KIMI_CODE_HOME: kimiHome,
        KIMI_CODE_BASE_URL: baseUrl,
        KIMI_CODE_OAUTH_HOST: oauthHost,
      },
      fetch: (url, init) => {
        requests.push(recordRequest(url, init));
        return Promise.resolve(
          jsonResponse({
            is_success: true,
            result: { assistant: [{ type: 'text', text: 'assistant complete result' }] },
          }),
        );
      },
    });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'expired-prod-token', 1);
      await writeCredential(kimiHome, scopedCredential, 'scoped-token');

      await session.request('initialize', {});
      const result = await session.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: {
          name: 'arxiv',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('assistant complete result'),
          },
        ],
      });
      expect(requests).toEqual([
        {
          authorization: 'Bearer scoped-token',
          method: 'get_data_source_desc',
          params: { name: 'arxiv' },
          url: '/coding/v1/tools',
        },
      ]);
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('retries with a rotated credential when the backend rejects the previous token', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const credentialsFile = join(kimiHome, 'credentials', 'kimi-code.json');
    const authorizations: Array<string | undefined> = [];

    const session = createSession({
      env: { KIMI_CODE_HOME: kimiHome },
      fetch: async (_url, init) => {
        authorizations.push((init.headers as Record<string, string>)['Authorization']);

        if (authorizations.length === 1) {
          await writeFile(
            credentialsFile,
            JSON.stringify({ access_token: 'refreshed-token', expires_at: EXPIRES_AT }),
            'utf8',
          );
          return jsonResponse({ error: 'expired access token' }, { status: 401 });
        }

        return jsonResponse({
          is_success: true,
          result: { assistant: [{ type: 'text', text: 'assistant complete result' }] },
        });
      },
    });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'previous-token', 1);

      await session.request('initialize', {});
      const result = await session.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: { name: 'imf' },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('assistant complete result'),
          },
        ],
      });
      expect(authorizations).toEqual(['Bearer previous-token', 'Bearer refreshed-token']);
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns the complete data-source routing contract when tools are listed', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const session = createSession({ env: { KIMI_CODE_HOME: kimiHome }, fetch: unreachableFetch });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'test-token');

      await session.request('initialize', {});
      const result = await session.request('tools/list', {});

      const tools = (
        result.result as {
          tools: Array<{
            name: string;
            description: string;
            inputSchema: {
              properties: Record<string, { description?: string; enum?: string[] }>;
            };
          }>;
        }
      ).tools;
      const call = tools.find((tool) => tool.name === 'call_data_source_tool');
      const desc = tools.find((tool) => tool.name === 'get_data_source_desc');
      expect(desc?.inputSchema.properties['name']?.enum).toEqual([
        'stock_finance_data',
        'yahoo_finance',
        'world_bank_open_data',
        'tianyancha',
        'arxiv',
        'scholar',
        'yuandian_law',
        'wind',
        'imf',
        'gildata',
        'sec_edgar',
        'sp_data',
        'china_nda',
        'china_nbs',
        'china_standards',
        'who',
        'fao',
        'unsd',
        'ecb',
        'eurostat',
        'unicef',
        'oecd',
        'fred',
        'xhcj',
        'caixin',
      ]);
      expect(call?.description).toContain(
        'For a simple lookup, use one specialized source and stop once a result covers the user',
      );
      expect(call?.description).toContain('When the user names a data source, use that source');
      expect(call?.inputSchema.properties['data_source_name']?.description).toContain(
        'When the user names a source, pass that source',
      );
      expect(desc?.description).toContain('choose exactly one specialized source');
      expect(desc?.inputSchema.properties['name']?.description).toContain(
        'yahoo_finance FX history is limited to about 2 years',
      );
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('appends a request-id / tool-call-id trace line to tool results', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const session = createSession({
      env: { KIMI_CODE_HOME: kimiHome },
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            { is_success: true, result: { assistant: [{ type: 'text', text: 'ok' }] } },
            { headers: { 'x-request-id': 'backend-req-test' } },
          ),
        ),
    });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'test-token');

      await session.request('initialize', {});
      const result = await session.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: { name: 'yuandian_law' },
      });

      const text = (result.result as { content: Array<{ text: string }> }).content[0]!.text;
      expect(text).toContain('[kimi-datasource] request-id: backend-req-test · tool-call-id:');
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('replies with a JSON-RPC parse error for a malformed line', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const session = createSession({ env: { KIMI_CODE_HOME: kimiHome }, fetch: unreachableFetch });

    try {
      const pending = session.waitForMessage((message) => message.id === null, 'parse error');
      session.writeLine('this is not json');

      const response = await pending;
      expect(response.error).toMatchObject({ code: -32700 });
      expect((response.error as { message: string }).message).toContain('Parse error');
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('replies with -32601 for an unknown method', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const session = createSession({ env: { KIMI_CODE_HOME: kimiHome }, fetch: unreachableFetch });

    try {
      const response = await session.request('tools/nope', {});

      expect(response.error).toMatchObject({
        code: -32601,
        message: 'Method not found: tools/nope',
      });
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exits with code 0 when stdin closes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const session = createSession({ env: { KIMI_CODE_HOME: kimiHome }, fetch: unreachableFetch });

    try {
      await session.request('initialize', {});
      expect(session.exits).toEqual([]);

      await session.closeStdin();

      expect(session.exits).toEqual([0]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('aborts a slow backend call through the injected timer', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const scheduled: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
    const cleared: unknown[] = [];
    const handle = { fake: 'timer' };

    const session = createSession({
      env: { KIMI_CODE_HOME: kimiHome },
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      setTimeout: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return handle;
      },
      clearTimeout: (clearedHandle) => {
        cleared.push(clearedHandle);
      },
    });

    try {
      await writeCredential(kimiHome, 'kimi-code', 'test-token');
      await session.request('initialize', {});

      const pending = session.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: { name: 'imf' },
      });
      await waitForCondition(() => scheduled.length > 0, 'the request timeout to be scheduled');

      expect(scheduled.map((timer) => timer.delayMs)).toEqual([30_000]);
      scheduled[0]!.callback();

      const result = await pending;
      const text = (result.result as { content: Array<{ text: string }> }).content[0]!.text;
      expect(text).toContain('Request timed out after 30 seconds.');
      expect(cleared).toEqual([handle]);
    } finally {
      await session.closeStdin();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Pin the expected credential file name to the canonical OAuth-key resolver so
// this test fails if the plugin's standalone digest drifts from the source of
// truth in @moonshot-ai/kimi-code-oauth. The credential file name is the OAuth
// key with its `oauth/` prefix stripped.
function kimiCodeEnvCredentialName(options: {
  readonly oauthHost: string;
  readonly baseUrl: string;
}): string {
  return resolveKimiCodeOAuthKey(options).replace(/^oauth\//, '');
}

async function writeCredential(
  kimiHome: string,
  name: string,
  token: string,
  expiresAt = EXPIRES_AT,
): Promise<void> {
  await mkdir(join(kimiHome, 'credentials'), { recursive: true });
  await writeFile(
    join(kimiHome, 'credentials', `${name}.json`),
    JSON.stringify({ access_token: token, expires_at: expiresAt }),
    'utf8',
  );
}

function jsonResponse(
  payload: unknown,
  options: { readonly status?: number; readonly headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}

interface DatasourceRequest {
  readonly authorization: string | undefined;
  readonly method: unknown;
  readonly params: unknown;
  readonly url: string;
}

function recordRequest(url: string, init: RequestInit): DatasourceRequest {
  const rawBody = typeof init.body === 'string' ? init.body : '{}';
  const body = JSON.parse(rawBody) as { method: unknown; params: unknown };
  return {
    authorization: (init.headers as Record<string, string>)['Authorization'],
    method: body.method,
    params: body.params,
    url: new URL(url).pathname,
  };
}

const unreachableFetch: FetchStub = (url) =>
  Promise.reject(new Error(`Unexpected backend request in this test: ${url}`));

type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

interface SessionOptions {
  readonly env: Record<string, string | undefined>;
  readonly fetch: FetchStub;
  readonly uuid?: () => string;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

interface JsonRpcResponse {
  id?: number | null;
  result?: unknown;
  error?: unknown;
}

interface Session {
  readonly exits: number[];
  request(method: string, params: unknown): Promise<JsonRpcResponse>;
  writeLine(line: string): void;
  waitForMessage(
    predicate: (message: JsonRpcResponse) => boolean,
    label: string,
  ): Promise<JsonRpcResponse>;
  closeStdin(): Promise<void>;
}

interface Waiter {
  readonly predicate: (message: JsonRpcResponse) => boolean;
  readonly resolve: (message: JsonRpcResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function createSession(options: SessionOptions): Session {
  const stdin = new PassThrough();
  const exits: number[] = [];
  const queued: JsonRpcResponse[] = [];
  const waiters = new Set<Waiter>();
  const stdoutChunks: string[] = [];
  let stdoutBuffer = '';
  let nextId = 1;
  let signalExit = (): void => {};
  const exited = new Promise<void>((resolve) => {
    signalExit = resolve;
  });

  const settle = (message: JsonRpcResponse): void => {
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queued.push(message);
  };

  start(
    createHost({
      env: options.env,
      fetch: options.fetch,
      stdin,
      stdout: {
        write(chunk: string): boolean {
          stdoutChunks.push(chunk);
          stdoutBuffer += chunk;
          let index = stdoutBuffer.indexOf('\n');
          while (index >= 0) {
            const line = stdoutBuffer.slice(0, index).trim();
            stdoutBuffer = stdoutBuffer.slice(index + 1);
            if (line.length > 0) settle(JSON.parse(line) as JsonRpcResponse);
            index = stdoutBuffer.indexOf('\n');
          }
          return true;
        },
      },
      exit: (code: number) => {
        exits.push(code);
        signalExit();
      },
      uuid: options.uuid ?? (() => '00000000-0000-4000-8000-000000000000'),
      setTimeout: options.setTimeout ?? defaultSetTimeout,
      clearTimeout: options.clearTimeout ?? defaultClearTimeout,
    }),
  );

  const waitForMessage = (
    predicate: (message: JsonRpcResponse) => boolean,
    label: string,
  ): Promise<JsonRpcResponse> => {
    const index = queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0] as JsonRpcResponse);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(
            new Error(
              `Timed out waiting for ${label}. stdout: ${stdoutChunks.join('')} stderr: none`,
            ),
          );
        }, RESPONSE_TIMEOUT_MS),
      };
      waiters.add(waiter);
    });
  };

  const request = (method: string, params: unknown): Promise<JsonRpcResponse> => {
    const id = nextId;
    nextId += 1;
    const pending = waitForMessage((message) => message.id === id, `response ${id} (${method})`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return pending;
  };

  const closeStdin = async (): Promise<void> => {
    stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('The MCP server did not exit after stdin closed.'));
          }, RESPONSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    exits,
    request,
    writeLine: (line) => {
      stdin.write(line.endsWith('\n') ? line : `${line}\n`);
    },
    waitForMessage,
    closeStdin,
  };
}

function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultClearTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
