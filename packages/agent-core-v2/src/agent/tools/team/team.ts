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
    .describe('Agent profile name used to spawn the agent, e.g. "coder" or "explore".'),
  name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Distinct speaker name shown in the transcript and used for stance tracking and cross-references (e.g. "researcher-1"). Each participant needs a unique name; defaults to the profileName.',
    ),
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
    .max(50)
    .optional()
    .default(3)
    .describe(
      'For discussion: max rounds. For debate: max free-debate rounds. Capped at 50 to bound the number of serial LLM calls.',
    ),
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
