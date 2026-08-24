import { readFileSync } from 'node:fs';

import type { NativeAssetSource } from './native-assets';

interface BunAssetsGlobal {
  __KIMI_BUN_ASSETS__?: Readonly<Record<string, string>>;
}

export function getBunEmbeddedAssetSource(): NativeAssetSource | null {
  const assets = (globalThis as unknown as BunAssetsGlobal).__KIMI_BUN_ASSETS__;
  if (assets === undefined) return null;
  const keys = Object.keys(assets);
  if (keys.length === 0) return null;
  return {
    getAssetKeys: () => Object.keys(assets),
    getRawAsset: (assetKey) => {
      const path = assets[assetKey];
      if (path === undefined) {
        throw new Error(`Unknown Bun embedded asset: ${assetKey}`);
      }
      return readFileSync(path);
    },
  };
}
