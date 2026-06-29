/**
 * `filestore` domain error codes and helpers.
 */

import { KimiError, registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const FileErrors = {
  codes: {
    FILE_NOT_FOUND: 'file.not_found',
    FILE_TOO_LARGE: 'file.too_large',
  },
  info: {
    'file.not_found': {
      title: 'File not found',
      retryable: false,
      public: true,
      action: 'Check the file_id or upload the file again.',
    },
    'file.too_large': {
      title: 'Upload too large',
      retryable: false,
      public: true,
      action: 'Upload a smaller file (limit is 50 MiB).',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(FileErrors);

export class FileError extends KimiError {
  constructor(
    code: (typeof FileErrors.codes)[keyof typeof FileErrors.codes],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, { details });
    this.name = 'FileError';
  }
}

export function fileNotFoundError(fileId: string): FileError {
  return new FileError(FileErrors.codes.FILE_NOT_FOUND, `file not found: ${fileId}`, { fileId });
}

export function fileTooLargeError(seen: number, limit: number): FileError {
  return new FileError(
    FileErrors.codes.FILE_TOO_LARGE,
    `upload size ${seen} bytes exceeds limit ${limit} bytes`,
    { seen, limit },
  );
}

export function isFileError(error: unknown, code: (typeof FileErrors.codes)[keyof typeof FileErrors.codes]): boolean {
  return error instanceof KimiError && error.code === code;
}
