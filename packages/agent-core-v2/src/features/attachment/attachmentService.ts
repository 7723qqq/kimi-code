/**
 * `attachment` domain — `AttachmentService`: content-addressed image
 * attachment storage (App scope).
 *
 * Admission validates the declared media type against the bytes, the byte
 * and decoded-pixel limits, and a full raster decode; storage is
 * content-addressed (sha256), so identical payloads deduplicate and a
 * reference is verifiable against the object it names. The configured
 * `[attachment] root` defaults to a private per-process temp directory.
 *
 * Ported from deepseek-harness `attachment/attachment-local` (MIT).
 */

import { Service } from '#/_base/di/service';
import { IConfigService } from '#/app/config/config';

import { AttachmentError } from './errors';
import { detectImage, probeImage } from './attachmentImage';
import { displayName, readObject, saveObject } from './attachmentStore';
import {
  type IAttachmentService,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type SaveImageAttachment,
  type AttachmentId,
} from './types';
import { privateRoot } from './attachmentRoot';

const DEFAULT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

export class AttachmentService extends Service implements IAttachmentService {
  declare readonly _serviceBrand: undefined;

  constructor(@IConfigService private readonly configService: IConfigService) {
    super();
  }

  private root(): string {
    return this.configService.get<{ root?: string }>('attachment')?.root ?? privateRoot();
  }

  private limits(): ImageAttachmentLimits {
    const section = this.configService.get<{ limits?: Partial<ImageAttachmentLimits> }>('attachment');
    return section?.limits === undefined
      ? DEFAULT_LIMITS
      : { ...DEFAULT_LIMITS, ...section.limits };
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const limits = this.limits();
    if (input.data.byteLength === 0) {
      throw new AttachmentError('attachment.invalid_image', 'Image is empty.');
    }
    if (input.data.byteLength > limits.maxImageBytes) {
      throw new AttachmentError('attachment.image_too_large', 'Image exceeds the configured byte limit.');
    }
    if (!limits.mediaTypes.includes(input.mediaType)) {
      throw new AttachmentError(
        'attachment.image_type_mismatch',
        'Declared image type is not accepted.',
      );
    }
    const detected = await detectImage(input.data, limits.maxImagePixels);
    if (detected.mediaType !== input.mediaType) {
      throw new AttachmentError(
        'attachment.image_type_mismatch',
        'Declared image type does not match its bytes.',
      );
    }
    const id = await saveObject(this.root(), input.data);
    return {
      attachmentId: id,
      mediaType: detected.mediaType,
      bytes: input.data.byteLength,
      width: detected.width,
      height: detected.height,
      name: displayName(input.name),
    };
  }

  async readImage(attachmentId: AttachmentId): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    const data = await readObject(this.root(), attachmentId);
    const detected = probeImage(data);
    return {
      ref: {
        attachmentId,
        mediaType: detected.mediaType,
        bytes: data.byteLength,
        width: detected.width,
        height: detected.height,
      },
      data,
    };
  }
}
