/**
 * `blobStore` domain — `IAgentBlobStoreService` contract.
 *
 * Offloads large inline media payloads to content-addressed blob storage and
 * rehydrates them on read. Bound at Agent scope.
 */

import type { ContentPart } from '#/app/llmProtocol';

import { createDecorator } from "#/_base/di";

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface BlobStoreServiceOptions {
  // Reserved for future overrides (threshold / cache size). The persistence
  // root is derived from `IAgentScopeContext.scope('blobs')`.
}

export interface IAgentBlobStoreService {
  readonly _serviceBrand: undefined;
  offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  rehydrateParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  isBlobRef(url: string): boolean;
}

export const IAgentBlobStoreService = createDecorator<IAgentBlobStoreService>(
  'agentBlobStoreService',
);
