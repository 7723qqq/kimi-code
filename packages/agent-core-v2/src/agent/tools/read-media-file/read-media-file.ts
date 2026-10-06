import type { VideoURLPart } from '#human/llm/message';
import type { VideoUploadInput as ProviderVideoUploadInput } from '#human/llm/media/upload';

export const MAX_MEDIA_MEGABYTES = 100;
export const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

export type VideoUploadInput = ProviderVideoUploadInput;

export type VideoUploader = (
  input: VideoUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<VideoURLPart>;
