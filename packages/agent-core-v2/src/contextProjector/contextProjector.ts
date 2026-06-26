import { createDecorator } from "#/_base/di";
import type { Message } from '@moonshot-ai/kosong';

import type { ContextMessage } from '#/contextMemory';

export interface IContextProjector {
  project(messages: readonly ContextMessage[]): readonly Message[];
}

export const IContextProjector = createDecorator<IContextProjector>(
  'agentContextProjectorService',
);
