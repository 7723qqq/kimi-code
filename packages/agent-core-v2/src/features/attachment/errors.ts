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
      title: 'Invalid image attachment',
      retryable: false,
      public: true,
      action: 'Attach a supported, non-empty image file.',
    },
    'attachment.image_type_mismatch': {
      title: 'Image type mismatch',
      retryable: false,
      public: true,
      action: 'The declared media type does not match the file bytes; re-attach the image.',
    },
    'attachment.image_too_large': {
      title: 'Image too large',
      retryable: false,
      public: true,
      action: 'Attach a smaller image or raise the configured attachment byte limit.',
    },
    'attachment.image_too_many_pixels': {
      title: 'Image has too many pixels',
      retryable: false,
      public: true,
      action: 'Downscale the image before attaching it or raise the configured pixel limit.',
    },
    'attachment.invalid_ref': {
      title: 'Invalid attachment reference',
      retryable: false,
      public: true,
      action: 'The attachment id is unknown or was removed; attach the file again.',
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
