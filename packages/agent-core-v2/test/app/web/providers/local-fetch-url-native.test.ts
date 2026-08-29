import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { HttpFetchError } from '#/app/web/tools/fetch-url-types';

const mocks = vi.hoisted(() => ({
  tryNativeFetchUrl: vi.fn(),
  isNativeToolsLoaded: vi.fn(),
  isProxyConfigured: vi.fn(() => false),
}));

vi.mock('#/_base/native-tools', () => mocks);
vi.mock('#/_base/utils/proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/_base/utils/proxy")>();
  return { ...actual, isProxyConfigured: mocks.isProxyConfigured };
});
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

function provider(): LocalFetchURLProvider {
  return new LocalFetchURLProvider({});
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('LocalFetchURLProvider native fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryNativeFetchUrl.mockReset();
    mocks.isNativeToolsLoaded.mockReset().mockReturnValue(true);
    mocks.isProxyConfigured.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the native result when the fetch succeeds', async () => {
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: 'native body',
      kind: 'extracted',
      status: 200,
    });

    const result = await provider().fetch('https://example.com/');

    expect(result).toEqual({ content: 'native body', kind: 'extracted' });
    expect(mocks.tryNativeFetchUrl).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('skips the native path entirely when the native module is unavailable', async () => {
    mocks.isNativeToolsLoaded.mockReturnValue(false);
    // If the native path were attempted, the fetchImpl would be bypassed.
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('ts body')));

    const result = await new LocalFetchURLProvider({ fetchImpl }).fetch('https://example.com/');

    expect(mocks.tryNativeFetchUrl).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.content).toBe('ts body');
  });

  it('skips the native path when a proxy is configured', async () => {
    mocks.isProxyConfigured.mockReturnValue(true);
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: 'native',
      kind: 'extracted',
      status: 200,
    });
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('ts body')));

    const result = await new LocalFetchURLProvider({ fetchImpl }).fetch('https://example.com/');

    expect(mocks.tryNativeFetchUrl).not.toHaveBeenCalled();
    expect(result.content).toBe('ts body');
  });

  it('falls back to the TS path when the native call errors', async () => {
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: '',
      kind: 'passthrough',
      status: 0,
      error: 'native fetch failed',
    });
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('ts body')));

    const result = await new LocalFetchURLProvider({ fetchImpl }).fetch('https://example.com/');

    expect(result.content).toBe('ts body');
  });

  it('throws HttpFetchError for native HTTP error statuses', async () => {
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: 'not found',
      kind: 'passthrough',
      status: 404,
    });

    await expect(provider().fetch('https://example.com/nope')).rejects.toBeInstanceOf(
      HttpFetchError,
    );
  });

  it('falls back to the TS path when the native wrapper is unavailable', async () => {
    // Module gate passes, but the wrapper missing its native export is
    // indistinguishable from "no module" from the caller's perspective.
    mocks.tryNativeFetchUrl.mockResolvedValue(undefined);
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('ts body')));

    const result = await new LocalFetchURLProvider({ fetchImpl }).fetch('https://example.com/');

    expect(result.content).toBe('ts body');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('falls back to the TS path when the native extraction returns nothing', async () => {
    // Rust succeeds but extracts an empty page (e.g. a JS-rendered doc);
    // the TS path then runs its own extraction so errors stay canonical.
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: '',
      kind: 'extracted',
      status: 200,
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response('<html><head><title>Page</title></head><body><p>ts body</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const result = await new LocalFetchURLProvider({ fetchImpl }).fetch('https://example.com/');

    expect(result.content).toContain('ts body');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('passes allowPrivate through to the native call when enabled', async () => {
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: 'native body',
      kind: 'passthrough',
      status: 200,
    });

    await new LocalFetchURLProvider({ allowPrivateAddresses: true }).fetch(
      'http://127.0.0.1/secret',
    );

    expect(mocks.tryNativeFetchUrl).toHaveBeenCalledWith(
      'http://127.0.0.1/secret',
      expect.objectContaining({ allowPrivate: true }),
    );
  });

  it('does not pass allowPrivate through to the native call when disabled', async () => {
    mocks.tryNativeFetchUrl.mockResolvedValue({
      content: 'native body',
      kind: 'passthrough',
      status: 200,
    });

    await new LocalFetchURLProvider({}).fetch('https://example.com/');

    expect(mocks.tryNativeFetchUrl).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ allowPrivate: false }),
    );
  });
});
