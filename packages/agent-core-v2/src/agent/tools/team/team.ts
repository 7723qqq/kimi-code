/**
 * `tools` domain — `IAgentTeamTool` contract (the `Team` tool).
 *
 * Public contract of the `Team` collaboration tool: the input zod schema the
 * model-facing parameters are derived from, plus the `IAgentTeamTool` DI
 * decorator the implementation registers against via
 * `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DebateParticipantSchema = z.object({
  profileName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .default('coder')
    .describe('Agent profile name, e.g. "coder" or "explore".'),
  roleDescription: z.string().trim().min(1).describe('Role description for this participant.'),
  assignedStance: z
    .string()
    .trim()
    .optional()
    .describe(
      'Optional: assign a specific stance to this participant (e.g. "argue for migration").',
    ),
});

export const TeamToolInputSchema = z.object({
  mode: z
    .enum(['discussion', 'debate'])
    .optional()
    .default('discussion')
    .describe(
      '"discussion" for open roundtable, "debate" for structured debate with opening/free-debate/closing phases.',
    ),
  topic: z.string().trim().min(1).describe('The topic or question to discuss/debate.'),
  participants: z
    .array(DebateParticipantSchema)
    .min(2)
    .max(10)
    .describe('The participants (2-10).'),
  maxRounds: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3)
    .describe('For discussion: max rounds. For debate: max free-debate rounds.'),
  summaryPrompt: z
    .string()
    .trim()
    .optional()
    .describe(
      'Optional prompt to generate a final summary or consensus after the discussion/debate.',
    ),
  enableVoting: z
    .boolean()
    .optional()
    .default(false)
    .describe('For debate only: whether to include a voting phase on key points.'),
});

export type TeamToolInput = z.infer<typeof TeamToolInputSchema>;

export interface IAgentTeamTool extends AgentTool<TeamToolInput> {
  readonly _serviceBrand: undefined;
}

export const IAgentTeamTool = createDecorator<IAgentTeamTool>('teamTool');
