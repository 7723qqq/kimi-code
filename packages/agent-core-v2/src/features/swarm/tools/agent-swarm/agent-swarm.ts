import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Flat object: keys are existing subagent agent_id strings (from a previous swarm\'s `<subagent agent_id="...">` result), values are the continuation prompt for that subagent (e.g. "continue"). Resumed subagents run before new item-based subagents. Do not pass an array or a list of {item, prompt} objects.',
      ),
    fork: z
      .boolean()
      .optional()
      .describe(
        'When true, start each item-spawned subagent from a snapshot of the calling agent\'s completed conversation history instead of from zero context. The forked subagent shares the caller\'s profile, model, and tool set so the prompt prefix cache is reused. Requires the KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK flag. Cannot be combined with subagent_type or model — the fork inherits both from the caller. Resumed subagents are never forked.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the item-spawned subagents on: one of the aliases listed under "Available models" in this tool description, or "primary" for the main model you are running on (for hard, quality-sensitive tasks). When omitted, the configured default model is used. Resumed subagents always keep their own model.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
