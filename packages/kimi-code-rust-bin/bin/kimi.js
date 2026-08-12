#!/usr/bin/env node
/**
 * Kimi Code Rust distribution shell — spawn the platform Rust binary.
 *
 * CI packs the built binary next to this script using pack.mjs naming:
 *   bin/kimi-<platform>-<arch>[.exe]
 * (or a generic `kimi`/`kimi.exe` when platform-specific builds are absent).
 *
 * `KIMI_RUST_BIN` overrides the binary path (dev/test use), and a missing
 * binary produces a clear build hint instead of a cryptic spawn error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const exe = process.platform === 'win32' ? '.exe' : '';
const candidates = [
  // pack.mjs default naming: kimi-<platform>-<arch>[.exe]
  `kimi-${process.platform}-${process.arch}${exe}`,
  // generic name for hand-installed builds
  `kimi${exe}`,
  // legacy cross-platform names
  'kimi-win32-x64.exe',
  'kimi.exe',
  'kimi-linux-x64',
  'kimi-darwin-arm64',
  'kimi',
];
const explicit = process.env.KIMI_RUST_BIN;

const binary = explicit ?? candidates.map((c) => join(HERE, c)).find((p) => existsSync(p));

if (!binary) {
  console.error(
    'kimi: Rust binary not found in ' + HERE +
    '\n  Build it with `cargo build --release -p kimi-cli` and copy target/release/kimi(.exe) here, or set KIMI_RUST_BIN.',
  );
  process.exit(1);
}

/**
 * Detect the installing package manager (codex-cli parity): pnpm-owned
 * installs are recognized via `.modules.yaml` in an ancestor node_modules
 * whose realpath points back at this package root; otherwise fall back to
 * npm_config_user_agent / npm_execpath / bun layout heuristics.
 */
function detectPackageManager() {
  const packageRoot = resolve(HERE, '..');
  for (let dir = packageRoot; ; dir = dirname(dir)) {
    const modulesYaml = join(dir, 'node_modules', '.modules.yaml');
    if (existsSync(modulesYaml)) {
      try {
        const linked = realpathSync(join(dir, 'node_modules', '@moonshot-ai', 'kimi-code-rust'));
        if (linked === realpathSync(packageRoot)) return 'pnpm';
      } catch {
        /* not a pnpm-owned kimi-code-rust install */
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
 * (API-only otherwise); inject it when this distribution ships a dist-web
 * next to the wrapper (apps/kimi-code does, the rust-bin package does not).
 */
function forwardArgs(raw) {
  if (raw[0] !== 'web') return raw;
  if (raw.slice(1).includes('--assets')) return raw;
  const distWeb = resolve(HERE, '..', 'dist-web');
  if (!existsSync(distWeb)) return raw;
  return [raw[0], '--assets', distWeb, ...raw.slice(1)];
}

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

const result = spawnSync(binary, forwardArgs(process.argv.slice(2)), { stdio: 'inherit', env });
if (result.error) {
  console.error('kimi: failed to spawn Rust binary:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
