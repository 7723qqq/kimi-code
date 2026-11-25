import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/llm-adapter/contract/message';
import type { ModelRequester } from '#/llm-adapter/model/model-requester';

export interface IAgentMediaResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]>;

  recoverFailedUploads(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export const IAgentMediaResolverService = createDecorator<IAgentMediaResolverService>(
  'agentVideoResolverService',
);
