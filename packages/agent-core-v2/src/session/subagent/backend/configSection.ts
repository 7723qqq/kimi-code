/**
 * `subagent` domain — registers the `subagentBackend` config section into
 * `config`.
 *
 * Declares per-backend settings for external subagent backends: the CLI
 * command/args that start each external agent, and backend-specific knobs
 * (model selection). Stays on the static import=register channel so the
 * section remains statically discoverable (config manifest generator drains
 * the module-level table). Bound at App scope.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { IFlagService } from '#/app/flag/flag';

import { SUBAGENT_BACKENDS_FLAG_ID } from './flag';

export const SUBAGENT_BACKEND_SECTION = 'subagentBackend';

export const ClaudeCodeBackendConfigSchema = z.object({
  command: z
    .string()
    .optional()
    .describe('Path to the claude CLI (defaults to "claude" resolved on PATH).'),
  model: z
    .string()
    .optional()
    .describe('Model to run Claude Code with (defaults to the CLI default).'),
});

export const CodexBackendConfigSchema = z.object({
  command: z
    .string()
    .optional()
    .describe('Path to the codex CLI (defaults to "codex" resolved on PATH).'),
  model: z.string().optional().describe('Model to run Codex with (defaults to the CLI default).'),
});

export const AcpBackendConfigSchema = z.object({
  command: z.string().describe('Command that starts the ACP server.'),
  args: z
    .array(z.string())
    .optional()
    .describe('Extra arguments passed to the ACP server command.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra environment variables merged into the ACP server process.'),
});

export const SubagentBackendConfigSchema = z.object({
  claudeCode: ClaudeCodeBackendConfigSchema.optional(),
  codex: CodexBackendConfigSchema.optional(),
  acp: AcpBackendConfigSchema.optional(),
});

export type SubagentBackendConfig = z.infer<typeof SubagentBackendConfigSchema>;
export type ClaudeCodeBackendConfig = z.infer<typeof ClaudeCodeBackendConfigSchema>;
export type CodexBackendConfig = z.infer<typeof CodexBackendConfigSchema>;
export type AcpBackendConfig = z.infer<typeof AcpBackendConfigSchema>;

export function exposesSubagentBackends(flags: IFlagService): boolean {
  return flags.enabled(SUBAGENT_BACKENDS_FLAG_ID);
}

export function stripSubagentBackendParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('backend' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['backend'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('backend')) {
    next['required'] = required.filter((entry) => entry !== 'backend');
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

registerConfigSection(SUBAGENT_BACKEND_SECTION, SubagentBackendConfigSchema, { defaultValue: {} });
