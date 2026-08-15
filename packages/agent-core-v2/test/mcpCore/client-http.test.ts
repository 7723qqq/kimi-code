import { lookup } from 'node:dns/promises';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ErrorCodes, Error2 } from '#/errors';
import {
  buildMcpHttpHeaders,
  HttpMcpClient,
  isTerminalTransportError,
} from '#/mcpCore/client-http';

import { startInProcessHttpMcpServer } from './stubs';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const lookupMock = lookup as unknown as Mock;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

async function expectConfigInvalid(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    return;
  }
  throw new Error('expected function to throw');
}

describe('buildMcpHttpHeaders', () => {
  it('returns undefined when no headers and no bearer are configured', async () => {
    await expect(
      buildMcpHttpHeaders({ transport: 'http', url: 'https://x.example.com' }, () => {}),
    ).resolves.toBeUndefined();
  });

  it('passes through configured static headers', async () => {
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', headers: { 'X-Tenant': 'kimi' } },
        () => {},
      ),
    ).resolves.toEqual({ 'X-Tenant': 'kimi' });
  });

  it('injects Authorization Bearer when env lookup yields a token', async () => {
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'TOK' },
        (name) => (name === 'TOK' ? 'secret' : undefined),
      ),
    ).resolves.toEqual({ Authorization: 'Bearer secret' });
  });

  it('throws Error2(config.invalid) when a configured bearer token env var is empty or missing', async () => {
    await expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'MISSING' },
        () => {},
      ),
    );
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'MISSING' },
        () => {},
      ),
    ).rejects.toThrow(/"MISSING" is not set or is empty/);
    await expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'EMPTY' },
        () => '',
      ),
    );
  });

  it('merges bearer over the same Authorization key from static headers', async () => {
    await expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x.example.com',
          headers: { Authorization: 'Bearer stale', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).resolves.toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });

  it('strips case-variant authorization headers before injecting the bearer', async () => {
    await expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x.example.com',
          headers: { authorization: 'Bearer stale', AUTHORIZATION: 'Bearer older', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).resolves.toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });

  it('refuses bearer token for loopback / private / metadata URLs (SSRF guard)', async () => {
    for (const url of [
      'http://127.0.0.1:8080/mcp',
      'http://127.1.2.3/mcp',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/mcp',
      'http://192.168.1.1/mcp',
      'http://[::1]/mcp',
      'http://0.0.0.0/mcp',
    ]) {
      await expectConfigInvalid(() =>
        buildMcpHttpHeaders({ transport: 'http', url, bearerTokenEnvVar: 'TOK' }, () => 'secret'),
      );
    }
  });

  it('allows bearer token for localhost and public URLs', async () => {
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'http://localhost:8080/mcp', bearerTokenEnvVar: 'TOK' },
        () => 'secret',
      ),
    ).resolves.toEqual({ Authorization: 'Bearer secret' });
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://example.com/mcp', bearerTokenEnvVar: 'TOK' },
        () => 'secret',
      ),
    ).resolves.toEqual({ Authorization: 'Bearer secret' });
  });

  it('resolves hostnames and refuses when any resolved address is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);
    await expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://sneaky.example.com/mcp', bearerTokenEnvVar: 'TOK' },
        () => 'secret',
      ),
    );
    expect(lookupMock).toHaveBeenCalledWith('sneaky.example.com', { all: true });
  });

  it('allows bearer token when every resolved address is public', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://example.com/mcp', bearerTokenEnvVar: 'TOK' },
        () => 'secret',
      ),
    ).resolves.toEqual({ Authorization: 'Bearer secret' });
  });

  it('fails closed when DNS resolution of the hostname fails', async () => {
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND b0rked.example'));
    await expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://b0rked.example/mcp', bearerTokenEnvVar: 'TOK' },
        () => 'secret',
      ),
    );
  });

  it('refuses IPv4-mapped IPv6 loopback literals, including the hex form', async () => {
    for (const url of ['http://[::ffff:127.0.0.1]/mcp', 'http://[::ffff:7f00:1]/mcp']) {
      await expectConfigInvalid(() =>
        buildMcpHttpHeaders({ transport: 'http', url, bearerTokenEnvVar: 'TOK' }, () => 'secret'),
      );
    }
  });

  it('handles headers with empty values', async () => {
    await expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', headers: { 'X-Empty': '' } },
        () => {},
      ),
    ).resolves.toEqual({ 'X-Empty': '' });
  });

  it('handles multiple headers with mixed case keys', async () => {
    await expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x.example.com',
          headers: { 'x-custom': 'v1', 'X-Custom-Trace': 'trace-123' },
        },
        () => {},
      ),
    ).resolves.toEqual({ 'x-custom': 'v1', 'X-Custom-Trace': 'trace-123' });
  });

  it('throws config.invalid when bearerTokenEnvVar resolves to a whitespace-only string', async () => {
    await expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'SPACE' },
        () => '   ',
      ),
    );
  });

  it('flags errors the SDK uses to signal a dead HTTP transport as terminal', () => {
    const unauthorized = new Error('Unauthorized');
    unauthorized.name = 'UnauthorizedError';
    expect(isTerminalTransportError(unauthorized)).toBe(true);
    expect(isTerminalTransportError(new Error('Maximum reconnection attempts (3) exceeded.'))).toBe(
      true,
    );
  });

  it('does not flag transient SDK errors as terminal', () => {
    expect(isTerminalTransportError(new Error('SSE stream disconnected: ECONNRESET'))).toBe(false);
    expect(isTerminalTransportError(new Error('fetch failed'))).toBe(false);
    expect(isTerminalTransportError(new Error('Connection closed'))).toBe(false);
  });

  it('returns false for null, undefined, or plain objects', () => {
    expect(isTerminalTransportError(null as unknown as Error)).toBe(false);
    expect(isTerminalTransportError(undefined as unknown as Error)).toBe(false);
    expect(isTerminalTransportError({} as unknown as Error)).toBe(false);
  });

  it('returns false for a generic Error with no terminal message', () => {
    expect(isTerminalTransportError(new Error('socket hang up'))).toBe(false);
    expect(isTerminalTransportError(new Error('ETIMEDOUT'))).toBe(false);
    expect(isTerminalTransportError(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(false);
  });
});

describe('HttpMcpClient', () => {
  it('connects, lists tools, and round-trips a call over real HTTP', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);

      const result = await client.callTool('echo', { text: 'hello http' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello http' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('flips to unexpected-close when the SDK signals a terminal transport error', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    const closes: Array<{ error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ error: reason.error?.message });
    });
    try {
      await client.connect();
      const internal = (
        client as unknown as {
          client: { onerror?: (error: Error) => void };
        }
      ).client;
      internal.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      await new Promise((r) => setTimeout(r, 25));
      expect(closes).toHaveLength(1);
      expect(closes[0]?.error).toContain('Maximum reconnection attempts');
    } finally {
      await client.close();
    }
  }, 15000);

  it('ignores transient SDK errors that the transport recovers from', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    try {
      await client.connect();
      const internal = (
        client as unknown as {
          client: { onerror?: (error: Error) => void };
        }
      ).client;
      internal.onerror?.(new Error('SSE stream disconnected: ECONNRESET'));
      internal.onerror?.(new Error('fetch failed'));
      await new Promise((r) => setTimeout(r, 25));
      expect(closes).toEqual([]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards bearer token from envLookup', async () => {
    const server = await startInProcessHttpMcpServer({ authToken: 'good-token' });
    cleanups.push(server.close);

    const client = new HttpMcpClient(
      {
        transport: 'http',
        url: server.url,
        bearerTokenEnvVar: 'EXAMPLE_TOKEN',
      },
      { envLookup: (name) => (name === 'EXAMPLE_TOKEN' ? 'good-token' : undefined) },
    );
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
    } finally {
      await client.close();
    }
  }, 15000);

  it('double close is safe (no throw)', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    await client.connect();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  }, 15000);

  it('rejects connect with an unreachable URL', async () => {
    const client = new HttpMcpClient({
      transport: 'http',
      url: 'http://127.255.255.255:1/mcp',
      startupTimeoutMs: 500,
    });
    await expect(client.connect()).rejects.toThrow();
    await client.close();
  }, 15000);
});
