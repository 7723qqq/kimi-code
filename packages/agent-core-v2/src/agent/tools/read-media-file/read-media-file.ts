import type { VideoUploadInput as ProviderVideoUploadInput } from '#human/media/upload';
import type { VideoURLPart } from '#human/llm/message';

export const READ_MEDIA_FILE_TOOL_NAME = 'ReadMediaFile';
export const MAX_MEDIA_MEGABYTES = 100;
export const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

// ---- from upstream 2.7.0 ----
import { z } from 'zod';

export const ReadMediaFileInputSchema = z.object({
  path: z.string().describe('Path of the media file to read'),
  region: z.unknown().optional(),
  full_resolution: z.boolean().optional(),
});
export type ReadMediaFileInput = z.infer<typeof ReadMediaFileInputSchema>;

export type VideoUploadInput = ProviderVideoUploadInput;

export type VideoUploader = (
  input: VideoUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<VideoURLPart>;
