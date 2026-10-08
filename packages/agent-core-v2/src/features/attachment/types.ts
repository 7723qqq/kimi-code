import { createDecorator } from '#/_base/di/instantiation';

export type AttachmentId = string & { readonly __attachmentId: unique symbol };

export function AttachmentId(digest: string): AttachmentId {
  return digest as AttachmentId;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageAttachmentRef {

  readonly attachmentId: AttachmentId;

  readonly mediaType: ImageMediaType;

  readonly bytes: number;

  readonly width: number;

  readonly height: number;

  readonly name?: string;
}

export interface ImageAttachmentLimits {
  readonly maxImageBytes: number;
  readonly maxImagePixels: number;
  readonly mediaTypes: readonly ImageMediaType[];
}

export interface SaveImageAttachment {
  readonly data: Uint8Array;

  readonly mediaType: ImageMediaType;

  readonly name?: string;
}

export interface StoredImageAttachment {
  readonly ref: ImageAttachmentRef;
  readonly data: Uint8Array;
}

export interface IAttachmentService {
  readonly _serviceBrand: undefined;

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;

  readImage(attachmentId: AttachmentId): Promise<StoredImageAttachment>;
}

export const IAttachmentService = createDecorator<IAttachmentService>('attachmentService');
