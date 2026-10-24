import { describe, expect, it } from 'bun:test';

import { detectImage, probeImage } from '#/features/attachment/attachmentImage';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function encodeWith(format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const source = new Bun.Image(PNG_1PX);
  return Buffer.from(await source[format]().buffer());
}

describe('attachmentImage format coverage', () => {
  it('accepts every declared image type, not just the ones the decoder happens to handle', async () => {
    for (const [mediaType, data] of [
      ['image/png', await encodeWith('png')],
      ['image/jpeg', await encodeWith('jpeg')],
      ['image/webp', await encodeWith('webp')],
      ['image/gif', GIF_1PX],
    ] as const) {
      const detected = await detectImage(data);
      expect(detected.mediaType).toBe(mediaType);
    }
  });

  it('rejects bytes whose body never finishes decoding', async () => {
    const full = await encodeWith('png');
    const truncated = full.subarray(0, Math.floor(full.byteLength * 0.4));
    await expect(detectImage(truncated)).rejects.toThrow(/Unsupported or malformed/);
  });

  it('rejects data that is not an image at all', async () => {
    await expect(detectImage(Buffer.from('not an image'))).rejects.toThrow(/Unsupported or malformed/);
  });

  it('rejects an image whose declared pixels exceed the limit', async () => {
    await expect(detectImage(PNG_1PX, 0)).rejects.toThrow(/decoded-pixel limit/);
  });

  it('probes dimensions without validating the body', () => {
    const detected = probeImage(PNG_1PX);
    expect(detected).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 });
  });
});
