/**
 * Localized port of v1's config path helpers (`agent-core/src/config/path.ts`).
 * `node:path` replaces v1's `pathe` (same semantics for these joins).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * v1 resolved these through `pathe`, whose `join` normalizes to forward
 * slashes on Windows; keep that behavior (hosts compare/format these paths).
 */
function portableJoin(...segments: string[]): string {
  return join(...segments).replaceAll('\\', '/');
}

export function resolveKimiHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? portableJoin(homedir(), '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? portableJoin(resolveKimiHome(input.homeDir), 'config.toml');
}

export function ensureKimiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
