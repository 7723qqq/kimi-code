import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getHostPackageRoot } from '#/cli/version';
import { getBunEmbeddedAssetSource } from '#/native/bun-assets';
import { resolveCommandPath } from '#/utils/process/resolve-command';

import { NPM_PACKAGE_NAME, type InstallSource } from './types';

/** How the running binary was packaged. `sea` is kept for staged-update
 * records written by older builds; new packaged binaries are always `bun`. */
export type NativeInstallKind = 'sea' | 'bun';

export type NativeInstallDetection =
  | { readonly native: false }
  | { readonly native: true; readonly kind: NativeInstallKind };

// Bun packaged builds are recognized by the embedded-asset marker that
// scripts/native/bun-entry.ts registers.
function detectBunNativeInstall(): NativeInstallDetection | null {
  if ((globalThis as unknown as { Bun?: unknown }).Bun === undefined) return null;
  if (getBunEmbeddedAssetSource() === null) return null;
  return { native: true, kind: 'bun' };
}

/** Runtime packaging detection — native when running as a packaged binary. */
export function detectNativeInstall(): NativeInstallDetection {
  const bun = detectBunNativeInstall();
  if (bun !== null) return bun;
  return { native: false };
}

// Path heuristic markers (compared in lowercase; both forward and backward slashes accepted).
const PNPM_PATH_SEGMENT = 'pnpm/global/';
const YARN_PATH_SEGMENTS = ['.config/yarn/global/', '/.yarn/global/'];
const BUN_PATH_SEGMENT = '.bun/install/global/';
// Homebrew installs formulae under its Cellar directory. Avoid matching the
// broader /homebrew/ prefix — on Apple Silicon, npm itself lives under
// /opt/homebrew/, so `npm install -g` paths also contain /homebrew/.
const HOMEBREW_PATH_SEGMENT = '/cellar/';

function normalizeForHeuristic(filePath: string): string {
  return filePath.replaceAll('\\', '/').toLowerCase();
}

/**
 * Heuristic classification by package root path segments. Returns the
 * matching `InstallSource` or `null` if no heuristic matches (caller should
 * fall through to npm-prefix comparison).
 */
export function classifyByPathHeuristic(packageRoot: string): InstallSource | null {
  const normalized = normalizeForHeuristic(packageRoot);
  if (normalized.includes(PNPM_PATH_SEGMENT)) return 'pnpm-global';
  for (const seg of YARN_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return 'yarn-global';
  }
  if (normalized.includes(BUN_PATH_SEGMENT)) return 'bun-global';
  if (normalized.includes(HOMEBREW_PATH_SEGMENT)) return 'homebrew';
  return null;
}

export interface DetectInstallSourceDeps {
  readonly getPackageRoot: () => string;
  readonly getGlobalPrefix: () => Promise<string>;
  readonly detectNative: () => NativeInstallDetection;
  readonly platform: NodeJS.Platform;
}

function npmCommand(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

// The install-source detection runs before the workspace trust gate, so the
// npm binary must be resolved through PATH to an absolute path — a bare name
// would let cmd.exe pick up an `npm.cmd` planted in the current directory.
function npmGlobalPrefix(platform: NodeJS.Platform): Promise<string> {
  const resolved = resolveCommandPath(npmCommand(platform));
  if (resolved === undefined) {
    return Promise.reject(new Error('npm was not found in PATH'));
  }
  return execFileText(resolved, ['prefix', '-g'], platform).then((text) => text.trim());
}

function execFileText(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    // Windows npm is a .cmd shim. Since the CVE-2024-27980 fix, Node throws
    // EINVAL when spawning a .cmd/.bat without a shell, so run through
    // cmd.exe on win32, quoting the resolved path — a space in it (e.g.
    // C:\Program Files\...) would otherwise split the command. The args are
    // fixed constants, so they are shell-safe.
    execFile(
      platform === 'win32' ? `"${command}"` : command,
      [...args],
      { encoding: 'utf-8', shell: platform === 'win32' ? true : undefined },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function normalizePathForComparison(filePath: string, platform: NodeJS.Platform): string | null {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return null;
  try {
    return normalizeResolvedPath(realpathSync(trimmed), platform);
  } catch {
    return normalizeResolvedPath(resolve(trimmed), platform);
  }
}

function normalizeResolvedPath(filePath: string, platform: NodeJS.Platform): string {
  const resolvedPath = resolve(filePath);
  return platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function candidateGlobalPackageDirs(
  globalPrefix: string,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform === 'win32') {
    return [join(globalPrefix, 'node_modules', NPM_PACKAGE_NAME)];
  }
  return [
    join(globalPrefix, 'lib', 'node_modules', NPM_PACKAGE_NAME),
    join(globalPrefix, 'node_modules', NPM_PACKAGE_NAME),
  ];
}

export function classifyInstallSource(
  packageRoot: string,
  globalPrefix: string,
  platform: NodeJS.Platform = process.platform,
): InstallSource {
  const normalizedPackageRoot = normalizePathForComparison(packageRoot, platform);
  if (normalizedPackageRoot === null) return 'unsupported';

  for (const candidate of candidateGlobalPackageDirs(globalPrefix, platform)) {
    if (normalizePathForComparison(candidate, platform) === normalizedPackageRoot) {
      return 'npm-global';
    }
  }
  return 'unsupported';
}

export async function detectInstallSource(
  deps: Partial<DetectInstallSourceDeps> = {},
): Promise<InstallSource> {
  const platform = deps.platform ?? process.platform;
  const resolved: DetectInstallSourceDeps = {
    getPackageRoot: deps.getPackageRoot ?? getHostPackageRoot,
    getGlobalPrefix: deps.getGlobalPrefix ?? (() => npmGlobalPrefix(platform)),
    detectNative: deps.detectNative ?? detectNativeInstall,
    platform,
  };

  if (resolved.detectNative().native) return 'native';

  const packageRoot = resolved.getPackageRoot();
  const heuristic = classifyByPathHeuristic(packageRoot);
  if (heuristic !== null) return heuristic;

  try {
    const globalPrefix = await resolved.getGlobalPrefix();
    return classifyInstallSource(packageRoot, globalPrefix, resolved.platform);
  } catch {
    return 'unsupported';
  }
}
