import type { Message } from '@moonshot-ai/kosong';

import { project } from '../../../agent/context/projector';
import { registerSingleton, SyncDescriptor } from '../../../di';
import { IMicroCompactionService } from '../microCompaction/microCompaction';
import type { ContextMessage } from '../types';
import { IContextProjector } from './contextProjector';

export class ContextProjectorService implements IContextProjector {
  constructor(
    @IMicroCompactionService private readonly microCompaction: IMicroCompactionService,
  ) {}

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return project(this.microCompaction.compact(messages));
  }
}

registerSingleton(IContextProjector, new SyncDescriptor(ContextProjectorService, [], true));
