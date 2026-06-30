/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked` / `paused`) or keeps going
 * (`active`).
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal. The tool is only offered to the model while a goal exists.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import type { IAgentSystemReminderService } from '#/systemReminder';
import type { BuiltinTool, ToolExecution } from '#/tool';

import type { IAgentGoalService } from '../goal';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from './outcome-prompts';
import DESCRIPTION from './update-goal.md?raw';

const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';

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

  constructor(
    private readonly goal: IAgentGoalService,
    private readonly reminders: IAgentSystemReminderService,
  ) {}

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
          const completed = await this.goal.markComplete({}, 'model');
          // `complete` is transient: markComplete announces then clears the
          // record. Store the summary request as a system reminder, so the next
          // provider request ends with a user message after the UpdateGoal tool
          // result. Anthropic-compatible providers reject trailing assistant
          // messages as unsupported prefill.
          if (completed !== null) {
            this.reminders.appendSystemReminder(buildGoalCompletionSummaryPrompt(completed), {
              kind: 'system_trigger',
              name: GOAL_COMPLETION_REMINDER_NAME,
            });
          }
          return { output: 'Goal marked complete.', stopTurn: true };
        }
        if (args.status === 'blocked') {
          const blocked = await this.goal.markBlocked({}, 'model');
          if (blocked !== null) {
            this.reminders.appendSystemReminder(buildGoalBlockedReasonPrompt(blocked), {
              kind: 'system_trigger',
              name: GOAL_BLOCKED_REMINDER_NAME,
            });
          }
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        await this.goal.pauseGoal({}, 'model');
        return { output: 'Goal paused.', stopTurn: true };
      },
    };
  }
}
