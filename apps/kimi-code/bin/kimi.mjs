#!/usr/bin/env node
/**
 * Kimi Code unified entry (stage G) — spawns the platform Rust binary.
 *
 * The `@moonshot-ai/kimi-code` npm package is a pure distribution shell:
 * all CLI logic lives in the Rust `kimi-cli` binary, packed by CI into
 * `bin/kimi-<platform>-<arch>[.exe]` (see packages/kimi-code-rust-bin
 * scripts/pack.mjs for the naming); `KIMI_RUST_BIN` overrides the path
 * for dev/test.
 *
 * The wrapper mirrors codex-cli's bin pattern: it spawns the child with
 * inherited stdio, forwards SIGINT/SIGTERM/SIGHUP so interactive sessions
 * terminate predictably, and mirrors the child's exit code (or re-raises a
 * terminating signal). `KIMI_ENTRY_DEBUG=1` logs which path was chosen.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = import.meta.dirname;

const DEBUG = process.env.KIMI_ENTRY_DEBUG === '1';
const debug = (message) => {
  if (DEBUG) console.error(`kimi-entry: ${message}`);
};

/**
 * Resolve the platform Rust binary, mirroring packages/kimi-code-rust-bin
 * bin/kimi.js candidate probing (Windows requires the `.exe` suffix).
 *
 * `KIMI_RUST_BIN` wins when set; a set-but-missing path is a config error and
 * fails fast rather than silently falling back to TS.
 */
function findRustBinary() {
  const explicit = process.env.KIMI_RUST_BIN;
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    console.error(`kimi: KIMI_RUST_BIN is set but no such file: ${explicit}`);
    process.exit(1);
  }

  const { platform, arch } = process;
  const exe = platform === 'win32' ? '.exe' : '';
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
  return candidates.map((candidate) => join(HERE, candidate)).find((p) => existsSync(p));
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

const rustBinary = findRustBinary();
if (rustBinary) {
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
} else {
  console.error(
    'kimi: no Rust binary found in ' + HERE +
    '\n  Build the Rust CLI and copy the result into bin/:' +
    '\n    cargo build --release -p kimi-cli' +
    '\n  The npm package ships the prebuilt binary via the kimi-code-rust package' +
    '\n  (packages/kimi-code-rust-bin; see its README for pack instructions).',
  );
  process.exit(1);
}
