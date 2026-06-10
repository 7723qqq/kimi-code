

import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { ulid } from 'ulid';

import {
  Disposable,
  createDecorator,
  resolveKimiHome,
} from '@moonshot-ai/agent-core';

import type { FileMeta } from '@moonshot-ai/protocol';

import { ILogService } from '../logger/logger';

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class FileNotFoundError extends Error {
  readonly fileId: string;
  constructor(fileId: string) {
    super(`file not found: ${fileId}`);
    this.name = 'FileNotFoundError';
    this.fileId = fileId;
  }
}

export class FileTooLargeError extends Error {
  readonly limit: number;
  readonly seen: number;
  constructor(seen: number, limit: number) {
    super(`upload size ${seen} bytes exceeds limit ${limit} bytes`);
    this.name = 'FileTooLargeError';
    this.seen = seen;
    this.limit = limit;
  }
}

export interface SaveOptions {

  name?: string;

  mimeType?: string;

  expiresInSec?: number;
}

export interface GetResult {
  meta: FileMeta;
  blobPath: string;
}

export interface IFileStore {
  readonly _serviceBrand: undefined;

  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;

  get(fileId: string): Promise<GetResult>;

  delete(fileId: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFileStore = createDecorator<IFileStore>('fileStore');

interface IndexFile {
  version: 1;
  files: FileMeta[];
}

