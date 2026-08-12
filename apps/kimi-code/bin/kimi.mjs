#!/usr/bin/env node
/**
 * Kimi Code unified entry (stage G) — spawns the platform Rust binary.
 *
 * The `@moonshot-ai/kimi-code` npm package is a pure distribution shell:
 * all CLI logic lives in the Rust `kimi-cli` binary, distributed codex-style
 * as a per-platform package `@moonshot-ai/kimi-code-<platform>-<arch>` with
 * the binary at `<pkg>/vendor/<platform>-<arch>/bin/kimi[.exe]`; legacy
 * installs that injected the binary into this shell's `bin/` still work via
 * the fallback candidates. `KIMI_RUST_BIN` overrides the path for dev/test.
 *
 * The wrapper mirrors codex-cli's bin pattern: it spawns the child with
 * inherited stdio, forwards SIGINT/SIGTERM/SIGHUP so interactive sessions
 * terminate predictably, and mirrors the child's exit code (or re-raises a
 * terminating signal). `KIMI_ENTRY_DEBUG=1` logs which path was chosen.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const HERE = import.meta.dirname;

const DEBUG = process.env.KIMI_ENTRY_DEBUG === '1';
const debug = (message) => {
  if (DEBUG) console.error(`kimi-entry: ${message}`);
};

/**
 * Resolve the platform Rust binary, codex-style:
 *
 *   1. `KIMI_RUST_BIN` wins when set; a set-but-missing path is a config
 *      error and fails fast rather than silently falling back.
 *   2. The platform package `@moonshot-ai/kimi-code-<platform>-<arch>` is
 *      located via `require.resolve` (npm/pnpm/yarn/bun all install it as
 *      an optional dependency); the binary lives at
 *      `<pkg>/vendor/<platform>-<arch>/bin/kimi[.exe]`.
 *   3. Fall back to legacy local candidates in this shell's `bin/` (old
 *      injected layout: `kimi-<platform>-<arch>[.exe]`, generic
 *      `kimi[.exe]`, plus the legacy cross-platform list kept in sync with
 *      kimi-code-rust-bin; Windows requires the `.exe` suffix).
 *
 * Returns `{ path, source }` with source one of 'env', 'platform-package',
 * 'local-bin'; exits with a clear reinstall hint when nothing resolves.
 */
function resolvePlatformBinary() {
  const explicit = process.env.KIMI_RUST_BIN;
  if (explicit) {
    if (existsSync(explicit)) return { path: explicit, source: 'env' };
    console.error(`kimi: KIMI_RUST_BIN is set but no such file: ${explicit}`);
    process.exit(1);
  }

  const { platform, arch } = process;
  const exe = platform === 'win32' ? '.exe' : '';
  const target = `${platform}-${arch}`;
  const platformPackage = `@moonshot-ai/kimi-code-${target}`;

  try {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve(`${platformPackage}/package.json`));
    const candidate = join(packageRoot, 'vendor', target, 'bin', `kimi${exe}`);
    if (existsSync(candidate)) return { path: candidate, source: 'platform-package' };
  } catch {
    /* platform package not installed */
  }

  const candidates = [
    // pack.mjs default naming: kimi-<platform>-<arch>[.exe]
    `kimi-${platform}-${arch}${exe}`,
    // generic name for hand-installed builds
    `kimi${exe}`,
    // legacy cross-platform list kept in sync with kimi-code-rust-bin
    'kimi-win32-x64.exe',
    'kimi.exe',
    'kimi-linux-x64',
    'kimi-darwin-arm64',
    'kimi',
  ];
  const local = candidates.map((candidate) => join(HERE, candidate)).find((p) => existsSync(p));
  if (local) return { path: local, source: 'local-bin' };

  console.error(
    `kimi: no Rust binary found in ${HERE}` +
      `\n  Expected platform package ${platformPackage} (vendor/${target}/bin/kimi${exe})` +
      ', or a legacy binary in bin/.' +
      '\n  Reinstall to fetch the platform package (`npm install` / your package manager),' +
      '\n  or set KIMI_RUST_BIN to a built binary:' +
      '\n    cargo build --release -p kimi-cli',
  );
  process.exit(1);
}

/**
 * Detect the package manager that installed this package (codex-cli
 * parity): pnpm-owned installs are recognized via `.modules.yaml` in an
 * ancestor `node_modules` whose realpath points back at this package root;
 * otherwise fall back to `npm_config_user_agent` / `npm_execpath` / bun
 * global-layout heuristics. Returns 'npm' as the safe default.
 */
function detectPackageManager() {
  const packageRoot = resolve(HERE, '..');
  for (let dir = packageRoot; ; dir = dirname(dir)) {
    const modulesYaml = join(dir, 'node_modules', '.modules.yaml');
    if (existsSync(modulesYaml)) {
      try {
        const linked = realpathSync(join(dir, 'node_modules', '@moonshot-ai', 'kimi-code'));
        if (linked === realpathSync(packageRoot)) return 'pnpm';
      } catch {
        /* not a pnpm-owned kimi-code install */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  const userAgent = process.env.npm_config_user_agent || '';
  if (/\bbun\//.test(userAgent)) return 'bun';
  const execPath = process.env.npm_execpath || '';
  if (execPath.includes('bun')) return 'bun';
  if (HERE.includes('.bun/install/global')) return 'bun';
  return userAgent ? 'npm' : null;
}

/**
 * The Rust `web` subcommand serves the SPA only when `--assets` is given
 * (API-only otherwise). The npm distribution ships dist-web next to this
 * wrapper, so point the Rust binary at it.
 */
function forwardArgs(raw) {
  if (raw[0] !== 'web') return raw;
  if (raw.slice(1).includes('--assets')) return raw;
  const distWeb = resolve(HERE, '..', 'dist-web');
  if (!existsSync(distWeb)) return raw;
  debug(`injecting --assets ${distWeb} for the web subcommand`);
  return [raw[0], '--assets', distWeb, ...raw.slice(1)];
}

/**
 * Spawn the child with inherited stdio, forward termination signals, and
 * mirror its exit code (or re-raise the terminating signal) in the parent.
 * The detected package manager is handed to the Rust binary via
 * `KIMI_MANAGED_BY_*` so `kimi upgrade` suggests the right install command.
 */
async function runChild(command, args, env) {
  const child = spawn(command, args, { stdio: 'inherit', env });

  child.on('error', (err) => {
    console.error(`kimi: failed to spawn ${command}: ${err.message}`);
    process.exit(1);
  });

  const forwardSignal = (signal) => {
    if (child.killed) return;
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
    process.on(signal, () => forwardSignal(signal));
  });

  const result = await new Promise((resolveChild) => {
    child.on('exit', (code, signal) => {
      if (signal) resolveChild({ type: 'signal', signal });
      else resolveChild({ type: 'code', exitCode: code ?? 1 });
    });
  });

  if (result.type === 'signal') {
    // Re-emit so the parent terminates with 128 + n semantics.
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.exitCode);
  }
}

const { path: rustBinary, source } = resolvePlatformBinary();
debug(`binary from ${source}: ${rustBinary}`);
const manager = detectPackageManager();
const env = { ...process.env };
for (const key of ['KIMI_MANAGED_BY_NPM', 'KIMI_MANAGED_BY_PNPM', 'KIMI_MANAGED_BY_BUN']) {
  delete env[key];
}
env[
  manager === 'bun'
    ? 'KIMI_MANAGED_BY_BUN'
    : manager === 'pnpm'
      ? 'KIMI_MANAGED_BY_PNPM'
      : 'KIMI_MANAGED_BY_NPM'
] = '1';
debug(`package manager: ${manager ?? 'npm'}`);
await runChild(rustBinary, forwardArgs(process.argv.slice(2)), env);
