import { Jimp } from 'jimp';

import { sniffImageDimensions, sniffMediaFromMagic } from '#/agent/media/file-type';

import { AttachmentError } from './errors';
import type { ImageMediaType } from './types';

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

export function probeImage(data: Uint8Array): DetectedImage {
  const detected = sniff(data);
  if (detected === null) {
    throw new AttachmentError('attachment.invalid_image', 'Unsupported or malformed image data.');
  }
  return detected;
}

export async function detectImage(data: Uint8Array, maxPixels?: number): Promise<DetectedImage> {
  const detected = sniff(data);
  if (detected === null) {
    throw new AttachmentError('attachment.invalid_image', 'Unsupported or malformed image data.');
  }
  if (maxPixels !== undefined && detected.width * detected.height > maxPixels) {
    throw new AttachmentError(
      'attachment.image_too_many_pixels',
      'Image exceeds the configured decoded-pixel limit.',
    );
  }
  try {
    await Jimp.fromBuffer(Buffer.from(data));
  } catch {
    throw new AttachmentError('attachment.invalid_image', 'Unsupported or malformed image data.');
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
