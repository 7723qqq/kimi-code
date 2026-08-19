/**
 * `microCompaction` domain — the Agent-scope state (`microCompactionKey`) and
 * the durable wire events `micro_compaction.apply` (`MicroCompactionApplied`) /
 * `micro_compaction.clamp` (`MicroCompactionClamped`) for the cache-miss
 * tool-result truncation cutoff.
 *
 * The cutoff is a plain index into the conversation history: messages before
 * it (excluding the `keepRecentMessages` tail) have their oversized tool
 * results replaced by a marker in the outgoing request. It lives on the wire
 * so a `micro_compaction.apply` record restores the cutoff on resume — the
 * event type and payload shape match the v1 record of the same name — and
 * `micro_compaction.clamp` keeps it from pointing past the history after an
 * undo (v1 lowered the in-memory cutoff at the same point; the clamp is
 * persisted so replay applies it too). Folds zero the cutoff on
 * `context.clear` / `context.apply_compaction`, matching v1's reset-on-clear/
 * compaction behavior. Every fold is a pure transform of the immer draft, so
 * the dispatcher's patch gate stays quiet on no-ops. Scope-agnostic.
 */

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
