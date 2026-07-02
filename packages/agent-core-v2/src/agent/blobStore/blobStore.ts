/**
 * `blobStore` domain — `IAgentBlobStoreService` contract.
 *
 * Offloads large inline media payloads to content-addressed blob storage and
 * rehydrates them on read. Bound at Agent scope.
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface BlobStoreServiceOptions {
  /** Per-agent home directory used to derive the blob storage scope. */
  readonly homedir?: string;
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
