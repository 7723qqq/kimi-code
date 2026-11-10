import { describe, expect, it, mock } from 'bun:test';

import { decodeImagePixels } from '#/tui/utils/image-pixels';

// 1x1 transparent png base64
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('decodeImagePixels', () => {
  it('decodes a PNG payload to RGBA pixels with dimensions', async () => {
    const decoded = await decodeImagePixels(PNG_B64);
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(1);
    expect(decoded?.height).toBe(1);
    expect(decoded?.pixels.length).toBe(1 * 1 * 4);
  });

  it('returns null for undecodable payloads', async () => {
    const decoded = await decodeImagePixels('bm90LWFuLWltYWdl');
    expect(decoded).toBeNull();
  });

  it('caches by payload so repeated decodes share one promise', async () => {
    const first = decodeImagePixels(PNG_B64);
    const second = decodeImagePixels(PNG_B64);
    expect(second).toBe(first);
    await expect(first).resolves.not.toBeNull();
  });

  it('does not cache failed decodes', async () => {
    const bad = 'bm90LWFuLWltYWdl';
    const first = decodeImagePixels(bad);
    await expect(first).resolves.toBeNull();
    const retry = decodeImagePixels(bad);
    expect(retry).not.toBe(first);
  });

  it('bounds how many payloads decode at once', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    await mock.module('jimp', () => ({
      Jimp: {
        fromBuffer: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => {
            release.push(resolve);
          });
          active -= 1;
          return {
            width: 1,
            height: 1,
            resize: () => undefined,
            bitmap: { data: Buffer.alloc(4), width: 1, height: 1 },
          };
        },
      },
    }));

    try {
      const payloads = Array.from({ length: 6 }, (_, index) =>
        Buffer.from(`concurrent-${String(index)}`).toString('base64'),
      );
      const pending = payloads.map((payload) => decodeImagePixels(payload));

      // Wait for the first wave to actually enter the decoder.
      for (let attempt = 0; attempt < 100 && release.length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(release.length).toBe(3);
      expect(peak).toBeLessThanOrEqual(3);

      // Drain: releasing one slot lets exactly one queued payload start.
      for (let attempt = 0; attempt < 200 && release.length > 0; attempt += 1) {
        release.shift()!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await Promise.all(pending);
      expect(peak).toBeLessThanOrEqual(3);
    } finally {
      mock.restore();
    }
  });
});
