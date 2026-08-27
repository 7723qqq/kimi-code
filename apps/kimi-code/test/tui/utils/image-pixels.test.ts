import { describe, expect, it } from 'vitest';

import { decodeImagePixels } from '#/tui/utils/image-pixels';

// 1x1 transparent png base64
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('decodeImagePixels', () => {
  it('decodes a PNG payload to RGBA pixels with dimensions', async () => {
    const decoded = await decodeImagePixels(PNG_B64, 'image/png');
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(1);
    expect(decoded?.height).toBe(1);
    expect(decoded?.pixels.length).toBe(1 * 1 * 4);
  });

  it('returns null for undecodable payloads', async () => {
    const decoded = await decodeImagePixels('bm90LWFuLWltYWdl', 'image/png');
    expect(decoded).toBeNull();
  });

  it('caches by payload so repeated decodes share one promise', async () => {
    const first = decodeImagePixels(PNG_B64, 'image/png');
    const second = decodeImagePixels(PNG_B64, 'image/png');
    expect(second).toBe(first);
    await expect(first).resolves.not.toBeNull();
  });

  it('does not cache failed decodes', async () => {
    const bad = 'bm90LWFuLWltYWdl';
    const first = decodeImagePixels(bad, 'image/png');
    await expect(first).resolves.toBeNull();
    const retry = decodeImagePixels(bad, 'image/png');
    expect(retry).not.toBe(first);
  });
});
