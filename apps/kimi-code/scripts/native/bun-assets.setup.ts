import { bunAssets } from './bun-assets.gen';

// Populated before the statically bundled runtime executes: ESM modules
// evaluate depth-first in import-declaration order, and bun-entry.ts imports
// this module before ./main.cjs.
const assets: Record<string, string> = {};
for (const [key, path] of bunAssets) {
  if (key in assets) {
    throw new Error(`Duplicate Bun embedded asset key: ${key}`);
  }
  assets[key] = path;
}
(
  globalThis as unknown as { __KIMI_BUN_ASSETS__?: Record<string, string> }
).__KIMI_BUN_ASSETS__ = assets;
