/**
 * Rust agent engine integration.
 *
 * Reads the config and wires the Rust agent engine (kimi-agent) when
 * `agent.engine = "rust"` is configured. Falls back to the JS engine
 * if the Rust binary is not found or fails to start.
 */
import { loadRuntimeConfigSafe, resolveConfigPath, resolveKimiHome } from '@moonshot-ai/agent-core';
import type { RunTurnOverride } from '@moonshot-ai/agent-core';

let rustRunTurnOverride: RunTurnOverride | undefined;

/**
 * Try to wire the Rust agent engine based on config.
 * Reads the config file, checks `agent.engine`, and if `"rust"`,
 * dynamically imports the Rust adapter from the kimi-agent package.
 *
 * @returns The `runTurnOverride` function, or `undefined` to use the JS engine.
 */
export async function maybeLoadRustEngine(
  homeDir?: string,
  configPath?: string,
): Promise<RunTurnOverride | undefined> {
  // Lazy-init: once loaded, cache the result
  if (rustRunTurnOverride !== undefined) return rustRunTurnOverride;

  const resolvedHome = resolveKimiHome(homeDir);
  const resolvedConfig = resolveConfigPath({ homeDir: resolvedHome, configPath });
  const loaded = loadRuntimeConfigSafe(resolvedConfig);
  if (loaded.fileError !== undefined) {
    return undefined;
  }

  const agentConfig = loaded.config.agent;
  if (agentConfig?.engine !== 'rust') {
    return undefined;
  }

  // Dynamic import of the Rust adapter via the workspace package.
  try {
    const { createRunTurnOverride } = await import('@moonshot-ai/kimi-agent/rust-loop');
    if (typeof createRunTurnOverride !== 'function') {
      return undefined;
    }
    const override = createRunTurnOverride();
    if (override !== undefined) {
      rustRunTurnOverride = override;
    }
    return rustRunTurnOverride;
  } catch {
    // Rust adapter not available — fall back to JS engine
    return undefined;
  }
}