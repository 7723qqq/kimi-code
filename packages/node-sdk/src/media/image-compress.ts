import {
  buildMalformedImageNotice,
  buildUnsupportedImageNotice,
  isDataUrl,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
} from './image-format';

export const MAX_IMAGE_EDGE_PX = 2000;
export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;
export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;
export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256];
const JPEG_QUALITY_STEPS = [80, 60, 40, 20];

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
  readonly telemetry?: unknown;
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

export interface CompressBase64Result {
  readonly base64: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export async function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const normalizedMime = normalizeImageMime(mimeType);

  const passthrough = (): CompressImageResult => ({
    data: bytes,
    mimeType: normalizedMime,
    width: 0,
    height: 0,
    originalWidth: 0,
    originalHeight: 0,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });

  if (bytes.length === 0) return passthrough();

  try {
    const { nativeCompressImage } = await import('@moonshot-ai/kimi-agent/native');
    const res = await nativeCompressImage(bytes, normalizedMime, {
      maxEdge,
      byteBudget,
      fallbackEdges: [...FALLBACK_EDGES_PX],
      jpegQualitySteps: [...JPEG_QUALITY_STEPS],
    });
    if (res && res.changed) {
      return {
        data: res.data,
        mimeType: res.mimeType,
        width: res.width,
        height: res.height,
        originalWidth: res.originalWidth,
        originalHeight: res.originalHeight,
        changed: true,
        originalByteLength: res.originalByteLength,
        finalByteLength: res.finalByteLength,
      };
    }
  } catch {
    // fallback or passthrough
  }

  return passthrough();
}

export async function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: 0,
      finalByteLength: 0,
    };
  }

  const result = await compressImageForModel(bytes, mimeType, options);
  if (!result.changed) {
    return {
      base64,
      mimeType,
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      changed: false,
      originalByteLength: result.originalByteLength,
      finalByteLength: result.finalByteLength,
    };
  }

  return {
    base64: Buffer.from(result.data).toString('base64'),
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    originalWidth: result.originalWidth,
    originalHeight: result.originalHeight,
    changed: true,
    originalByteLength: result.originalByteLength,
    finalByteLength: result.finalByteLength,
  };
}

export interface ContentPartImageUrl {
  readonly type: 'image_url';
  readonly imageUrl: { readonly url: string };
}

export interface ContentPartText {
  readonly type: 'text';
  readonly text: string;
}

export type MediaContentPart = ContentPartImageUrl | ContentPartText | { readonly type: string; readonly [key: string]: unknown };

export function gateImageFormatParts(parts: readonly MediaContentPart[]): MediaContentPart[] {
  const out: MediaContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url' && 'imageUrl' in part) {
      const url = (part as ContentPartImageUrl).imageUrl.url;
      const parsed = parseImageDataUrl(url);
      if (parsed === null) {
        if (isDataUrl(url)) {
          out.push({ type: 'text', text: buildMalformedImageNotice(url) });
          continue;
        }
      } else {
        if (!isModelAcceptedImageMime(parsed.mimeType)) {
          out.push({ type: 'text', text: buildUnsupportedImageNotice(parsed.mimeType) });
          continue;
        }
        const canonicalMime = normalizeImageMime(parsed.mimeType);
        out.push({
          type: 'image_url',
          imageUrl: { url: `data:${canonicalMime};base64,${parsed.base64}` },
        } as MediaContentPart);
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

export interface ImageVariantDescription {
  readonly width?: number;
  readonly height?: number;
  readonly byteLength?: number;
  readonly mimeType?: string;
}

export interface ImageCompressionCaptionInput {
  readonly original: ImageVariantDescription;
  readonly final: ImageVariantDescription;
  readonly originalPath?: string | null;
}

function describeImageVariant(variant: ImageVariantDescription): string {
  const parts: string[] = [];
  if (variant.width && variant.height) {
    parts.push(`${variant.width}x${variant.height}`);
  }
  if (variant.byteLength) {
    parts.push(formatByteSize(variant.byteLength));
  }
  if (variant.mimeType) {
    parts.push(variant.mimeType.replace(/^image\//, '').toUpperCase());
  }
  return parts.join(', ');
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildImageCompressionCaption(input: ImageCompressionCaptionInput): string {
  const sentences = [
    `Image compressed to fit model limits: original ${describeImageVariant(input.original)} -> ` +
      `sent ${describeImageVariant(input.final)}.`,
    'Fine detail may be lost.',
  ];
  if (typeof input.originalPath === 'string' && input.originalPath.length > 0) {
    sentences.push(
      `The uncompressed original is saved at "${input.originalPath}"; if you need fine detail ` +
        '(e.g. small text), call Read on that path with the region parameter ' +
        '(original-pixel coordinates) to view a crop at full fidelity.',
    );
  } else {
    sentences.push('The uncompressed original was not preserved.');
  }
  return `<system>${sentences.join(' ')}</system>`;
}
