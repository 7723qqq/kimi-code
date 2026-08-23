import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bunAssets } from './bun-assets.gen';

const assets: Record<string, string> = {};
for (const [key, path] of bunAssets) {
  assets[key] = path;
}
(
  globalThis as unknown as { __KIMI_BUN_ASSETS__?: Record<string, string> }
).__KIMI_BUN_ASSETS__ = assets;

const mainAsset = bunAssets.find(([key]) => key === 'runtime/main.cjs');
if (mainAsset === undefined) {
  throw new Error('Bun bundle is missing the runtime/main.cjs asset');
}
const dir = mkdtempSync(join(tmpdir(), 'kimi-bun-main-'));
const mainPath = join(dir, 'main.cjs');
writeFileSync(mainPath, readFileSync(mainAsset[1]));
await import(pathToFileURL(mainPath).href);
