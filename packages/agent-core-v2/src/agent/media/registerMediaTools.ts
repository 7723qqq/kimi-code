import type { VideoUploadEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { VideoUploader } from '#/agent/tools/read-media-file/read-media-file';

export function createVideoUploader(
  uploadVideo: VideoUploader | undefined,
  telemetry?: VideoUploadTelemetry,
): VideoUploader | undefined {
  if (uploadVideo === undefined) return undefined;
  if (telemetry === undefined) return (input, options) => uploadVideo(input, options);

  return async (input, options) => {
    const startedAt = Date.now();
    const base = {
      ...telemetry.props,
      mime_type: input.mimeType,
      size_bytes: input.data.length,
    };
    const track = (props: VideoUploadEvent): void => {
      try {
        telemetry.client.track2('video_upload', props);
      } catch {
      }
    };
    try {
      const part = await uploadVideo(input, options);
      track({ ...base, outcome: 'success', duration_ms: Date.now() - startedAt });
      return part;
    } catch (error) {
      track({
        ...base,
        outcome: 'error',
        duration_ms: Date.now() - startedAt,
        error_type: error instanceof Error ? error.name : 'Unknown',
      });
      throw error;
    }
  };
}

export interface VideoUploadTelemetry {
  readonly client: ITelemetryService;
  readonly props?: Pick<VideoUploadEvent, 'model' | 'provider_type' | 'protocol'>;
}
