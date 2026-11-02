import type { PluginNodeRunner } from '@moonshot-ai/kimi-code-sdk';
import { KIMI_NODE_FALLBACK_SUBCOMMAND } from '@moonshot-ai/kimi-code-sdk/runtime';

export interface PluginNodeRunnerProbe {
  readonly argv?: readonly string[];
  readonly execArgv?: readonly string[];
  readonly execPath?: string;
  readonly assets?: Record<string, unknown>;
}

/**
 * How this CLI process can run a plugin's `command: "node"` server on Bun.
 *
 * A packaged binary is invoked as `kimi.exe __plugin_run_node …`, while a dev
 * run is `bun --import <loader> src/main.ts …`, so the hidden subcommand has to
 * be appended to the launcher prefix rather than replaced by `process.execPath`
 * alone. Returning `undefined` keeps the plugin on the system `node`.
 */
export function resolvePluginNodeRunner(
  probe: PluginNodeRunnerProbe = {},
): PluginNodeRunner | undefined {
  const execPath = probe.execPath ?? process.execPath;
  const assets =
    probe.assets ??
    (globalThis as { __KIMI_BUN_ASSETS__?: Record<string, unknown> }).__KIMI_BUN_ASSETS__;
  if (assets !== undefined && Object.keys(assets).length > 0) {
    return { command: execPath, args: [KIMI_NODE_FALLBACK_SUBCOMMAND] };
  }
  const argv = probe.argv ?? process.argv;
  const execArgv = probe.execArgv ?? process.execArgv;
  const entry = argv[1];
  if (entry === undefined || !isCliEntry(entry)) return undefined;
  return {
    command: execPath,
    args: [...execArgv, entry, KIMI_NODE_FALLBACK_SUBCOMMAND],
  };
}

function isCliEntry(entry: string): boolean {
  return /(^|[\\/])main\.(ts|mjs|js)$/.test(entry);
}
