import { z } from 'zod';

import { type ConfigDiagnostic } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject } from '#/app/config/toml';

import { PROMPT_OPTIMIZER_TIMEOUT_MS } from './promptOptimizer';

export const PROMPT_OPTIMIZER_SECTION = 'promptOptimizer';

export const PromptOptimizerConfigSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  effort: z.string().optional(),
});

export type PromptOptimizerEngineConfig = z.infer<typeof PromptOptimizerConfigSchema>;

registerConfigSection(PROMPT_OPTIMIZER_SECTION, PromptOptimizerConfigSchema, {
  defaultValue: { timeoutMs: PROMPT_OPTIMIZER_TIMEOUT_MS },
  collectDiagnostics: collectInvalidEffort,
});

const KNOWN_EFFORTS: ReadonlySet<string> = new Set([
  'off',
  'on',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function collectInvalidEffort(rawSection: unknown): readonly ConfigDiagnostic[] {
  if (!isPlainObject(rawSection)) return [];
  const effort = rawSection['effort'];
  if (effort === undefined || effort === null) return [];
  if (typeof effort !== 'string' || !KNOWN_EFFORTS.has(effort.trim().toLowerCase())) {
    const shown =
      typeof effort === 'string'
        ? `'${effort}'`
        : `of type ${effort === null ? 'null' : typeof effort}`;
    return [
      {
        domain: PROMPT_OPTIMIZER_SECTION,
        severity: 'warning',
        message: `[prompt_optimizer] effort ${shown} is not a thinking level the rewrite recognizes (off, on, low, medium, high, xhigh, max); the rewrite will follow the main agent instead.`,
      },
    ];
  }
  return [];
}
