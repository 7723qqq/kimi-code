/**
 * Image ingestion helpers, copied verbatim (modulo imports) from the v2
 * engine's engine-independent support modules so the TUI no longer reaches
 * into the SDK for them:
 *  - `compressImageForModel` / `buildImageCompressionCaption` from
 *    `agent-core-v2/src/_base/tools/support/image-compress.ts`
 *  - `persistOriginalImage` / `sessionMediaOriginalsDir` from
 *    `agent-core-v2/src/_base/tools/support/image-originals.ts`
 *  - `sniffImageDimensions` from
 *    `agent-core-v2/src/_base/tools/support/file-type.ts`
 *
 * TODO(migrate): these are pure, engine-independent utilities. Once a shared
 * home exists outside the engine, delete this copy and import from there.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── compression ──────────────────────────────────────────────────────

/** Longest-edge ceiling (px). Larger images are scaled down to fit. */
export const MAX_IMAGE_EDGE_PX = 2000;

/**
 * Raw-byte budget for a single image. base64 inflates bytes by ~4/3, so a
 * 3.75 MB raw payload stays under a 5 MB encoded ceiling.
 */
export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

/** Progressively lower JPEG quality until the payload fits the byte budget. */
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

/** Last-ditch longest edge when the budget cannot be met at MAX_IMAGE_EDGE_PX. */
const FALLBACK_EDGE_PX = 1000;

/** Pixel-count ceiling above which compression is skipped (decompression-bomb guard). */
const MAX_DECODE_PIXELS = 100_000_000;

/** Raw-byte ceiling above which compression is skipped rather than decoded. */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/** Formats we can both decode and re-encode with the default jimp build. */
const RECODABLE_MIME = new Set(['image/png', 'image/jpeg']);

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
}

export interface CompressImageResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Downsample/re-encode `bytes` to fit the pixel + byte budget. Never throws:
 * on any failure the original bytes are returned with `changed: false`.
 */
export async function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
  const normalizedMime = normalizeMime(mimeType);
  const dims = sniffImageDimensions(bytes);

  const passthrough = (): CompressImageResult => ({
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });

  if (bytes.length === 0) return passthrough();
  if (!RECODABLE_MIME.has(normalizedMime)) return passthrough();

  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) return passthrough();

  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) return passthrough();
  if (bytes.length > maxDecodeBytes) return passthrough();

  try {
    const { Jimp } = await import('jimp');
    const image = await Jimp.fromBuffer(Buffer.from(bytes));
    const sourceIsPng = normalizedMime === 'image/png';

    fitWithinEdge(image, maxEdge);

    const encoded = await encodeWithinBudget(image, {
      sourceIsPng,
      byteBudget,
      fallbackEdge: FALLBACK_EDGE_PX,
    });

    const originalPixels = (dims?.width ?? 0) * (dims?.height ?? 0);
    const finalPixels = encoded.width * encoded.height;
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = originalPixels > 0 && finalPixels < originalPixels;
    if (!shrankBytes && !shrankPixels) return passthrough();

    return {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: dims?.width ?? 0,
      originalHeight: dims?.height ?? 0,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    };
  } catch {
    return passthrough();
  }
}

// ── compression caption ──────────────────────────────────────────────

export interface ImageVariantDescription {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface ImageCompressionCaptionInput {
  readonly original: ImageVariantDescription;
  readonly final: ImageVariantDescription;
  readonly originalPath?: string | null;
}

/**
 * Render the shared `<system>` note placed next to a compressed image so the
 * model knows it is looking at a downsampled copy.
 */
export function buildImageCompressionCaption(input: ImageCompressionCaptionInput): string {
  const sentences = [
    `Image compressed to fit model limits: original ${describeImageVariant(input.original)} -> ` +
      `sent ${describeImageVariant(input.final)}.`,
    'Fine detail may be lost.',
  ];
  if (typeof input.originalPath === 'string' && input.originalPath.length > 0) {
    sentences.push(
      `The uncompressed original is saved at "${input.originalPath}"; if you need fine detail ` +
        '(e.g. small text), call ReadMediaFile on that path with the region parameter ' +
        '(original-pixel coordinates) to view a crop at full fidelity.',
    );
  } else {
    sentences.push('The uncompressed original was not preserved.');
  }
  return `<system>${sentences.join(' ')}</system>`;
}

function describeImageVariant(variant: ImageVariantDescription): string {
  const size = `${variant.mimeType} (${formatByteSize(variant.byteLength)})`;
  if (variant.width > 0 && variant.height > 0) {
    return `${String(variant.width)}x${String(variant.height)} ${size}`;
  }
  return size;
}

/** Human-readable byte size: `640 B`, `128 KB`, `3.8 MB`. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── compression internals ────────────────────────────────────────────

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

interface EncodeOptions {
  readonly sourceIsPng: boolean;
  readonly byteBudget: number;
  readonly fallbackEdge: number;
}

async function encodeWithinBudget(image: JimpImage, opts: EncodeOptions): Promise<EncodedImage> {
  const { sourceIsPng, byteBudget, fallbackEdge } = opts;
  let smallest: EncodedImage | null = null;

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height };
    if (smallest === null || candidate.data.length < smallest.data.length) {
      smallest = candidate;
    }
    return candidate;
  };

  if (sourceIsPng) {
    const png = await image.getBuffer('image/png', { deflateLevel: 9 });
    if (png.length <= byteBudget) return consider(png, 'image/png');
    consider(png, 'image/png');

    if (fitWithinEdge(image, fallbackEdge)) {
      const smallerPng = await image.getBuffer('image/png', { deflateLevel: 9 });
      if (smallerPng.length <= byteBudget) return consider(smallerPng, 'image/png');
      consider(smallerPng, 'image/png');
    }

    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality });
      if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg');
      consider(jpeg, 'image/jpeg');
    }
    return smallest!;
  }

  for (const quality of JPEG_QUALITY_STEPS) {
    const jpeg = await image.getBuffer('image/jpeg', { quality });
    if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg');
    consider(jpeg, 'image/jpeg');
  }
  if (fitWithinEdge(image, fallbackEdge)) {
    const jpeg = await image.getBuffer('image/jpeg', { quality: JPEG_QUALITY_STEPS.at(-1) });
    consider(jpeg, 'image/jpeg');
  }

  return smallest!;
}

function fitWithinEdge(image: JimpImage, edge: number): boolean {
  const longest = Math.max(image.width, image.height);
  if (longest <= edge) return false;
  const factor = edge / longest;
  image.resize({
    w: Math.max(1, Math.round(image.width * factor)),
    h: Math.max(1, Math.round(image.height * factor)),
  });
  return true;
}

function normalizeMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

// ── dimension sniff (from file-type.ts) ──────────────────────────────

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function startsWith(buf: Buffer, prefix: Buffer | readonly number[]): boolean {
  const needle = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  if (buf.length < needle.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (buf[i] !== needle[i]) return false;
  }
  return true;
}

function sniffImageDimensions(data: Buffer | Uint8Array): ImageDimensions | null {
  const buf = toBuffer(data);

  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (
    (startsWith(buf, Buffer.from('GIF87a')) || startsWith(buf, Buffer.from('GIF89a'))) &&
    buf.length >= 10
  ) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  if (startsWith(buf, Buffer.from('BM')) && buf.length >= 26) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }

  if (startsWith(buf, Buffer.from('RIFF')) && buf.length >= 30) {
    const fourCc = buf.subarray(12, 16).toString('latin1');
    if (fourCc === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (fourCc === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (fourCc === 'VP8X') {
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { width, height };
    }
  }

  if (startsWith(buf, [0xff, 0xd8])) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = buf.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
  }

  return null;
}

// ── originals store (from image-originals.ts) ────────────────────────

/** Per-store ceiling; the sweep evicts oldest files beyond this. */
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
};

export interface PersistOriginalImageOptions {
  readonly dir?: string;
  readonly maxTotalBytes?: number;
}

/** Fallback store used when a call site has no session context. */
export function originalImageCacheDir(): string {
  return join(tmpdir(), 'kimi-code-original-images');
}

/** The session-owned originals store: `<sessionDir>/media-originals`. */
export function sessionMediaOriginalsDir(sessionDir: string): string {
  return join(sessionDir, 'media-originals');
}

/**
 * Persist `bytes` into the originals store and return the absolute file path,
 * or null on any failure. Idempotent for identical bytes.
 */
export async function persistOriginalImage(
  bytes: Uint8Array,
  mimeType: string,
  options: PersistOriginalImageOptions = {},
): Promise<string | null> {
  if (bytes.length === 0) return null;
  const dir = options.dir ?? originalImageCacheDir();
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  try {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const extension = MIME_EXTENSION[mimeType.trim().toLowerCase()] ?? 'img';
    const path = join(dir, `${hash}.${extension}`);
    await mkdir(dir, { recursive: true });

    const existing = await stat(path).catch(() => null);
    if (existing === null || existing.size !== bytes.length) {
      await writeFile(path, bytes);
    }

    await sweepCache(dir, maxTotalBytes);
    const persisted = await stat(path).catch(() => null);
    return persisted === null ? null : path;
  } catch {
    return null;
  }
}

async function sweepCache(dir: string, maxTotalBytes: number): Promise<void> {
  const names = await readdir(dir);
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxTotalBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxTotalBytes) break;
    await unlink(entry.path).catch(() => undefined);
    total -= entry.size;
  }
}
