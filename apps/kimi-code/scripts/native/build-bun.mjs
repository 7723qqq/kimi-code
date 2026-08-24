import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BUILT_IN_CATALOG_ENV } from '../built-in-catalog.mjs';
import { runBundleStep } from './01-bundle.mjs';
import { runSignStep } from './04-sign.mjs';
import { runVerifyStep } from './05-verify.mjs';
import {
  collectNativeAssets,
  nativeAssetManifestKey,
  stageExecSideNativeHelpers,
} from './assets.mjs';
import { run } from './exec.mjs';
import {
  appRoot,
  nativeBinPath,
  nativeIntermediatesDir,
  nativeJsBundlePath,
  targetTriple,
} from './paths.mjs';
import { collectWebAssets, webAssetManifestKey } from './web-assets.mjs';

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'local' },
  },
});

const profile = values.profile;
if (!['local', 'release'].includes(profile)) {
  console.error(`Unknown profile: ${profile}. Expected 'local' or 'release'.`);
  process.exit(1);
}

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
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', exe) : null,
    join(homedir(), '.bun', 'bin', exe),
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

  console.log(`==> Bun native build (target=${target}, profile=${profile})`);

  if (profile === 'release' && process.env[BUILT_IN_CATALOG_ENV] === undefined) {
    const catalogPath = resolve(nativeIntermediatesDir(), 'built-in-catalog.json');
    try {
      await run(process.execPath, [
        resolve(appRoot, 'scripts/update-catalog.mjs'),
        '--out',
        catalogPath,
      ]);
      process.env[BUILT_IN_CATALOG_ENV] = catalogPath;
    } catch (error) {
      console.warn(`Built-in catalog unavailable (${String(error)}); continuing without it`);
    }
  }

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
  // Bytecode is opt-in: measured no startup gain on this pipeline (only the
  // entry shim gets bytecode'd; the main.cjs bundle is imported from disk,
  // outside the bytecode graph), and it adds size plus a lock to the exact
  // Bun version that built the artifact.
  const useBytecode = process.env.KIMI_CODE_BUN_ENABLE_BYTECODE === '1';
  console.log(`==> bun build --compile --target=${bunTarget}${useBytecode ? ' --bytecode' : ''}`);
  const buildArgs = ['build', '--compile', '--target', bunTarget];
  if (useBytecode) {
    buildArgs.push('--bytecode');
  }
  // Compiled executables would otherwise autoload .env / bunfig.toml from the
  // user's cwd at runtime, silently diverging from Node/SEA behavior.
  buildArgs.push('--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig');
  buildArgs.push('--outfile', outfile, join(stageRoot, 'bun-entry.ts'));
  await run(resolveBun(), buildArgs);

  // The embedded assets unpack into the versioned cache under
  // node_modules/<pkg>/..., but pi-tui's helper loader and the packaged smoke
  // also expect the platform helper directly next to the executable.
  await stageExecSideNativeHelpers({
    target,
    manifest: native.manifest,
    assets: native.assets,
  });

  await runSignStep({
    identity: profile === 'release' ? (process.env.APPLE_SIGNING_IDENTITY ?? '-') : '-',
    keychainPath: profile === 'release' ? (process.env.APPLE_KEYCHAIN_PATH ?? null) : null,
  });
  await runVerifyStep({ requireGatekeeper: false });

  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`==> Bun native build complete: ${outfile} (${mb} MB)`);
}

await buildBunNative();
