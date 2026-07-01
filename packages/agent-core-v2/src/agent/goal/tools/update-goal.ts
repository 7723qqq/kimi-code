/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked` / `paused`) or keeps going
 * (`active`).
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import type { BuiltinTool, ToolExecution } from '#/agent/tool';

import type { IAgentGoalService } from '#/agent/goal/goal';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'paused', 'blocked'])
      .describe('The lifecycle status to set for the current goal.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(private readonly goal: IAgentGoalService) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    return {
      description: `Setting goal status: ${args.status}`,
      stopBatchAfterThis: args.status !== 'active',
      approvalRule: this.name,
      execute: async () => {
        if (args.status === 'active') {
          await this.goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (args.status === 'complete') {
          await this.goal.markComplete({}, 'model');
          return { output: 'Goal marked complete.', stopTurn: true };
        }
        if (args.status === 'blocked') {
          await this.goal.markBlocked({}, 'model');
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        await this.goal.pauseGoal({}, 'model');
        return { output: 'Goal paused.', stopTurn: true };
      },
    };
  }
}
