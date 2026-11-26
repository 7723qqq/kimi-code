import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const CreateGoalToolInputSchema = z
  .object({
    objective: z
      .string()
      .min(1)
      .describe(
        'The work to pursue, used as context. Keep it concise and reference long task descriptions by file path.',
      ),
    completionCriterion: z
      .string()
      .optional()
      .describe(
        'The single verifiable condition that defines completion. The independent judge evaluates this condition after every turn. Provide it whenever the user states or implies a checkable end state; it must be observable from tool results, files, commands, or tests.',
      ),
    replace: z
      .boolean()
      .optional()
      .describe('Replace an existing active, paused, or blocked goal instead of failing.'),
  })
  .strict();

export type CreateGoalToolInput = z.infer<typeof CreateGoalToolInputSchema>;

export interface ICreateGoalTool extends AgentTool<CreateGoalToolInput> {
  readonly _serviceBrand: undefined;
}
export const ICreateGoalTool = createDecorator<ICreateGoalTool>('createGoalTool');
