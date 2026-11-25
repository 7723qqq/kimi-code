import type { Storage } from '@moonshot-ai/core/store/storage';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export type {
  StorageAppendOptions,
  StorageReadRange,
  StorageWriteOptions,
} from '@moonshot-ai/core/store/storage';

export const StorageErrors = {
  codes: {
    STORAGE_NOT_FOUND: 'storage.not_found',
    STORAGE_DECODE_FAILED: 'storage.decode_failed',
    STORAGE_CORRUPTED: 'storage.corrupted',
    STORAGE_IO_FAILED: 'storage.io_failed',
    STORAGE_LOCKED: 'storage.locked',
    STORAGE_PERMISSION_DENIED: 'storage.permission_denied',
    STORAGE_DISK_FULL: 'storage.disk_full',
  },
  retryable: ['storage.io_failed', 'storage.locked'],
  info: {
    'storage.not_found': {
      retryable: false,
      public: true,
    },
    'storage.decode_failed': {
      retryable: false,
      public: true,
    },
    'storage.corrupted': {
      retryable: false,
      public: true,
    },
    'storage.io_failed': {
      retryable: true,
      public: true,
    },
    'storage.locked': {
      retryable: true,
      public: true,
    },
    'storage.permission_denied': {
      retryable: false,
      public: true,
    },
    'storage.disk_full': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(StorageErrors);

export type StorageErrorCode = (typeof StorageErrors.codes)[keyof typeof StorageErrors.codes];

export class StorageError extends Error2 {
  declare readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'StorageError';
  }
}

export function isStorageError(error: unknown, code: StorageErrorCode): boolean {
  return error instanceof StorageError && error.code === code;
}

function readErrno(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

type StorageIoErrorCode =
  | typeof StorageErrors.codes.STORAGE_NOT_FOUND
  | typeof StorageErrors.codes.STORAGE_IO_FAILED
  | typeof StorageErrors.codes.STORAGE_PERMISSION_DENIED
  | typeof StorageErrors.codes.STORAGE_DISK_FULL;

const REASONS: Record<StorageIoErrorCode, string> = {
  'storage.not_found': 'path does not exist',
  'storage.io_failed': 'unrecognized I/O error',
  'storage.permission_denied': 'permission denied',
  'storage.disk_full': 'no space left on device',
};

function mapErrno(errno: string | undefined): StorageIoErrorCode {
  switch (errno) {
    case 'ENOENT':
      return StorageErrors.codes.STORAGE_NOT_FOUND;
    case 'EACCES':
    case 'EPERM':
      return StorageErrors.codes.STORAGE_PERMISSION_DENIED;
    case 'ENOSPC':
      return StorageErrors.codes.STORAGE_DISK_FULL;
    default:
      return StorageErrors.codes.STORAGE_IO_FAILED;
  }
}

export function toStorageIoError(error: unknown, ctx: { path: string; op: string }): StorageError {
  if (error instanceof StorageError) return error;
  const errno = readErrno(error);
  const code = mapErrno(errno);
  return new StorageError(code, `storage ${ctx.op} failed: ${REASONS[code]}`, {
    details: { path: ctx.path, op: ctx.op, errno },
    cause: error,
  });
}

export interface StorageListOptions {
  readonly recursive?: boolean;
}

export interface IFileSystemStorageService extends Storage {
  readonly _serviceBrand: undefined;

  list(scope: string, prefix?: string, options?: StorageListOptions): Promise<readonly string[]>;
}

export const IFileSystemStorageService: ServiceIdentifier<IFileSystemStorageService> =
  createDecorator<IFileSystemStorageService>('fileSystemStorageService');
