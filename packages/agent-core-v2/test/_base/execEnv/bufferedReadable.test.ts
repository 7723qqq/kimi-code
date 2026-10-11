import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    (async () => {
      await delay(timeoutMs);
      throw new Error(`timed out after ${timeoutMs}ms`);
    })(),
  ]);
}

describe('BufferedReadable (host process copy)', () => {
  it('keeps an awaiting consumer in charge of the pacing instead of draining on the liveness timer', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(256 * 1024, 0x63);
    const total = 24;
    let peakBuffered = 0;
    let resolved = false;

    const produce = (async () => {
      for (let index = 0; index < total; index++) {
        if (!source.write(chunk)) {
          await once(source, 'drain');
        }
      }
      source.end();
    })();

    const consume = (async () => {
      for await (const _chunk of buffered) {
        peakBuffered = Math.max(peakBuffered, buffered.readableLength);
        await delay(200);
      }
      resolved = true;
    })();

    await delay(1500);
    const sampled = buffered.readableLength;
    const atCeiling = sampled >= 8 * 1024 * 1024;

    expect(resolved).toBe(false);
    expect(atCeiling).toBe(false);
    expect(peakBuffered).toBeLessThanOrEqual(2 * 1024 * 1024 + chunk.length);

    await withTimeout(Promise.all([produce, consume]), 30_000);
  });

  it('stops prefetching at the buffer ceiling when nobody reads at all', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(256 * 1024, 0x64);
    const total = 60;

    for (let index = 0; index < total; index++) {
      source.write(chunk);
    }

    await delay(1500);

    expect(buffered.readableLength).toBeLessThanOrEqual(8 * 1024 * 1024 + chunk.length);

    buffered.destroy();
    source.destroy();
  });

  it('still moves the source when a caller waits before reading', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(256 * 1024, 0x65);
    const total = 8;

    const produce = (async () => {
      for (let index = 0; index < total; index++) {
        if (!source.write(chunk)) {
          await once(source, 'drain');
        }
      }
      source.end();
    })();

    await delay(300);
    const collected = await withTimeout(
      (async () => {
        let bytes = 0;
        for await (const part of buffered) {
          bytes += part.length;
        }
        return bytes;
      })(),
      15_000,
    );

    await produce;
    expect(collected).toBe(chunk.length * total);
  });
});
