#!/usr/bin/env node
/**
 * Pack the built Rust binaries into the platform package vendor layout.
 *
 * Usage:
 *   node scripts/pack.mjs
 *
 * Output layout (per platform package):
 *   packages/kimi-code-<platform>-<arch>/vendor/<platform>-<arch>/bin/kimi[.exe]
 *   packages/kimi-code-<platform>-<arch>/vendor/<platform>-<arch>/bin/kimi-server-serve[.exe]
 *
 * Env vars:
 *   KIMI_RUST_SOURCE — path to the built `kimi` binary
 *                      (default: <repo>/target/release/kimi(.exe))
 *   KIMI_RUST_TARGET — `<platform>-<arch>` vendor target, one of
 *                      linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 /
 *                      win32-x64 / win32-arm64
 *                      (default: `process.platform-process.arch`)
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

const exe = process.platform === 'win32' ? '.exe' : '';
const defaultSource = join(ROOT, 'target', 'release', `kimi${exe}`);
const source = process.env.KIMI_RUST_SOURCE ?? defaultSource;

// Platform target label: `<platform>-<arch>` (npm-style). `process.platform`
// values (win32/darwin/linux) already match the platform package naming.
const defaultTarget = `${process.platform}-${process.arch}`;
const target = process.env.KIMI_RUST_TARGET ?? defaultTarget;

const SUPPORTED_PLATFORMS = ['linux', 'darwin', 'win32'];
const SUPPORTED_ARCHS = ['x64', 'arm64'];
const [platform, arch] = target.split('-');
if (
  !SUPPORTED_PLATFORMS.includes(platform) ||
  !SUPPORTED_ARCHS.includes(arch)
) {
  console.error(
    `kimi-code-rust-bin: unsupported target "${target}"\n` +
      `  Expected <platform>-<arch> with platform in {${SUPPORTED_PLATFORMS.join(', ')}} ` +
      `and arch in {${SUPPORTED_ARCHS.join(', ')}}`,
  );
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(
    `kimi-code-rust-bin: source binary not found at ${source}\n` +
      '  Build it first: `cargo build --release -p kimi-cli`',
  );
  process.exit(1);
}

const targetExe = platform === 'win32' ? '.exe' : '';
const vendorBin = join(
  ROOT,
  'packages',
  `kimi-code-${target}`,
  'vendor',
  target,
  'bin',
);
mkdirSync(vendorBin, { recursive: true });

copyFileSync(source, join(vendorBin, `kimi${targetExe}`));
console.log(`packed ${source} -> ${join(vendorBin, `kimi${targetExe}`)}`);

// Also pack the kimi-server-serve binary (the stdio/WS/HTTP server host) when
// present. It is optional — hosts can point KIMI_SERVER_BIN at a build — but
// shipping it removes the TS-host fallback-to-harness path in release
// packaging (CODEX_MIGRATION_PLAN §1.4 gap 6).
const serveSource = join(
  ROOT,
  'target',
  'release',
  `kimi-server-serve${targetExe}`,
);
if (existsSync(serveSource)) {
  copyFileSync(serveSource, join(vendorBin, `kimi-server-serve${targetExe}`));
  console.log(
    `packed ${serveSource} -> ${join(vendorBin, `kimi-server-serve${targetExe}`)}`,
  );
} else {
  console.warn(
    'kimi-server-serve not found; skipped. Build it with: ' +
      '`cargo build --release -p kimi-server-transport --bin kimi-server-serve`',
  );
}
