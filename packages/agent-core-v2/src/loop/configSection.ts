/**
 * `loop` domain (L4) — `loopControl` config-section schema.
 *
 * Owns the `[loop_control]` configuration section (step / retry / context-size
 * limits) consumed by `LoopService` (step + retry budgets) and `ProfileService`
 * (context sizing). Registered into `IConfigRegistry` by `LoopService` on
 * construction.
 */

import { z } from 'zod';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;
