/**
 * `loop` domain (L4) — persists and restores monotonically increasing turn
 * identity.
 *
 * Owns the next available turn id, including cancelled queued reservations and
 * legacy loop-event observations. Consumed by the Agent-scope `loopService`.
 */

import { z } from 'zod';

import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/kosong/contract/message';
import { defineModel } from '#/wire/model';

export interface TurnModelState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
}

export const TurnModel = defineModel<TurnModelState>(
  'turn',
  () => ({ nextTurnId: 0, cancelledTurnIds: [] }),
  {
    reducers: {
      'context.append_loop_event': (state, { event }) => {
        // Only step-scoped events carry a `turnId`; tool results and other
        // narrow variants don't participate in turn-id recovery.
        const rawTurnId = 'turnId' in event ? event.turnId : undefined;
        if (event.type === 'tool.result' || rawTurnId === undefined) {
          return state;
        }

        const turnId = Number.parseInt(rawTurnId, 10);
        return Number.isInteger(turnId) && turnId >= state.nextTurnId
          ? advanceTurnClock(state, turnId + 1)
          : state;
      },
    },
  },
);

const turnInputShape = {
  input: z.custom<readonly ContentPart[]>(),
  origin: z.custom<PromptOrigin>(),
};

declare module '#/wire/types' {
  interface PersistedOpMap {
    'turn.prompt': typeof promptTurn;
    'turn.steer': typeof steerTurn;
    'turn.cancel': typeof cancelTurn;
  }
}

export const promptTurn = TurnModel.defineOp('turn.prompt', {
  schema: z.object(turnInputShape),
  apply: (s) => advanceTurnClock(s, s.nextTurnId + 1),
});

export const steerTurn = TurnModel.defineOp('turn.steer', {
  schema: z.object(turnInputShape),
  apply: (s) => s,
});

export const cancelTurn = TurnModel.defineOp('turn.cancel', {
  schema: z.object({
    turnId: z.number().optional(),
    target: z.enum(['active', 'queued']).optional(),
  }),
  apply: (s, { turnId, target }) => {
    if (target === undefined || turnId === undefined || turnId < s.nextTurnId) return s;
    return advanceTurnClock(s, s.nextTurnId, [...s.cancelledTurnIds, turnId]);
  },
});

function advanceTurnClock(
  state: TurnModelState,
  nextTurnId: number,
  cancelledTurnIds: readonly number[] = state.cancelledTurnIds,
): TurnModelState {
  const pendingCancellations = new Set(
    cancelledTurnIds.filter((turnId) => turnId >= nextTurnId),
  );
  while (pendingCancellations.delete(nextTurnId)) nextTurnId += 1;
  return {
    nextTurnId,
    cancelledTurnIds: [...pendingCancellations].toSorted((a, b) => a - b),
  };
}
