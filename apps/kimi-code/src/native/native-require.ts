import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  ensureNativeAssetTree,
  getNativePackageRoot,
  type NativeAssetOptions,
} from './native-assets';

export function createNativePackageRequire(
  packageName: string,
  options: NativeAssetOptions = {},
): ReturnType<typeof createRequire> | null {
  const packageRoot = getNativePackageRoot(packageName, options);
  if (packageRoot === null) return null;

  const cacheRoot = ensureNativeAssetTree(options);
  if (cacheRoot === null) return null;

  return createRequire(join(cacheRoot, 'node_modules', '.kimi-native-entry.cjs'));
}

export function loadNativePackage<T>(
  packageName: string,
  options: NativeAssetOptions = {},
): T | null {
  const nativeRequire = createNativePackageRequire(packageName, options);
  if (nativeRequire === null) return null;
  return nativeRequire(packageName) as T;
}

/**
 * Probe whether the Rust native tools addon is loadable in this process.
 *
 * `'rust'` — the addon loads (built / bundled / SEA-injected); `'js'` — the
 * TypeScript fallback is in effect. Shown in the `/status` report so users
 * can see which implementation they are actually running.
 *
 * The probe result is cached for the process lifetime: the addon cannot
 * become loadable/unloadable after startup, and re-probing would re-verify
 * every cached native asset (full read + sha256 per file) on each call.
 */
let cachedNativeToolsStatus: 'rust' | 'js' | undefined;

export function nativeToolsStatus(): 'rust' | 'js' {
  if (cachedNativeToolsStatus !== undefined) return cachedNativeToolsStatus;
  cachedNativeToolsStatus = probeNativeToolsStatus();
  return cachedNativeToolsStatus;
}

function probeNativeToolsStatus(): 'rust' | 'js' {
  try {
    const nativeRequire = createNativePackageRequire('@moonshot-ai/kimi-native-tools');
    if (nativeRequire === null) return 'js';
    const mod = nativeRequire('@moonshot-ai/kimi-native-tools') as unknown;
    return mod !== null && mod !== undefined ? 'rust' : 'js';
  } catch {
    return 'js';
  }
}
