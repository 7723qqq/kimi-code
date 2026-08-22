import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { SUBAGENT_BACKEND_NAMES } from '#/session/subagent/backend/subagentBackend';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_PROFILE_NAME = 'coder';
export const RESUMED_LABEL = 'subagent';

export const SubagentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    const hasBackend =
      typeof normalized['backend'] === 'string' && normalized['backend'].length > 0;
    if (!hasSubagentType && !hasResumeId && !hasBackend) {
      normalized['subagent_type'] = DEFAULT_PROFILE_NAME;
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the subagent on: one of the aliases listed under "Available models" in this tool description, or "primary" for the main model you are running on (for hard, quality-sensitive tasks). When omitted, the configured default model is used. Ignored when resuming — resumed subagents keep their own model.',
      ),
    fork: z
      .boolean()
      .optional()
      .describe(
        'When true, start the subagent from a snapshot of the calling agent\'s completed conversation history instead of from zero context. The forked subagent shares the caller\'s profile, model, and tool set so the prompt prefix cache is reused. Requires the KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK flag. Cannot be combined with subagent_type, resume, or model — the fork inherits all three from the caller.',
      ),
    backend: z
      .enum(SUBAGENT_BACKEND_NAMES)
      .optional()
      .describe(
        'Run the task in an external agent CLI instead of an in-process subagent: one of the backends listed under "Available backends" in this tool description. The prompt is executed by that CLI and its final text is returned as the result. Cannot be combined with subagent_type, resume, model, fork, or run_in_background.',
      ),
  }),
);

export type SubagentToolInput = z.infer<typeof SubagentToolInputSchema>;

export const SubagentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type SubagentToolOutput = z.infer<typeof SubagentToolOutputSchema>;

export const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';
export const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.';
export const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  'The subagent was stopped before it finished by user.';
export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';
export const SUBAGENT_FORK_FLAG_REQUIRED =
  'The fork parameter requires the KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK flag to be enabled.';
export const FORK_CANNOT_COMBINE_WITH_RESUME =
  'Cannot use fork with resume — fork creates a new subagent from the caller\'s snapshot; resume targets an existing agent by id.';
export const FORK_CANNOT_COMBINE_WITH_SUBAGENT_TYPE =
  'Cannot use fork with subagent_type — a forked subagent inherits the caller\'s profile. Omit subagent_type to use fork.';
export const FORK_CANNOT_COMBINE_WITH_MODEL =
  'Cannot use fork with model — a forked subagent inherits the caller\'s model. Omit model to use fork.';
export const SUBAGENT_BACKEND_FLAG_REQUIRED =
  'The backend parameter requires the KIMI_CODE_EXPERIMENTAL_SUBAGENT_BACKENDS flag to be enabled.';
export const BACKEND_CANNOT_COMBINE_WITH_RESUME =
  'Cannot use backend with resume — an external backend runs a fresh session in the external CLI; resume targets an existing in-process agent by id.';
export const BACKEND_CANNOT_COMBINE_WITH_SUBAGENT_TYPE =
  'Cannot use backend with subagent_type — external backends have no in-process agent profile. Omit subagent_type to use backend.';
export const BACKEND_CANNOT_COMBINE_WITH_MODEL =
  'Cannot use backend with model — external backends are configured through the [subagentBackend] config section instead of the model parameter.';
export const BACKEND_CANNOT_COMBINE_WITH_FORK =
  'Cannot use backend with fork — fork snapshots the in-process conversation history, which an external backend does not share.';
export const BACKEND_BACKGROUND_UNAVAILABLE =
  'Background execution is not available for external backends.';

export interface ISubagentTool extends AgentTool<SubagentToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISubagentTool = createDecorator<ISubagentTool>('subagentTool');
