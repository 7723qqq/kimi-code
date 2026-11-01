import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

import { PROMPT_OPTIMIZER_TIMEOUT_MS } from './promptOptimizer';

export const PROMPT_OPTIMIZER_SECTION = 'promptOptimizer';

export const PromptOptimizerConfigSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  effort: z.string().optional(),
});

export type PromptOptimizerEngineConfig = z.infer<typeof PromptOptimizerConfigSchema>;

registerConfigSection(PROMPT_OPTIMIZER_SECTION, PromptOptimizerConfigSchema, {
  defaultValue: { timeoutMs: PROMPT_OPTIMIZER_TIMEOUT_MS },
});
