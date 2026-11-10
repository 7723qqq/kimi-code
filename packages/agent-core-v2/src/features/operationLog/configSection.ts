import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import type { OperationLogRetention } from './operationLog';

export const OPERATION_LOG_SECTION = 'operationLog';
export const OPERATION_LOG_MAX_OPERATIONS_ENV = 'KIMI_CODE_OPERATION_LOG_MAX_OPERATIONS';
export const OPERATION_LOG_MAX_AGE_MS_ENV = 'KIMI_CODE_OPERATION_LOG_MAX_AGE_MS';
export const OPERATION_LOG_MAX_TOTAL_BYTES_ENV = 'KIMI_CODE_OPERATION_LOG_MAX_TOTAL_BYTES';

export const OperationLogConfigSchema = z.object({
  maxOperations: z.number().int().positive().optional(),
  maxAgeMs: z.number().int().nonnegative().optional(),
  maxTotalBytes: z.number().int().positive().optional(),
});

export type OperationLogConfig = z.infer<typeof OperationLogConfigSchema>;

function parsePositiveInt(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInt(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const operationLogEnvBindings: EnvBindings<OperationLogConfig> = envBindings(
  OperationLogConfigSchema,
  {
    maxOperations: { env: OPERATION_LOG_MAX_OPERATIONS_ENV, parse: parsePositiveInt },
    maxAgeMs: { env: OPERATION_LOG_MAX_AGE_MS_ENV, parse: parseNonNegativeInt },
    maxTotalBytes: { env: OPERATION_LOG_MAX_TOTAL_BYTES_ENV, parse: parsePositiveInt },
  },
);

export function resolveOperationLogRetention(
  config: IConfigService,
): Partial<OperationLogRetention> {
  return config.get<OperationLogConfig | undefined>(OPERATION_LOG_SECTION) ?? {};
}

registerConfigSection(OPERATION_LOG_SECTION, OperationLogConfigSchema, {
  env: operationLogEnvBindings,
  stripEnv: stripEnvBoundFields(operationLogEnvBindings),
});
