import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { VideoUploadEvent } from '#/app/telemetry/events';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { MediaReadContext } from '#/agent/tools/read-media-file/execute-media-read';
import type { VideoUploader } from '#/agent/tools/read-media-file/read-media-file';

export interface VideoUploadTelemetry {
  readonly client: ITelemetryService;
  readonly props?: Pick<VideoUploadEvent, 'model' | 'provider_type' | 'protocol'>;
}

export function createVideoUploader(
  requester: Pick<ModelRequester, 'uploadVideo'> | undefined,
  telemetry?: VideoUploadTelemetry,
): VideoUploader | undefined {
  const uploadVideo = requester?.uploadVideo;
  if (uploadVideo === undefined) return undefined;
  const bound = uploadVideo.bind(requester);
  if (telemetry === undefined) return (input, options) => bound(input, options);

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
      const part = await bound(input, options);
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

export interface IMediaReadContext {
  readonly _serviceBrand: undefined;
  getMediaReadContext(): MediaReadContext | undefined;
}

export const IMediaReadContext: ServiceIdentifier<IMediaReadContext> =
  createDecorator<IMediaReadContext>('mediaReadContext');

export class MediaReadContextService extends Service implements IMediaReadContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  getMediaReadContext(): MediaReadContext | undefined {
    if (!this.runtime.isAvailable(['fs'])) return undefined;
    const modelAlias = this.profile.getModel();
    let videoUploader: VideoUploader | undefined;
    let model: Model | undefined;
    if (modelAlias !== '') {
      try {
        const requester = this.modelCatalog.getRequester(modelAlias);
        model = requester.model;
        videoUploader = createVideoUploader(requester, {
          client: this.telemetry,
          props: {
            model: modelAlias,
            provider_type: model?.providerType ?? model?.protocol,
            protocol: model?.protocol,
          },
        });
      } catch {
        model = undefined;
      }
    }
    return {
      capabilities: this.profile.getModelCapabilities(),
      videoUploader,
      inlineVideoSupported: model?.protocol !== 'openai' && model?.protocol !== 'openai_responses',
      telemetry: this.telemetry,
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IMediaReadContext,
  MediaReadContextService,
  ScopeActivation.OnScopeCreated,
  'media',
);
