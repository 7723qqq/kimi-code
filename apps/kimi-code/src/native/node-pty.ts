import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NativeAssetOptions } from './native-assets';
import { getNativePackageRoot } from './native-assets';
import { loadNativePackage } from './native-require';

declare const __KIMI_CODE_NATIVE_BUNDLE__: boolean | undefined;

const nodeRequire = createRequire(import.meta.url);
const isNativeBundle =
  typeof __KIMI_CODE_NATIVE_BUNDLE__ === 'boolean' && __KIMI_CODE_NATIVE_BUNDLE__;

export interface NodePtyModule {
  spawn: (...args: unknown[]) => unknown;
}

/**
 * Load node-pty, preferring the copy extracted into the packaged-build asset
 * cache. A bundled copy cannot work in single-file builds: its binding
 * requires resolve relative to the bundle file, which exists at neither
 * runtime layout — so packaged builds keep it external and resolve it here.
 * Two cache strategies are attempted because Bun's compiled binaries fail
 * bare-name resolution from the cache's require shim; loading the package
 * entry by absolute path always works. Dev and npm installs have no packaged
 * asset source and fall through to a plain require.
 */
export function loadNodePty(options: NativeAssetOptions = {}): NodePtyModule | null {
  const failures: string[] = [];
  const report = (stage: string, error: unknown): void => {
    failures.push(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
  };

  const root = getNativePackageRoot('node-pty', options);
  if (root !== null) {
    try {
      const cached = loadNativePackage<NodePtyModule>('node-pty', options);
      if (cached !== null && typeof cached.spawn === 'function') return cached;
    } catch (error) {
      report('cache-shim', error);
    }
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
        main?: string;
      };
      const entry = typeof pkg.main === 'string' && pkg.main.length > 0 ? pkg.main : 'index.js';
      const direct = createRequire(import.meta.url)(join(root, entry)) as NodePtyModule;
      if (typeof direct.spawn === 'function') return direct;
    } catch (error) {
      report('cache-entry', error);
    }
  }

  if (isNativeBundle) {
    if (failures.length > 0) {
      process.stderr.write(`kimi: node-pty asset-cache load failed (${failures.join('; ')})\n`);
    }
    return null;
  }
  try {
    return nodeRequire('node-pty') as NodePtyModule;
  } catch {
    return null;
  }
}
