import { describe, expect, it, mock } from 'bun:test';

import {
  fetchNativeReleaseManifest,
  nativeBinaryUrl,
  nativeManifestUrl,
  selectBunPlatformEntry,
} from '#/cli/update/native-manifest';
import { kimiCodeCdnBinariesBase } from '#/constant/app';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';

const VERSION = '0.7.0';

/** Let the promise chains behind a settled clock tick run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function advanceAsync(clock: FakeClock, byMs: number): Promise<void> {
  await settle();
  clock.advance(byMs);
  await settle();
}

function mockFetch(response: {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: string;
}): typeof fetch {
  return mock(async () => ({
    ok: response.ok,
    status: response.status,
    text: async () => response.body ?? '',
  })) as unknown as unknown as typeof fetch;
}

const MANIFEST_BODY = JSON.stringify({
  version: VERSION,
  tag: `@moonshot-ai/kimi-code@${VERSION}`,
  platforms: {
    'win32-x64': {
      filename: `kimi-code-win32-x64.zip`,
      checksum: 'a'.repeat(64),
    },
    'darwin-arm64': {
      filename: `kimi-code-darwin-arm64.zip`,
      checksum: 'b'.repeat(64),
    },
  },
});

describe('fetchNativeReleaseManifest', () => {
  it('fetches and parses the manifest for the given version', async () => {
    const f = mockFetch({ ok: true, status: 200, body: MANIFEST_BODY });
    const manifest = await fetchNativeReleaseManifest(VERSION, f);
    expect(manifest.version).toBe(VERSION);
    expect(Object.keys(manifest.platforms ?? {})).toEqual(['win32-x64', 'darwin-arm64']);
    expect(f).toHaveBeenCalledWith(
      nativeManifestUrl(VERSION),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ignores unknown fields (lenient parsing)', async () => {
    const body = JSON.stringify({
      version: VERSION,
      platforms: {},
      futureField: { nested: true },
    });
    const manifest = await fetchNativeReleaseManifest(
      VERSION,
      mockFetch({ ok: true, status: 200, body }),
    );
    expect(manifest.version).toBe(VERSION);
  });

  it('parses a platform entry carrying a compressed artifact pointer', async () => {
    const body = JSON.stringify({
      version: VERSION,
      platforms: {
        'linux-x64': {
          filename: 'kimi-code-linux-x64',
          checksum: 'a'.repeat(64),
          compressed: { filename: 'kimi-code-linux-x64.zst', checksum: 'b'.repeat(64) },
        },
      },
    });
    const manifest = await fetchNativeReleaseManifest(
      VERSION,
      mockFetch({ ok: true, status: 200, body }),
    );
    expect(manifest.platforms?.['linux-x64']?.compressed).toEqual({
      filename: 'kimi-code-linux-x64.zst',
      checksum: 'b'.repeat(64),
    });
  });

  it('parses a platform entry carrying a zstd artifact pointer', async () => {
    const body = JSON.stringify({
      version: VERSION,
      platforms: {
        'linux-x64': {
          filename: 'kimi-code-linux-x64',
          checksum: 'a'.repeat(64),
          zstd: { file: 'kimi-code-linux-x64.zst', sha256: 'b'.repeat(64) },
        },
      },
    });
    const manifest = await fetchNativeReleaseManifest(
      VERSION,
      mockFetch({ ok: true, status: 200, body }),
    );
    expect(manifest.platforms?.['linux-x64']).toEqual({
      filename: 'kimi-code-linux-x64',
      checksum: 'a'.repeat(64),
      zstd: { file: 'kimi-code-linux-x64.zst', sha256: 'b'.repeat(64) },
    });
  });

  it.each([
    { file: '', sha256: 'b'.repeat(64) },
    { file: 'kimi-code-linux-x64.zst', sha256: 'invalid' },
  ])('rejects an invalid zstd artifact pointer: %j', async (zstd) => {
    const body = JSON.stringify({
      version: VERSION,
      platforms: {
        'linux-x64': { filename: 'kimi-code-linux-x64', checksum: 'a'.repeat(64), zstd },
      },
    });
    await expect(
      fetchNativeReleaseManifest(VERSION, mockFetch({ ok: true, status: 200, body })),
    ).rejects.toThrow();
  });

  it('rejects a non-semver version argument before hitting the network', async () => {
    const f = mockFetch({ ok: true, status: 200, body: MANIFEST_BODY });
    await expect(fetchNativeReleaseManifest('nope', f)).rejects.toThrow(/invalid semver/);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects a manifest served for a different release', async () => {
    // A stale/mispublished endpoint answering with another version's manifest
    // must not apply that release's checksums to this version's binary.
    const body = JSON.stringify({ version: '0.9.9', platforms: {} });
    await expect(
      fetchNativeReleaseManifest(VERSION, mockFetch({ ok: true, status: 200, body })),
    ).rejects.toThrow(/0\.9\.9/);
  });

  it('throws on non-2xx', async () => {
    await expect(
      fetchNativeReleaseManifest(VERSION, mockFetch({ ok: false, status: 404 })),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('throws on a malformed checksum', async () => {
    const body = JSON.stringify({
      version: VERSION,
      platforms: { 'win32-x64': { filename: 'kimi-code-win32-x64.zip', checksum: 'xyz' } },
    });
    await expect(
      fetchNativeReleaseManifest(VERSION, mockFetch({ ok: true, status: 200, body })),
    ).rejects.toThrow();
  });

  it('propagates fetch errors', async () => {
    const f = mock(async () => {
      throw new Error('network down');
    }) as unknown as unknown as typeof fetch;
    await expect(fetchNativeReleaseManifest(VERSION, f)).rejects.toThrow(/network down/);
  });

  it('rejects when the response body stalls past the request timeout', async () => {
    const clock = createFakeClock();
    const f = mock(async (_input: string | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      // Headers arrive, then the body stalls; only the timeout can end this.
      text: async () =>
        new Promise<string>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    })) as unknown as unknown as typeof fetch;
    const promise = fetchNativeReleaseManifest(VERSION, f, clock);
    // Bun's `expect(promise).rejects` blocks until the promise settles, so the
    // rejection has to happen before the assertion is created.
    void promise.catch(() => {});
    await advanceAsync(clock, 11_000);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});

describe('selectBunPlatformEntry', () => {
  const manifest = {
    version: VERSION,
    bun: {
      'win32-x64': { filename: 'kimi-code-win32-x64.zip', checksum: 'a'.repeat(64) },
    },
  };

  it('returns the entry matching platform-arch', () => {
    expect(selectBunPlatformEntry(manifest, 'win32', 'x64')).toEqual(manifest.bun['win32-x64']);
  });

  it('throws when the platform is missing', () => {
    expect(() => selectBunPlatformEntry(manifest, 'linux', 'arm64')).toThrow(/linux-arm64/);
  });
});

describe('url helpers', () => {
  it('builds the manifest and binary URLs from the binaries base', () => {
    expect(nativeManifestUrl(VERSION)).toBe(
      `${kimiCodeCdnBinariesBase()}/${VERSION}/manifest.json`,
    );
    expect(nativeBinaryUrl(VERSION, 'kimi-code-win32-x64.zip')).toBe(
      `${kimiCodeCdnBinariesBase()}/${VERSION}/kimi-code-win32-x64.zip`,
    );
  });
});
