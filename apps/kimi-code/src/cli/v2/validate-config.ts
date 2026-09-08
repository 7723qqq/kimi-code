/**
 * V2 config.toml validation for `kimi doctor`.
 * Decoupled from agent-core-v2.
 */

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export interface V2ConfigValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class V2ConfigValidationError extends Error {
  readonly details: { readonly validationIssues: readonly V2ConfigValidationIssue[] };

  constructor(issues: readonly V2ConfigValidationIssue[]) {
    super('v2 config validation failed');
    this.details = { validationIssues: issues };
  }
}

const DEPRECATED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  max_retries_per_step: "rename it to 'max_attempts_per_step'",
};

const DEPRECATED_ENV_VARS: Readonly<Record<string, string>> = {
  KIMI_LOOP_MAX_RETRIES_PER_STEP: 'KIMI_LOOP_MAX_ATTEMPTS_PER_STEP',
};

const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'providers',
  'default_provider',
  'default_model',
  'models',
  'thinking',
  'plan_mode',
  'yolo',
  'permission',
  'telemetry',
  'experimental',
  'services',
  'agent',
  'hooks',
  'loop',
  'loop_control',
  'task',
  'mcp',
  'auth',
  'skill',
]);

const modelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  max_context_size: z.number().int().positive(),
  protocol: z.string().optional(),
}).passthrough();

export function validateConfigTomlV2(
  text: string,
  filePath: string,
  getEnv: (name: string) => string | undefined = (name) => process.env[name],
): string | undefined {
  let data: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const lineCol = /(line \d+, column \d+)/i.exec(msg)?.[1] ?? 'line 1, column 1';
      throw new Error(`Invalid TOML in ${filePath}: ${msg} (${lineCol})`, {
        cause: error,
      });
    }
  }

  const issues: V2ConfigValidationIssue[] = [];
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      unknownKeys.push(key);
      continue;
    }

    if (key === 'models' && value && typeof value === 'object') {
      for (const [modelId, modelVal] of Object.entries(value as Record<string, unknown>)) {
        const parsed = modelSchema.safeParse(modelVal);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            issues.push({
              path: [
                'models',
                modelId,
                ...issue.path.map((p) => (typeof p === 'symbol' ? p.toString() : p)),
              ],
              message: issue.message,
            });
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new V2ConfigValidationError(issues);
  }

  const warnings: string[] = [];
  for (const [k, msg] of Object.entries(DEPRECATED_CONFIG_KEYS)) {
    if (k in data) {
      warnings.push(`'${k}' is deprecated; ${msg}.`);
    } else {
      for (const val of Object.values(data)) {
        if (val && typeof val === 'object' && k in val) {
          warnings.push(`'${k}' is deprecated; ${msg}.`);
          break;
        }
      }
    }
  }

  for (const [dep, primary] of Object.entries(DEPRECATED_ENV_VARS)) {
    if (getEnv(dep) !== undefined && getEnv(primary) === undefined) {
      warnings.push(
        `Environment variable ${dep} is deprecated; use ${primary} instead.`,
      );
    }
  }

  if (unknownKeys.length > 0) {
    warnings.push(
      `Unknown top-level ${unknownKeys.length === 1 ? 'key' : 'keys'} ignored by the v2 engine: ${unknownKeys.join(', ')}.`,
    );
  }

  return warnings.length > 0 ? warnings.join('\n') : undefined;
}
