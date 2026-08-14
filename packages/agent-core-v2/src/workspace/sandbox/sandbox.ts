/**
 * `sandbox` domain — process-confinement contract and policy resolution.
 *
 * The file-effect vocabulary for confined executions, ported from
 * deepseek-harness `sandbox` (MIT): `read-only` permits no writes outside
 * required sinks, `workspace-write` also permits the workspace root, and
 * `off` (the default) bypasses confinement entirely. Backends implement the
 * actual isolation; until one is registered, every confined mode fails
 * closed at the execution boundary so a configured sandbox can never
 * silently degrade into an unsandboxed run.
 */

import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SANDBOX_SECTION = 'sandbox';

/** File-effect modes for confined executions. `off` disables confinement. */
export type SandboxMode = 'off' | 'read-only' | 'workspace-write';

export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  readonly mode: SandboxMode;
  /** Absolute workspace root `workspace-write` may write under. */
  readonly workspaceRoot: string;
}

export const SandboxConfigSchema = z.object({
  mode: z.enum(['off', 'read-only', 'workspace-write']).default('off'),
});

registerConfigSection(SANDBOX_SECTION, SandboxConfigSchema, {
  defaultValue: { mode: 'off' },
});

export function resolveSandboxPolicy(
  config: IConfigService,
  workspaceRoot: string,
): SandboxExecutionPolicy {
  return {
    mode: config.get<{ mode?: SandboxMode } | undefined>(SANDBOX_SECTION)?.mode ?? 'off',
    workspaceRoot,
  };
}

/**
 * Whether any sandbox backend is available on this host. Always false today:
 * the actual isolation backends (Windows restricted-token, Linux Landlock,
 * macOS Seatbelt) are not yet implemented in this fork — a backend registers
 * itself here when it lands.
 */
export function isSandboxBackendAvailable(): boolean {
  return false;
}
