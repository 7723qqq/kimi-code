/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import {
  ContextApplyCompaction,
  ContextClear,
} from '#/agent/contextMemory/contextEvents';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface MicroCompactionState {
  readonly cutoff: number;
}

const ZERO_STATE: MicroCompactionState = Object.freeze({ cutoff: 0 });

const microCompactionApplySchema = z.object({ cutoff: z.number().nonnegative() });

export class MicroCompactionApplied extends Event2<z.infer<typeof microCompactionApplySchema>> {
  static override readonly type = 'micro_compaction.apply';
  static override readonly durable = true;
  static override readonly schema = microCompactionApplySchema;
}
export interface MicroCompactionApplied extends z.infer<typeof microCompactionApplySchema> {}

const microCompactionClampSchema = z.object({ maxCutoff: z.number().nonnegative() });

export class MicroCompactionClamped extends Event2<z.infer<typeof microCompactionClampSchema>> {
  static override readonly type = 'micro_compaction.clamp';
  static override readonly durable = true;
  static override readonly schema = microCompactionClampSchema;
}
export interface MicroCompactionClamped extends z.infer<typeof microCompactionClampSchema> {}

export const microCompactionKey = defineState('microCompaction', (): MicroCompactionState => {
  return ZERO_STATE;
})
  .replayable({ schema: z.custom<MicroCompactionState>() })
  .on(MicroCompactionApplied, (s, e) => {
    s.cutoff = e.cutoff;
  })
  .on(MicroCompactionClamped, (s, e) => {
    s.cutoff = Math.min(s.cutoff, e.maxCutoff);
  })
  .on(ContextClear, (s) => {
    s.cutoff = 0;
  })
  .on(ContextApplyCompaction, (s) => {
    s.cutoff = 0;
  });
