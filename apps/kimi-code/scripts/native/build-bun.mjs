import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { runBundleStep } from './01-bundle.mjs';
import { collectNativeAssets, nativeAssetManifestKey } from './assets.mjs';
import { run } from './exec.mjs';
import { runSignStep } from './04-sign.mjs';
import {
  appRoot,
  nativeBinPath,
  nativeIntermediatesDir,
  nativeJsBundlePath,
  targetTriple,
} from './paths.mjs';
import { collectWebAssets, webAssetManifestKey } from './web-assets.mjs';

const MAIN_ASSET_KEY = 'runtime/main.cjs';
const ASSET_SUFFIX = '.bin';

const BUN_TARGETS = new Map([
  ['linux-x64', 'bun-linux-x64'],
  ['linux-arm64', 'bun-linux-arm64'],
  ['darwin-x64', 'bun-darwin-x64'],
  ['darwin-arm64', 'bun-darwin-arm64'],
  ['win32-x64', 'bun-windows-x64'],
  ['win32-arm64', 'bun-windows-arm64'],
]);

function resolveBun() {
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', 'bun') : null,
    join(homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
  ].filter((candidate) => candidate !== null && existsSync(candidate));
  return candidates[0] ?? 'bun';
}

async function buildBunNative() {
  if (process.versions.bun !== undefined) {
    console.error('Run this script with Node; the compiled binary itself runs on Bun.');
    process.exit(1);
  }

  const target = targetTriple();
  const bunTarget = BUN_TARGETS.get(target);
  if (bunTarget === undefined) {
    console.error(`Unsupported Bun native target: ${target}`);
    process.exit(1);
  }

  console.log(`==> Bun native build (target=${target})`);
  await runBundleStep();

  const stageRoot = join(nativeIntermediatesDir(), 'bun-stage', target);
  mkdirSync(stageRoot, { recursive: true });

  console.log('==> Collecting assets');
  const native = await collectNativeAssets({ appRoot, target });
  const web = await collectWebAssets({ appRoot, target });

  const entries = [];
  const putAsset = (key, srcPath) => {
    const dest = join(stageRoot, `${key.replaceAll('/', '__')}${ASSET_SUFFIX}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(srcPath, dest);
    entries.push([key, dest]);
  };

  const nativeManifestPath = join(
    nativeIntermediatesDir(),
    'native-assets',
    target,
    'manifest.json',
  );
  mkdirSync(dirname(nativeManifestPath), { recursive: true });
  writeFileSync(nativeManifestPath, native.manifestJson);
  putAsset(nativeAssetManifestKey(target), nativeManifestPath);

  const webManifestPath = join(nativeIntermediatesDir(), 'web-assets', target, 'manifest.json');
  mkdirSync(dirname(webManifestPath), { recursive: true });
  writeFileSync(webManifestPath, web.manifestJson);
  putAsset(webAssetManifestKey(target), webManifestPath);

  putAsset(MAIN_ASSET_KEY, nativeJsBundlePath());
  const packageFileCount = Object.keys(native.assets).length + Object.keys(web.assets).length;
  for (const [key, srcPath] of [...Object.entries(native.assets), ...Object.entries(web.assets)]) {
    putAsset(key, srcPath);
  }
  console.log(`Staged ${entries.length} assets (${packageFileCount} package/web files)`);

  const genLines = [];
  const pairs = [];
  entries.forEach(([key, dest], index) => {
    genLines.push(`import a${index} from ${JSON.stringify(dest)} with { type: 'file' };`);
    pairs.push(`  [${JSON.stringify(key)}, a${index}],`);
  });
  genLines.push('', 'export const bunAssets: Array<[string, string]> = [', ...pairs, '];', '');
  writeFileSync(join(stageRoot, 'bun-assets.gen.ts'), genLines.join('\n'));
  copyFileSync(join(appRoot, 'scripts', 'native', 'bun-entry.ts'), join(stageRoot, 'bun-entry.ts'));

  const outfile = nativeBinPath(target);
  mkdirSync(dirname(outfile), { recursive: true });
  console.log(`==> bun build --compile --target=${bunTarget}`);
  await run(resolveBun(), [
    'build',
    '--compile',
    '--target',
    bunTarget,
    '--outfile',
    outfile,
    join(stageRoot, 'bun-entry.ts'),
  ]);

  await runSignStep();

  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`==> Bun native build complete: ${outfile} (${mb} MB)`);
}

await buildBunNative();
