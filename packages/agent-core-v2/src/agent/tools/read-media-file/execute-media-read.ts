import { detectFileType, sniffImageDimensions } from '#/agent/media/file-type';
import {
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_DECODE_BYTES,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  type ImageCompressionTelemetry,
  type ImageCropRegion,
} from '#/agent/media/image-compress';
import {
  buildImageConversionGuidance,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { inlineVideoPart, isVideoUploadAuthError } from '#/agent/media/videoUpload';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  isUnknownCapability,
  type ModelCapability,
} from '#/kosong/contract/capability';
import { VideoUploadUnsupportedError } from '#/kosong/contract/errors';
import type { ContentPart } from '#/kosong/contract/message';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { MAX_MEDIA_BYTES, MAX_MEDIA_MEGABYTES, type VideoUploader } from './read-media-file';

export interface MediaReadRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MediaReadArgs {
  readonly path: string;
  readonly region?: MediaReadRegion;
  readonly full_resolution?: boolean;
}

export interface MediaReadContext {
  readonly capabilities: ModelCapability;
  readonly videoUploader?: VideoUploader;
  readonly inlineVideoSupported: boolean;
  readonly telemetry?: ITelemetryService;
}

interface ImageDelivery {
  readonly kind: 'untouched' | 'downsampled' | 'crop' | 'full';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly region?: ImageCropRegion;
  readonly resized?: boolean;
}

function buildMediaNote(input: {
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly delivery?: ImageDelivery;
}): string {
  const parts: string[] = [
    `Read ${input.kind} file.`,
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
  ];
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
    );
  }
  const delivery = input.delivery;
  if (delivery?.kind === 'downsampled') {
    parts.push(
      `The attached image was downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels ` +
        `(${delivery.mimeType}, ${formatByteSize(delivery.byteLength)}) to fit model limits; ` +
        'fine detail may be lost.',
      'To inspect fine detail, call Read again with the region parameter ' +
        '(original-image pixel coordinates) to view a crop at full fidelity.',
    );
  } else if (delivery?.kind === 'crop' && delivery.region) {
    const { x, y, width, height } = delivery.region;
    parts.push(
      `Showing region (x=${String(x)}, y=${String(y)}, width=${String(width)}, height=${String(height)}) ` +
        `of the original image${
          delivery.resized === true
            ? `, downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels`
            : ' at native resolution'
        }.`,
      'To output coordinates in original-image pixels, locate them within this crop and add ' +
        `the region offset (x=${String(x)}, y=${String(y)}).`,
    );
  } else if (delivery?.kind === 'full') {
    parts.push('Shown at native resolution; no downscaling applied.');
  }
  if (input.kind === 'image' && input.dimensions && delivery?.kind !== 'crop') {
    parts.push(
      'If you need to output coordinates, output relative coordinates first ' +
        'and compute absolute coordinates using the original image size.',
    );
  }
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

function buildImageDeliveryLimitError(input: {
  readonly finalBytes: number;
  readonly readByteBudget: number;
  readonly maxEdge: number;
}): string {
  return (
    `Image is too large to send safely after compression (${String(input.finalBytes)} bytes; ` +
    `limit ${String(input.readByteBudget)} bytes and ${String(input.maxEdge)}px on the longest edge). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
    'then call Read on the smaller copy.'
  );
}

function buildImageDecodeLimitError(finalBytes: number): string {
  return (
    `Image is too large to process safely for region or full_resolution (${String(finalBytes)} bytes; ` +
    `safe decode limit ${String(MAX_IMAGE_DECODE_BYTES)} bytes). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
    'region into a separate image, then call Read on the resulting file.'
  );
}

function buildFullResolutionLimitError(path: string, finalBytes: number): string {
  return (
    `"${path}" is ${String(finalBytes)} bytes (${formatByteSize(finalBytes)}), ` +
    `over the ${String(IMAGE_BYTE_BUDGET)}-byte (${formatByteSize(IMAGE_BYTE_BUDGET)}) ` +
    'per-image limit, so full_resolution cannot be honored. ' +
    'Use region to view a crop at full fidelity instead.'
  );
}

function shouldSurfaceVideoUploadError(error: unknown, inlineVideoSupported: boolean): boolean {
  if (error instanceof VideoUploadUnsupportedError) return !inlineVideoSupported;
  return isVideoUploadAuthError(error);
}

async function videoContentPart(
  ctx: MediaReadContext,
  data: Buffer,
  mimeType: string,
  safePath: string,
): Promise<ContentPart> {
  if (ctx.videoUploader !== undefined) {
    try {
      return await ctx.videoUploader({
        data,
        mimeType,
        filename: safePath.split(/[\\/]/).at(-1),
      });
    } catch (error) {
      if (shouldSurfaceVideoUploadError(error, ctx.inlineVideoSupported)) throw error;
    }
  }
  return inlineVideoPart(data, mimeType);
}

export async function executeMediaRead(
  ctx: MediaReadContext,
  args: MediaReadArgs,
  safePath: string,
  fs: IHostFileSystem,
  env: HostEnvironmentInfo,
  header: Uint8Array,
): Promise<ExecutableToolResult> {
  const compressTelemetry: ImageCompressionTelemetry | undefined = ctx.telemetry
    ? { client: ctx.telemetry, source: 'read_media' }
    : undefined;

  try {
    const fileType = detectFileType(safePath, header, 'media');

    if (fileType.kind === 'text') {
      return {
        isError: true,
        output: `"${args.path}" is a text file. Use Read without region or full_resolution to read text files.`,
      };
    }
    if (fileType.kind === 'unknown') {
      return {
        isError: true,
        output:
          `"${args.path}" is not a supported image or video file. ` +
          'Use Read for text files, or Bash or an MCP tool for other binary formats.',
      };
    }

    // An all-false capability set may mean the model id is simply missing
    // from the static detection tables (custom relays, new model names).
    // Only hard-block on a confirmed negative; let unknown capabilities
    // through so a genuinely multimodal upstream can accept the image.
    const capabilitiesUnknown = isUnknownCapability(ctx.capabilities);
    if (fileType.kind === 'image' && !ctx.capabilities.image_in && !capabilitiesUnknown) {
      return {
        isError: true,
        output:
          'The current model does not support image input. ' +
          'Tell the user to use a model with image input capability.',
      };
    }
    if (fileType.kind === 'image' && !isModelAcceptedImageMime(fileType.mimeType)) {
      return {
        isError: true,
        output: buildImageConversionGuidance(args.path, fileType.mimeType, env.osKind),
      };
    }
    if (fileType.kind === 'video' && !ctx.capabilities.video_in && !capabilitiesUnknown) {
      return {
        isError: true,
        output:
          'The current model does not support video input. ' +
          'Tell the user to use a model with video input capability.',
      };
    }

    const stat = await fs.stat(safePath);
    if (stat.size === 0) {
      return { isError: true, output: `"${args.path}" is empty.` };
    }
    if (stat.size > MAX_MEDIA_BYTES) {
      return {
        isError: true,
        output:
          `"${args.path}" is ${String(stat.size)} bytes, which exceeds the ` +
          `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
      };
    }

    if (fileType.kind === 'video' && (args.region !== undefined || args.full_resolution === true)) {
      return {
        isError: true,
        output: 'region and full_resolution apply only to image files.',
      };
    }

    if (
      fileType.kind === 'image' &&
      stat.size > MAX_IMAGE_DECODE_BYTES &&
      (args.region !== undefined || args.full_resolution === true)
    ) {
      return {
        isError: true,
        output: buildImageDecodeLimitError(stat.size),
      };
    }

    if (
      fileType.kind === 'image' &&
      args.region === undefined &&
      args.full_resolution === true &&
      stat.size > IMAGE_BYTE_BUDGET
    ) {
      return {
        isError: true,
        output: buildFullResolutionLimitError(args.path, stat.size),
      };
    }

    const imageDeliveryLimits = {
      readByteBudget: resolveReadImageByteBudget(),
      maxEdge: resolveMaxImageEdgePx(),
    };
    if (
      fileType.kind === 'image' &&
      args.region === undefined &&
      args.full_resolution !== true &&
      stat.size > MAX_IMAGE_DECODE_BYTES &&
      stat.size > imageDeliveryLimits.readByteBudget
    ) {
      return {
        isError: true,
        output: buildImageDeliveryLimitError({
          finalBytes: stat.size,
          ...imageDeliveryLimits,
        }),
      };
    }

    const data = Buffer.from(await fs.readBytes(safePath));
    let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
    let mediaPart: ContentPart;
    let delivery: ImageDelivery | undefined;
    if (fileType.kind === 'image') {
      if (args.region !== undefined) {
        const outcome = await cropImageForModel(data, fileType.mimeType, args.region, {
          skipResize: args.full_resolution === true,
          telemetry: compressTelemetry,
        });
        if (!outcome.ok) {
          return {
            isError: true,
            output: `Cannot read region from "${args.path}": ${outcome.error}`,
          };
        }
        const base64 = Buffer.from(outcome.data).toString('base64');
        mediaPart = {
          type: 'image_url',
          imageUrl: { url: `data:${outcome.mimeType};base64,${base64}` },
        };
        delivery = {
          kind: 'crop',
          width: outcome.width,
          height: outcome.height,
          byteLength: outcome.finalByteLength,
          mimeType: outcome.mimeType,
          region: outcome.region,
          resized: outcome.resized,
        };
        dimensions = { width: outcome.originalWidth, height: outcome.originalHeight };
      } else if (args.full_resolution === true) {
        if (data.length > IMAGE_BYTE_BUDGET) {
          return {
            isError: true,
            output: buildFullResolutionLimitError(args.path, data.length),
          };
        }
        const base64 = data.toString('base64');
        mediaPart = {
          type: 'image_url',
          imageUrl: { url: `data:${fileType.mimeType};base64,${base64}` },
        };
        delivery = {
          kind: 'full',
          width: dimensions?.width ?? 0,
          height: dimensions?.height ?? 0,
          byteLength: data.length,
          mimeType: fileType.mimeType,
        };
      } else {
        const { readByteBudget, maxEdge } = imageDeliveryLimits;
        const compressed = await compressImageForModel(data, fileType.mimeType, {
          byteBudget: readByteBudget,
          maxEdge,
          telemetry: compressTelemetry,
        });
        if (
          compressed.finalByteLength > readByteBudget ||
          Math.max(compressed.width, compressed.height) > maxEdge
        ) {
          return {
            isError: true,
            output: buildImageDeliveryLimitError({
              finalBytes: compressed.finalByteLength,
              readByteBudget,
              maxEdge,
            }),
          };
        }
        const base64 = Buffer.from(compressed.data).toString('base64');
        mediaPart = {
          type: 'image_url',
          imageUrl: { url: `data:${compressed.mimeType};base64,${base64}` },
        };
        delivery = {
          kind: compressed.changed ? 'downsampled' : 'untouched',
          width: compressed.width,
          height: compressed.height,
          byteLength: compressed.finalByteLength,
          mimeType: compressed.mimeType,
        };
        if (compressed.changed) {
          dimensions = { width: compressed.originalWidth, height: compressed.originalHeight };
        }
      }
    } else {
      mediaPart = await videoContentPart(ctx, data, fileType.mimeType, safePath);
    }

    const tag = fileType.kind === 'image' ? 'image' : 'video';
    const openText = `<${tag} path="${safePath}">`;
    const closeText = `</${tag}>`;

    const note = buildMediaNote({
      kind: fileType.kind,
      mimeType: fileType.mimeType,
      byteSize: stat.size,
      dimensions,
      delivery,
    });

    const output: ContentPart[] = [
      { type: 'text', text: openText },
      mediaPart,
      { type: 'text', text: closeText },
    ];

    return { output, note, isError: false };
  } catch (error) {
    return {
      isError: true,
      output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
