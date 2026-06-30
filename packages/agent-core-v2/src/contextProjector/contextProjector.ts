import { createDecorator } from "#/_base/di";
import type { Message } from '@moonshot-ai/kosong';

import type { ContextMessage } from '#/contextMemory';

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;
  project(messages: readonly ContextMessage[]): readonly Message[];
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
