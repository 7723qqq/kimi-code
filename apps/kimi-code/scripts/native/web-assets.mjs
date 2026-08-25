import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { toPosixPath, listFiles, sha256 } from './fs-utils.mjs';
import {
  WEB_ASSET_MANIFEST_VERSION,
  buildWebAssetKey,
  buildWebManifestKey,
} from './manifest.mjs';

export { WEB_ASSET_MANIFEST_VERSION };

const WEB_ASSETS_DIR = 'dist-web';

async function assertBuiltAssetRoot({ assetRoot, requiredFile, message }) {
  const requiredPath = join(assetRoot, requiredFile);
  let info;
  try {
    info = await stat(requiredPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(message);
  }
  if (!info.isFile()) {
    throw new Error(`${requiredFile} is not a file`);
  }
}

export function webAssetManifestKey(target) {
  return buildWebManifestKey(target);
}

function webAssetKey(target, relativePath) {
  return buildWebAssetKey(target, relativePath);
}

async function collectAssetRoot({
  appRoot,
  target,
  root,
  requiredFile,
  missingMessage,
  assetKey,
}) {
  const assetRoot = resolve(appRoot, ...root.split('/'));
  await assertBuiltAssetRoot({ assetRoot, requiredFile, message: missingMessage });

  // Codepoint order, not localeCompare — the manifest bytes hash into the
  // runtime cache root and must not vary with host ICU.
  const files = (await listFiles(assetRoot)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const manifestFiles = [];
  const assets = {};

  for (const file of files) {
    if (!existsSync(file)) continue;
    const bytes = await readFile(file);
    const relativePath = toPosixPath(relative(assetRoot, file));
    const key = assetKey(target, relativePath);
    manifestFiles.push({
      assetKey: key,
      relativePath,
      sha256: sha256(bytes),
    });
    assets[key] = file;
  }

  const manifest = {
    version: WEB_ASSET_MANIFEST_VERSION,
    target,
    root,
    files: manifestFiles,
  };

  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    assets,
  };
}

export async function collectWebAssets({ appRoot, target }) {
  return collectAssetRoot({
    appRoot,
    target,
    root: WEB_ASSETS_DIR,
    requiredFile: 'index.html',
    missingMessage:
      `Kimi web build output was not found at ${resolve(appRoot, WEB_ASSETS_DIR)}. ` +
      'dist-web is a committed bundle synced from the code-app repo — complete the sync in ' +
      'that repo and commit dist-web before building the native binary. ' +
      `App root: ${appRoot}`,
    assetKey: webAssetKey,
  });
}
