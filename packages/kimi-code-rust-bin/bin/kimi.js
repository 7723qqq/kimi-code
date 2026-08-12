#!/usr/bin/env node
/**
 * Kimi Code Rust distribution shell — spawn the platform Rust binary.
 *
 * The binary is distributed codex-style as a per-platform package
 * `@moonshot-ai/kimi-code-<platform>-<arch>` with the binary at
 * `<pkg>/vendor/<platform>-<arch>/bin/kimi[.exe]`; legacy installs that
 * injected the binary into this package's `bin/` (pack.mjs naming:
 * `kimi-<platform>-<arch>[.exe]`, or a generic `kimi`/`kimi.exe`) still
 * work via the fallback candidates.
 *
 * `KIMI_RUST_BIN` overrides the binary path (dev/test use), and a missing
 * binary produces a clear reinstall hint instead of a cryptic spawn error.
 * `KIMI_ENTRY_DEBUG=1` logs which path was chosen.
 */
import { spawnSync } from 'node:child_process';
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
 *      error and fails fast.
 *   2. The platform package `@moonshot-ai/kimi-code-<platform>-<arch>` is
 *      located via `require.resolve`; the binary lives at
 *      `<pkg>/vendor/<platform>-<arch>/bin/kimi[.exe]`.
 *   3. Fall back to legacy local candidates in this package's `bin/` (old
 *      injected layout).
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
    // legacy cross-platform names
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

const { path: binary, source } = resolvePlatformBinary();
debug(`binary from ${source}: ${binary}`);

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
