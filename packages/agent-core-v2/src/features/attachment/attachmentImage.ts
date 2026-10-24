import { sniffImageDimensions, sniffMediaFromMagic } from '#/agent/media/file-type';

import { AttachmentErrors, AttachmentError } from './errors';
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
    throw new AttachmentError(AttachmentErrors.codes.ATTACHMENT_INVALID_IMAGE, 'Unsupported or malformed image data.');
  }
  return detected;
}

export async function detectImage(data: Uint8Array, maxPixels?: number): Promise<DetectedImage> {
  const detected = sniff(data);
  if (detected === null) {
    throw new AttachmentError(AttachmentErrors.codes.ATTACHMENT_INVALID_IMAGE, 'Unsupported or malformed image data.');
  }
  if (maxPixels !== undefined && detected.width * detected.height > maxPixels) {
    throw new AttachmentError(
      AttachmentErrors.codes.ATTACHMENT_IMAGE_TOO_MANY_PIXELS,
      'Image exceeds the configured decoded-pixel limit.',
    );
  }
  try {
    await new Bun.Image(data).bytes();
  } catch (error) {
    throw new AttachmentError(
      AttachmentErrors.codes.ATTACHMENT_INVALID_IMAGE,
      'Unsupported or malformed image data.',
      { cause: error },
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
