/**
 * Rust agent engine gate (v2).
 *
 * The gate is rust-only: the TS agent engine is explicitly disabled for the
 * duration of the rust migration, so a missing or broken rust bundle is a
 * startup error, never a silent fallback to the JS loop. `agent.engine = "js"`
 * is ignored (with a warning) — there is no opt-out.
 *
 * Turns are driven by the native harness (`session-handle` → napi addon),
 * which wires the engine itself; this module only answers "is the bundle
 * there?" before the CLI starts.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '@moonshot-ai/kimi-code-sdk';

/**
 * Bundle-presence guard for the rust-first default. True when the engine
 * bundle is present (napi addon or the bundled stdio CLI). Only existence
 * checks, never loads: a missing bundle is a startup error, never a JS
 * fallback — the gate is rust-only for the migration.
 */
function isEngineLoadable(): boolean {
  const root = resolve(import.meta.dirname, '..', '..', '..', '..');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const arch = `${process.platform}-${process.arch}`;
  const stdioCandidates = [
    join(root, 'packages/kimi-agent/target/release', `kimi-agent-cli${ext}`),
    join(root, 'packages/kimi-agent/target/debug', `kimi-agent-cli${ext}`),
    join(root, 'dist-native/bin', arch, `kimi-agent-cli${ext}`),
  ];
  try {
    for (const candidate of stdioCandidates) {
      if (existsSync(candidate)) return true;
    }
  } catch {
    // ignore and fall through to the addon check
  }
  try {
    return readdirSync(join(root, 'packages/kimi-agent')).some(
      (entry) => entry.startsWith('kimi_agent') && entry.endsWith('.node'),
    );
  } catch {
    return false;
  }
}

/**
 * Engine gate — rust-only, no opt-out during the migration:
 * - `agent.engine = "js"` → ignored (warned): the TS engine stays disabled.
 * - `agent.engine = "rust"` / unset → rust engine required.
 *
 * A missing or broken rust bundle is a startup error, never a silent JS
 * fallback.
 */
function enforceRustEngineGate(agentConfig: { engine?: string } | undefined): void {
  if (agentConfig?.engine === 'js') {
    console.warn(
      '[kimi-agent] `[agent] engine = "js"` is ignored — the TS agent engine is disabled for the rust migration.',
    );
  }
  if (!isEngineLoadable()) {
    throw new Error(
      '[kimi-agent] Rust engine bundle not found — the TS agent engine is disabled. ' +
        'Build the native bundle (start-native.bat / `make rust-build`).',
    );
  }
}

/**
 * Check-only startup gate. `run-shell` calls this to fail loudly when the
 * engine bundle/addon is missing; it deliberately does not build an adapter,
 * because turns run on the native harness (`session-handle` → napi), which
 * wires the engine itself.
 */
export function assertRustEngineAvailable(homeDir?: string, configPath?: string): void {
  const resolvedHome = resolveKimiHome(homeDir);
  const resolvedConfig = resolveConfigPath({ homeDir: resolvedHome, configPath });
  const loaded = loadRuntimeConfigSafe(resolvedConfig);
  enforceRustEngineGate(loaded.fileError === undefined ? loaded.config.agent : undefined);
}
