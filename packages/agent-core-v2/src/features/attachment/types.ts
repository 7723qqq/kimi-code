/**
 * `attachment` domain — durable attachment vocabulary.
 *
 * Ported from deepseek-harness `attachment/attachment` (MIT). Content-
 * addressed image objects: an `AttachmentId` is the sha256 of the stored
 * bytes, so identical payloads deduplicate and a reference can be verified
 * against the object it names.
 */

import { createDecorator } from '#/_base/di/instantiation';

/** Opaque storage identifier for one immutable object; never a path or URL. */
export type AttachmentId = string & { readonly __attachmentId: unique symbol };

/** Brand a `sha256:<hex>` digest as an {@link AttachmentId}. */
export function AttachmentId(digest: string): AttachmentId {
  return digest as AttachmentId;
}

/** Raster image formats accepted by the attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  readonly attachmentId: AttachmentId;
  /** Media type verified from the stored bytes. */
  readonly mediaType: ImageMediaType;
  /** Exact encoded byte length. */
  readonly bytes: number;
  /** Intrinsic encoded width in pixels. */
  readonly width: number;
  /** Intrinsic encoded height in pixels. */
  readonly height: number;
  /** Optional display name stripped of local path information. */
  readonly name?: string;
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  readonly maxImageBytes: number;
  readonly maxImagePixels: number;
  readonly mediaTypes: readonly ImageMediaType[];
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  readonly data: Uint8Array;
  /** Caller-declared media type, checked against fully decoded bytes. */
  readonly mediaType: ImageMediaType;
  /** Optional display name; it is never interpreted as a path. */
  readonly name?: string;
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  readonly ref: ImageAttachmentRef;
  readonly data: Uint8Array;
}

export interface IAttachmentService {
  readonly _serviceBrand: undefined;

  /**
   * Validate and durably commit one image, deduplicating by content.
   * @param input - encoded bytes and declared metadata.
   * @returns the durable reference; rejects on admission or storage failure.
   */
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;

  /**
   * Read a stored image back after reference and digest verification.
   * @param attachmentId - the reference returned by {@link saveImage}.
   * @returns the stored bytes and verified metadata.
   */
  readImage(attachmentId: AttachmentId): Promise<StoredImageAttachment>;
}

export const IAttachmentService = createDecorator<IAttachmentService>('attachmentService');
