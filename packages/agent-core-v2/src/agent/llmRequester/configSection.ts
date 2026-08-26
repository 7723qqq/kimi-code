import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const LLM_REQUESTER_SECTION = 'llmRequester';

export const LLM_REQUEST_BYTE_BUDGET_ENV = 'KIMI_LLM_REQUEST_BYTE_BUDGET';

export const DEFAULT_REQUEST_BYTE_BUDGET_BYTES = 32 * 1024 * 1024;

export const LlmRequesterConfigSchema = z.object({
  requestByteBudget: z.number().int().min(1).optional(),
});

export type LlmRequesterConfig = z.infer<typeof LlmRequesterConfigSchema>;

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const llmRequesterEnvBindings: EnvBindings<LlmRequesterConfig> = envBindings(
  LlmRequesterConfigSchema,
  {
    requestByteBudget: { env: LLM_REQUEST_BYTE_BUDGET_ENV, parse: parsePositiveInt },
  },
);

export const stripLlmRequesterEnv = stripEnvBoundFields(llmRequesterEnvBindings);

registerConfigSection(LLM_REQUESTER_SECTION, LlmRequesterConfigSchema, {
  defaultValue: {},
  env: llmRequesterEnvBindings,
  stripEnv: stripLlmRequesterEnv,
});

export function resolveRequestByteBudget(config: IConfigService): number {
  return (
    config.get<LlmRequesterConfig | undefined>(LLM_REQUESTER_SECTION)?.requestByteBudget ??
    DEFAULT_REQUEST_BYTE_BUDGET_BYTES
  );
}
