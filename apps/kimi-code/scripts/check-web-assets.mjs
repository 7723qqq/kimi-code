// Verify the prebuilt web bundle is present before packaging.
//
// This repo also carries its own Vue 3 web UI source in apps/kimi-web (a fork
// addition), and the built bundle is committed under apps/kimi-code/dist-web.
// This script replaces the old copy-from-source step — it checks that the
// committed bundle is in place and every asset referenced by index.html exists,
// so a packaging run never silently ships a broken or missing web UI.

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, 'dist-web');

async function assertWebAssets() {
  try {
    const info = await stat(resolve(target, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `未找到已提交的 web 产物 ${target}/index.html。web 产物由 code-app 仓同步（见根 AGENTS.md），` +
        '请在该仓完成同步后将 dist-web 提交到本仓。',
    );
  }

  const indexPath = resolve(target, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const assetPath = match[1];
    if (assetPath === undefined) continue;
    const relativeRef = assetPath.slice(1);
    if (relativeRef.includes('..') || relativeRef.includes('\\')) {
      throw new Error(`Unsafe asset reference in index.html: ${assetPath}`);
    }
    let assetInfo;
    try {
      assetInfo = await stat(resolve(target, relativeRef));
    } catch {
      throw new Error(`Missing referenced web asset: ${target}/${relativeRef}`);
    }
    if (!assetInfo.isFile()) {
      throw new Error(`Referenced web asset is not a file: ${target}/${relativeRef}`);
    }
  }
}

await assertWebAssets();
const files = await readdir(target, { recursive: true });
console.log(`Web assets OK: ${target} (${files.length} entries, synced from code-app)`);
