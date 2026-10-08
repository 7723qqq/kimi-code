import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '#/llm-adapter/contract/message';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: 'degraded' | { readonly strip: MediaStripSnapshot };
  readonly withoutCacheKey?: boolean;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
    mediaPaths?: ReadonlyMap<string, string>,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
