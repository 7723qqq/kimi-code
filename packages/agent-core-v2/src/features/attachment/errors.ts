import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AttachmentErrors = {
  codes: {
    ATTACHMENT_INVALID_IMAGE: 'attachment.invalid_image',
    ATTACHMENT_IMAGE_TYPE_MISMATCH: 'attachment.image_type_mismatch',
    ATTACHMENT_IMAGE_TOO_LARGE: 'attachment.image_too_large',
    ATTACHMENT_IMAGE_TOO_MANY_PIXELS: 'attachment.image_too_many_pixels',
    ATTACHMENT_INVALID_REF: 'attachment.invalid_ref',
  },
  retryable: [],
} as const satisfies ErrorDomain;

registerErrorDomain(AttachmentErrors);

/** Structured attachment failure with a stable code. */
export class AttachmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}
