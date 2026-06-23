import { InstantiationType, registerSingleton } from '../../../di';
import type { Message } from '@moonshot-ai/kosong';

import { project } from '../../../agent/context/projector';
import type { ContextMessage } from '../types';
import { IContextProjector } from './contextProjector';
import { IMicroCompactionService } from '../microCompaction/microCompaction';

export class ContextProjectorService implements IContextProjector {
  constructor(
    @IMicroCompactionService private readonly microCompaction: IMicroCompactionService,
  ) {}

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return project(this.microCompaction.compact(messages));
  }
}

registerSingleton(IContextProjector, ContextProjectorService, InstantiationType.Delayed);
