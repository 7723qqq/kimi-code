/**
 * `attachment` domain — raster inspection for attachment admission.
 *
 * Replaces the upstream sharp-based pipeline (deepseek-harness
 * `attachment-local/src/image.ts`, MIT) with kimi's existing image
 * toolchain: media type from `sniffMediaFromMagic` magic-byte sniffing,
 * dimensions from `sniffImageDimensions` (native + TS fallback), and a full
 * decode through jimp for admission (the read path re-derives metadata from
 * the sniffers only).
 */

import { Jimp } from 'jimp';

import { AttachmentError } from './errors';
import { sniffImageDimensions, sniffMediaFromMagic } from '#/agent/media/file-type';
import type { ImageMediaType } from './types';

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
};

/**
 * Parse a supported raster's header and return its intrinsic metadata
 * without decoding pixels. Digest-verified reads use this: admission already
 * proved that these exact bytes decode completely.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export function probeImage(data: Uint8Array): DetectedImage {
  const detected = sniff(data);
  if (detected === null) {
    throw new AttachmentError(
      'attachment.invalid_image',
      'Unsupported or malformed image data.',
    );
  }
  return detected;
}

/**
 * Fully decode a supported raster and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @param maxPixels - decoded-pixel admission limit.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, maxPixels?: number): Promise<DetectedImage> {
  const detected = sniff(data);
  if (detected === null) {
    throw new AttachmentError(
      'attachment.invalid_image',
      'Unsupported or malformed image data.',
    );
  }
  if (maxPixels !== undefined && detected.width * detected.height > maxPixels) {
    throw new AttachmentError(
      'attachment.image_too_many_pixels',
      'Image exceeds the configured decoded-pixel limit.',
    );
  }
  // Full decode proves the raster is complete and decodable.
  try {
    await Jimp.fromBuffer(Buffer.from(data));
  } catch {
    throw new AttachmentError(
      'attachment.invalid_image',
      'Unsupported or malformed image data.',
    );
  }
  return detected;
}

function sniff(data: Uint8Array): DetectedImage | null {
  const mediaType = MEDIA_TYPES[sniffMediaFromMagic(data)?.mimeType ?? ''];
  if (mediaType === undefined) return null;
  const dimensions = sniffImageDimensions(data);
  if (dimensions === null) return null;
  return { mediaType, width: dimensions.width, height: dimensions.height };
}
