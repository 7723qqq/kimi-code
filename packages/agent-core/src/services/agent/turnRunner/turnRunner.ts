import { createDecorator } from '../../../di';

import type { Hooks } from '../hooks';
import type { Turn } from '../types';

export interface ITurnRunner {
  launch(): Turn;
  getActiveTurn(): Turn | undefined;

  readonly hooks: Hooks<{
    onLaunched: { turn: Turn };
    beforeStep: { turn: Turn };
    afterStep: { turn: Turn };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITurnRunner = createDecorator<ITurnRunner>('agentTurnRunnerService');
