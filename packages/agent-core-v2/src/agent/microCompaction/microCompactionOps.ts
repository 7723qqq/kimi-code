/**
 * `microCompaction` domain — wire Model (`MicroCompactionModel`) and the
 * wire-protocol Ops `micro_compaction.apply` (`microCompactionApply`) /
 * `micro_compaction.clamp` (`microCompactionClamp`) for the cache-miss
 * tool-result truncation cutoff.
 *
 * The cutoff is a plain index into the conversation history: messages before
 * it (excluding the `keepRecentMessages` tail) have their oversized tool
 * results replaced by a marker in the outgoing request. It lives on the wire
 * so a `micro_compaction.apply` record restores the cutoff on resume — the op
 * type and payload shape match the v1 record of the same name — and
 * `micro_compaction.clamp` keeps it from pointing past the history after an
 * undo (v1 lowered the in-memory cutoff at the same point; the clamp is
 * persisted so replay applies it too). Cross-model reducers zero the cutoff
 * on `context.clear` / `context.apply_compaction`, on both dispatch and
 * restore, matching v1's reset-on-clear/compaction behavior. Every Op's
 * `apply` is a pure transform that returns a NEW reference on change and the
 * SAME reference on a no-op, so the wire's reference-equality gate stays
 * quiet. Scope-agnostic.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface MicroCompactionState {
  readonly cutoff: number;
}

const ZERO_STATE: MicroCompactionState = Object.freeze({ cutoff: 0 });

export const MicroCompactionModel = defineModel<MicroCompactionState>(
  'microCompaction',
  () => ZERO_STATE,
  {
    reducers: {
      'context.clear': () => ZERO_STATE,
      'context.apply_compaction': () => ZERO_STATE,
    },
  },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'micro_compaction.apply': typeof microCompactionApply;
    'micro_compaction.clamp': typeof microCompactionClamp;
  }
}

export const microCompactionApply = MicroCompactionModel.defineOp(
  'micro_compaction.apply',
  {
    schema: z.object({ cutoff: z.number().nonnegative() }),
    apply: (state, p) => (state.cutoff === p.cutoff ? state : { cutoff: p.cutoff }),
  },
);

export const microCompactionClamp = MicroCompactionModel.defineOp(
  'micro_compaction.clamp',
  {
    schema: z.object({ maxCutoff: z.number().nonnegative() }),
    apply: (state, p) => {
      const cutoff = Math.min(state.cutoff, p.maxCutoff);
      return cutoff === state.cutoff ? state : { cutoff };
    },
  },
);
