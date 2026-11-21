import { Blob, File } from 'node:buffer';

import type OpenAI from 'openai';
import OpenAIClient from 'openai';

import type { ImageUploadInput, VideoUploadInput } from '#human/llm/media/upload';
import type { ImageURLPart, VideoURLPart } from '#human/message';
import type { LlmModel } from '#human/llm/model';

import { KIMI_DEFAULT_BASE_URL } from './trait';

export function kimiFilesBaseUrl(model: LlmModel): string {
  const base = model.baseUrl ?? KIMI_DEFAULT_BASE_URL;
  if (model.provider !== 'anthropic') return base;
  return /\/v1\/?$/.test(base) ? base : `${base.replace(/\/$/, '')}/v1`;
}

export interface KimiUploadOptions {
  signal?: AbortSignal;
}

export type KimiFilesFetch = typeof globalThis.fetch;

export interface KimiFilesOptions {
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  fetch?: KimiFilesFetch;
}

const READY_FILE_OBJECT_STATUSES = new Set(['ready', 'ok', 'processed']);

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readUploadFailureDetail(record: Record<string, unknown>): string | undefined {
  const statusDetails = readNonEmptyString(record['status_details']);
  if (statusDetails !== undefined) return statusDetails;
  const extractError = record['extract_error'];
  const directExtractError = readNonEmptyString(extractError);
  if (directExtractError !== undefined) return directExtractError;
  if (extractError !== undefined) {
    const serialized = JSON.stringify(extractError);
    if (serialized !== undefined) return serialized;
  }
  const rawError = record['error'];
  const directError = readNonEmptyString(rawError);
  if (directError !== undefined) return directError;
  if (typeof rawError === 'object' && rawError !== null) {
    const nestedMessage = readNonEmptyString((rawError as Record<string, unknown>)['message']);
    if (nestedMessage !== undefined) return nestedMessage;
  }
  return readNonEmptyString(record['message']);
}

function formatUploadStatusError(
  id: string,
  field: 'extract_status' | 'status',
  value: unknown,
  detail: string | undefined,
): Error {
  const rendered = String(value);
  const summary =
    value === 'error'
      ? `Kimi file upload failed for file "${id}" (${field}=${rendered})`
      : `Kimi file upload for file "${id}" is not ready (${field}=${rendered})`;
  return new Error(detail === undefined ? summary : `${summary}: ${detail}`);
}

function parseUploadedKimiFile(uploaded: unknown): { id: string } {
  if (typeof uploaded !== 'object' || uploaded === null) {
    throw new Error('Kimi file upload returned an invalid response payload');
  }
  const record = uploaded as Record<string, unknown>;
  const rawId = record['id'];
  const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId : undefined;
  if (id === undefined) {
    throw new Error('Kimi file upload returned an empty file id');
  }
  const extractStatus = record['extract_status'];
  if (extractStatus !== undefined && extractStatus !== null && extractStatus !== 'ready') {
    throw formatUploadStatusError(
      id,
      'extract_status',
      extractStatus,
      readUploadFailureDetail(record),
    );
  }
  const status = record['status'];
  const allowUploadedWithReadyExtract = extractStatus === 'ready' && status === 'uploaded';
  if (
    status !== undefined &&
    status !== null &&
    !allowUploadedWithReadyExtract &&
    (typeof status !== 'string' || !READY_FILE_OBJECT_STATUSES.has(status))
  ) {
    throw formatUploadStatusError(id, 'status', status, readUploadFailureDetail(record));
  }
  return { id };
}

export class KimiFiles {
  private readonly _client: OpenAI | undefined;

  constructor(options: KimiFilesOptions) {
    this._client =
      options.apiKey === undefined || options.apiKey.length === 0
        ? undefined
        : new OpenAIClient({
            apiKey: options.apiKey,
            baseURL: options.baseUrl,
            defaultHeaders: options.defaultHeaders,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          });
  }

  async uploadVideo(input: VideoUploadInput, options?: KimiUploadOptions): Promise<VideoURLPart> {
    if (!input.mimeType.startsWith('video/')) {
      throw new Error(`Expected a video mime type, got ${input.mimeType}`);
    }
    const uploaded = await this._upload(input, 'video', options);
    return {
      type: 'video_url',
      videoUrl: {
        url: `ms://${uploaded.id}`,
        id: uploaded.id,
      },
    };
  }

  async uploadImage(input: ImageUploadInput, options?: KimiUploadOptions): Promise<ImageURLPart> {
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`Expected an image mime type, got ${input.mimeType}`);
    }
    const uploaded = await this._upload(input, 'image', options);
    return {
      type: 'image_url',
      imageUrl: {
        url: `ms://${uploaded.id}`,
        id: uploaded.id,
      },
    };
  }

  private async _upload(
    input: VideoUploadInput | ImageUploadInput,
    purpose: 'video' | 'image',
    options?: KimiUploadOptions,
  ): Promise<{ id: string }> {
    const filename = input.filename ?? guessFilename(input.mimeType);
    const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    const blob = new Blob([bytes], { type: input.mimeType });
    const file = new File([blob], filename, { type: input.mimeType });

    const client = this._createClient();
    const uploaded = (await client.files.create(
      {
        file: file as never,
        purpose: purpose as never,
      },
      options?.signal ? { signal: options.signal } : undefined,
    )) as unknown;
    return parseUploadedKimiFile(uploaded);
  }

  private _createClient(): OpenAI {
    if (this._client === undefined) {
      throw new Error('KimiFiles: apiKey is required');
    }
    return this._client;
  }
}

function guessFilename(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType.toLowerCase()] ?? 'bin';
  return `upload.${ext}`;
}

const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
