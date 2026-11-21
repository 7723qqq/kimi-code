import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { MediaReadContext } from '#/agent/tools/read-media-file/execute-media-read';
import type { VideoUploader } from '#/agent/tools/read-media-file/read-media-file';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { videoUploaderFor } from '#/llm-adapter/model/media';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { createVideoUploader } from './registerMediaTools';

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
    @IProtocolAdapterRegistry private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IAgentEnvironmentService private readonly runtime: IAgentEnvironmentService,
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
        model = this.modelCatalog.get(modelAlias);
        const request = this.protocolRegistry.request(model);
        videoUploader = createVideoUploader(videoUploaderFor(model, request), {
          client: this.telemetry,
          props: {
            model: modelAlias,
            provider_type: model.providerType ?? model.protocol,
            protocol: model.protocol,
          },
        });
      } catch {
        model = undefined;
      }
    }
    return {
      capabilities: this.profile.getModelCapabilities(),
      videoUploader,
      inlineVideoSupported:
        model?.protocol !== 'openai' && model?.protocol !== 'openai_responses',
      providerType: model?.providerType,
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
