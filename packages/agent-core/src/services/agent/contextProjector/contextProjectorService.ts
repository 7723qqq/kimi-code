import { InstantiationType, registerSingleton } from '../../../di';
import type { Message } from '@moonshot-ai/kosong';

import { project } from '../../../agent/context/projector';
import type { ContextMessage } from '../types';
import { IContextProjector } from './contextProjector';

export class ContextProjectorService implements IContextProjector {
  project(messages: readonly ContextMessage[]): readonly Message[] {
    return project(messages);
  }
}

registerSingleton(IContextProjector, ContextProjectorService, InstantiationType.Delayed);
