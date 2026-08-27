/**
 * Decode image bytes to RGBA8888 pixels for sixel rendering.
 *
 * pi-tui has no image decoder (it stays dependency-free); the TUI decodes
 * with jimp and hands the pixel buffer to the `Image` component through
 * `ImageOptions.pixels`. Decoding is async, so components render a
 * placeholder first and swap in the image once the promise settles.
 *
 * Results are cached by a short content hash of the base64 payload so a
 * transcript that re-renders (or replays) does not decode the same image
 * twice. The cache is a bounded LRU — each entry holds up to a few MB of
 * pixels, so an unbounded map would leak memory over long sessions.
 * Failed decodes are not cached, so a later attempt can retry.
 */

import { createHash } from 'node:crypto';

export interface DecodedImagePixels {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Longest edge kept after decode; sixel thumbnails never need more. */
const MAX_DECODE_EDGE_PX = 800;

/** Bounded LRU: 32 entries × ≤800×800×4 bytes ≈ 80 MB worst case. */
const MAX_CACHE_ENTRIES = 32;

const cache = new Map<string, Promise<DecodedImagePixels | null>>();

/**
 * Decode a base64 image payload to RGBA8888 pixels, downscaling to
 * `MAX_DECODE_EDGE_PX` first. Returns null when the payload is not a
 * decodable image (the caller keeps its placeholder).
 */
export function decodeImagePixels(
  base64: string,
  _mime: string,
): Promise<DecodedImagePixels | null> {
  const key = cacheKey(base64);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const promise = decodeToPixels(base64).then((decoded) => {
    if (decoded === null) cache.delete(key);
    return decoded;
  });
  cache.set(key, promise);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  return promise;
}

function cacheKey(base64: string): string {
  const hash = createHash('sha256').update(base64).digest('hex').slice(0, 16);
  return `${base64.length}:${hash}`;
}

async function decodeToPixels(base64: string): Promise<DecodedImagePixels | null> {
  try {
    const { Jimp } = await import('jimp');
    const image = await Jimp.fromBuffer(Buffer.from(base64, 'base64'));
    const longest = Math.max(image.width, image.height);
    if (longest > MAX_DECODE_EDGE_PX) {
      const factor = MAX_DECODE_EDGE_PX / longest;
      image.resize({
        w: Math.max(1, Math.round(image.width * factor)),
        h: Math.max(1, Math.round(image.height * factor)),
      });
    }
    const { data, width, height } = image.bitmap;
    return {
      pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width,
      height,
    };
  } catch {
    return null;
  }
}
