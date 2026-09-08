/**
 * Runner for hosting the native Rust server (`kimi-agent --serve`) from the CLI.
 *
 * Provides standalone process lifecycle management, health check polling,
 * and transparent proxying for `kimi web --rust-server`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getDataDir } from '#/utils/paths';
import type { StartForegroundHooks } from './run';
import type { ParsedServerOptions } from './shared';

/**
 * Locate the `kimi-agent-cli` executable.
 * Checks KIMI_AGENT_BIN env var, adjacent directory to executable, target directories,
 * and native binary distributions.
 */
export function findRustAgentBinary(): string | undefined {
  const envBin = process.env['KIMI_AGENT_BIN'];
  if (envBin && existsSync(envBin)) {
    return envBin;
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  const arch = `${process.platform}-${process.arch}`;
  let root = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
  if (!existsSync(join(root, 'packages/kimi-agent'))) {
    const fromDist = resolve(import.meta.dirname, '..', '..', '..');
    if (existsSync(join(fromDist, 'packages/kimi-agent'))) {
      root = fromDist;
    }
  }

  const candidates = [
    // Production compiled single-file bundle (adjacent to kimi binary)
    join(dirname(process.execPath), `kimi-agent-cli${ext}`),
    join(root, 'packages/kimi-agent/target/release', `kimi-agent-cli${ext}`),
    join(root, 'packages/kimi-agent/target/debug', `kimi-agent-cli${ext}`),
    join(root, 'dist-native/bin', arch, `kimi-agent-cli${ext}`),
    join(root, 'apps/kimi-code/dist-native/bin', arch, `kimi-agent-cli${ext}`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Build CLI arguments for `kimi-agent --serve`.
 */
export function buildRustServerArgs(
  options: ParsedServerOptions,
  webAssetsDir?: string,
  dataDir?: string,
): string[] {
  const address = `${options.host}:${options.port}`;
  const args = ['--serve', address];

  if (options.dangerousBypassAuth) {
    args.push('--no-auth');
  }

  if (webAssetsDir && existsSync(webAssetsDir)) {
    args.push('--web-assets', webAssetsDir);
  }

  const effectiveDataDir = dataDir ?? join(getDataDir(), 'agent');
  args.push('--data-dir', effectiveDataDir);

  return args;
}

/**
 * Wait for the server health endpoint to report healthy status.
 */
export async function waitForServerReady(
  origin: string,
  timeoutMs = 15000,
  pollIntervalMs = 150,
): Promise<void> {
  const start = Date.now();
  const healthUrl = `${origin}/api/v1/health`;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) {
        return;
      }
    } catch {
      // Server not accepting connections yet, retry
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for Rust server to become ready at ${healthUrl} after ${timeoutMs}ms`);
}

export interface RustServerRunnerDeps {
  findBinary?: () => string | undefined;
  spawnProcess?: typeof spawn;
  waitReady?: typeof waitForServerReady;
  webAssetsDir?: string;
  dataDir?: string;
}

/**
 * Launch the native Rust server in the foreground, hooking its lifecycle to the current process.
 */
export async function startRustServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
  deps: RustServerRunnerDeps = {},
): Promise<never> {
  const finder = deps.findBinary ?? findRustAgentBinary;
  const binary = finder();

  if (!binary) {
    throw new Error(
      '[kimi-agent] Native server binary not found. ' +
        'Please build with `make rust-build` or set KIMI_AGENT_BIN to the binary path.',
    );
  }

  const args = buildRustServerArgs(options, deps.webAssetsDir, deps.dataDir);
  const spawner = deps.spawnProcess ?? spawn;
  const child: ChildProcess = spawner(binary, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  let exiting = false;

  const cleanup = async (reason: string) => {
    if (exiting) return;
    exiting = true;
    try {
      await hooks.onShutdown?.(reason);
    } catch {
      // Ignore hook shutdown errors
    }
    if (child.pid && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Child might already be dead
      }
    }
  };

  process.on('SIGINT', () => {
    void cleanup('SIGINT').then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void cleanup('SIGTERM').then(() => process.exit(0));
  });

  child.on('error', (err) => {
    console.error(`[kimi-agent] Process error: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (!exiting) {
      if (code !== 0 && code !== null) {
        console.error(`[kimi-agent] Native server exited with code ${code}`);
        process.exit(code);
      } else if (signal) {
        console.error(`[kimi-agent] Native server terminated by signal ${signal}`);
        process.exit(1);
      }
    }
    process.exit(0);
  });

  const origin = `http://${options.host}:${options.port}`;
  const waiter = deps.waitReady ?? waitForServerReady;
  try {
    await waiter(origin);
    await hooks.onReady?.(origin);
  } catch (err) {
    await cleanup('startup_error');
    throw err;
  }

  // Keep alive until process exits via signal or child termination
  await new Promise<never>(() => {});
  return undefined as never;
}
