/**
 * Experimental agent-core-v2 engine gate.
 *
 * The `kimi server run` → server-v2 routing (see `sub/server/run.ts`) keys off
 * this single master switch. Read directly from the env (matching
 * `cli/update/rollout.ts`) because the CLI must not depend on the core flag
 * registry. Unset / any non-truthy value keeps the v1 engine.
 */

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isKimiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return TRUTHY_VALUES.has((env[KIMI_V2_ENV] ?? '').trim().toLowerCase());
}
