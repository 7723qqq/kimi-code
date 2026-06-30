import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export interface IAgentBlobStoreService {
  readonly _serviceBrand: undefined;
  offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  rehydrateParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  isBlobRef(url: string): boolean;
}

export const IAgentBlobStoreService = createDecorator<IAgentBlobStoreService>(
  'agentBlobStoreService',
);
