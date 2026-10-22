import { describe, expect, it, mock } from 'bun:test';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';
import { setGlobal, restoreGlobals } from '#test/helpers/stubs';

import { refreshUpdateCache } from '#/cli/update/refresh';
import type { UpdateManifest } from '#/cli/update/types';

/** Let the promise chains behind a settled clock tick run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function advanceAsync(clock: FakeClock, byMs: number): Promise<void> {
  await settle();
  clock.advance(byMs);
  await settle();
}

const MANIFEST: UpdateManifest = {
  version: '0.5.0',
  publishedAt: '2026-05-20T12:00:00.000Z',
  rollout: [
    { percent: 30, delaySeconds: 0 },
    { percent: 30, delaySeconds: 43_200 },
    { percent: 40, delaySeconds: 86_400 },
  ],
};

describe('refreshUpdateCache', () => {
  it('writes a fresh cache carrying the manifest on successful fetch', async () => {
    const writeCache = mock(async () => {});
    const result = await refreshUpdateCache({
      fetchLatest: async () => ({ latest: '0.5.0', manifest: MANIFEST }),
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'cdn',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
      manifest: MANIFEST,
    });
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it('writes a null manifest when the fetch fell back to plain text', async () => {
    const writeCache = mock(async () => {});
    const result = await refreshUpdateCache({
      fetchLatest: async () => ({ latest: '0.5.0', manifest: null }),
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'cdn',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
      manifest: null,
    });
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it('propagates fetch errors and skips writeCache so the cache is preserved', async () => {
    const writeCache = mock(async () => {});
    await expect(
      refreshUpdateCache({
        fetchLatest: async () => {
          throw new Error('network down');
        },
        writeCache,
        now: () => new Date(),
      }),
    ).rejects.toThrow(/network down/);

    expect(writeCache).not.toHaveBeenCalled();
  });

  it('threads timeoutMs into the default CDN fetch', async () => {
    const clock = createFakeClock();
    setGlobal(
      'fetch',
      mock(async (_input: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      }),
    );
    try {
      const result = refreshUpdateCache({
        timeoutMs: 10_000,
        clock,
        writeCache: async () => {},
      });
      let rejected = false;
      void result.catch(() => {
        rejected = true;
      });
      // Bun's `expect(promise).rejects` blocks until the promise settles, so the
      // rejection has to happen before the assertion is created.
      await advanceAsync(clock, 6_000);
      expect(rejected).toBe(false);
      // The CDN path retries with the plain-text endpoint after the JSON fetch aborts.
      // Each attempt arms its own timeout only after the previous one settles, so the
      // clock has to be advanced in windows that let that continuation run.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await advanceAsync(clock, 10_000);
      }

      const error = await result.then(
        () => undefined,
        (reason: Error) => reason,
      );
      expect(error?.message).toContain('aborted');
      expect(rejected).toBe(true);
    } finally {
      restoreGlobals();
    }
  });
});
