import type { ImageURLPart, VideoURLPart } from '#/llm/message';
import type { LlmModel } from '#/llm/model';

export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface MediaVideoUploadOptions {
  readonly model: LlmModel;
  readonly signal?: AbortSignal;
}

export type MediaVideoUploader = (
  video: VideoUploadInput,
  options: MediaVideoUploadOptions,
) => Promise<VideoURLPart>;

export interface ImageUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export type MediaImageUploader = (
  image: ImageUploadInput,
  options: MediaVideoUploadOptions,
) => Promise<ImageURLPart>;

export type MediaUploadStatusChecker = (
  id: string,
  options: MediaVideoUploadOptions,
) => Promise<boolean>;

export interface ProviderMediaContribution {
  readonly inlineVideo?: boolean;
  readonly uploadVideo?: MediaVideoUploader;
  readonly uploadImage?: MediaImageUploader;
  readonly checkUploadFailed?: MediaUploadStatusChecker;
}
