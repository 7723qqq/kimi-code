import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const AttachmentErrors = {
  codes: {
    ATTACHMENT_INVALID_IMAGE: 'attachment.invalid_image',
    ATTACHMENT_IMAGE_TYPE_MISMATCH: 'attachment.image_type_mismatch',
    ATTACHMENT_IMAGE_TOO_LARGE: 'attachment.image_too_large',
    ATTACHMENT_IMAGE_TOO_MANY_PIXELS: 'attachment.image_too_many_pixels',
    ATTACHMENT_INVALID_REF: 'attachment.invalid_ref',
  },
  retryable: [],
  info: {
    'attachment.invalid_image': {
      retryable: false,
      public: true,
    },
    'attachment.image_type_mismatch': {
      retryable: false,
      public: true,
    },
    'attachment.image_too_large': {
      retryable: false,
      public: true,
    },
    'attachment.image_too_many_pixels': {
      retryable: false,
      public: true,
    },
    'attachment.invalid_ref': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AttachmentErrors);

export type AttachmentErrorCode = (typeof AttachmentErrors.codes)[keyof typeof AttachmentErrors.codes];

export class AttachmentError extends Error2 {
  constructor(code: AttachmentErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'AttachmentError';
  }
}
