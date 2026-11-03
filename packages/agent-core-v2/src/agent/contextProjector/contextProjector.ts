import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '#/llm-adapter/contract/message';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

export type MediaProjection =
  | { readonly degradeCount: number }
  | { readonly strip: MediaStripSnapshot };

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: MediaProjection;
}

export type MediaEvictionPlan =
  | {
      readonly projection: 'media-degraded';
      readonly degradeCount: number;
      readonly estimatedBytes: number;
      readonly evictedMediaCount: number;
    }
  | {
      readonly projection: 'media-stripped';
      readonly estimatedBytes: number;
      readonly evictedMediaCount: number;
    };

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
    mediaPaths?: ReadonlyMap<string, string>,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
  captureMediaDegradeCount(messages: readonly ContextMessage[]): number;
  planMediaEviction(
    messages: readonly Message[],
    estimatedBytes: number,
    budgetBytes: number,
  ): MediaEvictionPlan | undefined;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
