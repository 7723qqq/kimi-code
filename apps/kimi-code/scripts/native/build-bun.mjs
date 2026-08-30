import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { fail, run, tryRun } from './exec.mjs';
import {
  appRoot,
  nativeBinPath,
  nativeIntermediatesDir,
  nativeJsBundlePath,
  nativeManifestDir,
  nativeStdioCliPath,
  nativeStdioCliName,
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
  fail(`Unknown profile: ${profile}. Expected 'local' or 'release'.`);
}

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

/**
 * Stage a platform-native `kimi-agent-cli` (.exe) next to the compiled
 * executable so the engine's stdio JSON-RPC fallback survives into a release
 * bundle. The cargo artifact comes from a local `cargo build --release
 * --features cli` — build:native runs on the host platform, so the cargo
 * triple always matches the current Bun target; CI builds it explicitly
 * before these steps. A missing binary is logged loudly but not fatal: the
 * napi transport (the primary path) keeps working.
 */
function stageStdioCli(target) {
  const cliName = nativeStdioCliName();
  // `appRoot` is apps/kimi-code; the cargo workspace root is two levels up.
  const source = resolve(appRoot, '..', '..', 'packages/kimi-agent/target/release', cliName);
  if (!existsSync(source)) {
    console.warn(
      `==> kimi-agent stdio CLI not found at ${source}; the release bundle will not ` +
        'include the stdio fallback. Run `cd packages/kimi-agent && cargo build ' +
        '--release --features cli` before packaging to include it.',
    );
    return;
  }
  const dest = nativeStdioCliPath(target);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  console.log(`==> Staged stdio CLI: ${dest}`);
}

async function buildBunNative() {
  // Bun is the canonical build orchestrator for this pipeline: tsdown emits
  // different bytes under node-vs-bun runners, so artifacts must all come
  // from one orchestrator to stay reproducible.

  const target = targetTriple();
  const bunTarget = BUN_TARGETS.get(target);
  if (bunTarget === undefined) {
    fail(`Unsupported Bun native target: ${target}`);
  }

  console.log(`==> Bun native build (target=${target}, profile=${profile})`);

  if (profile === 'release' && process.env[BUILT_IN_CATALOG_ENV] === undefined) {
    const catalogPath = resolve(nativeIntermediatesDir(), 'built-in-catalog.json');
    const built = await tryRun(process.execPath, [
      resolve(appRoot, 'scripts/update-catalog.mjs'),
      '--out',
      catalogPath,
    ]);
    if (built) {
      process.env[BUILT_IN_CATALOG_ENV] = catalogPath;
    } else {
      console.warn('Built-in catalog unavailable; continuing without it');
    }
  }

  await runBundleStep();

  const stageRoot = join(nativeIntermediatesDir(), 'bun-stage', target);
  mkdirSync(stageRoot, { recursive: true });

  console.log('==> Collecting assets');
  const native = await collectNativeAssets({ appRoot, target });
  const web = await collectWebAssets({ appRoot, target });

  const entries = [];
  // Flattening '/' -> '__' is lossy ('a/b__c' vs 'a/b/c'), so distinct keys
  // can map to the same staged filename; refuse to silently overwrite.
  const stagedFiles = new Map();
  const putAsset = (key, srcPath) => {
    const dest = join(stageRoot, `${key.replaceAll('/', '__')}${ASSET_SUFFIX}`);
    const collision = stagedFiles.get(dest);
    if (collision !== undefined) {
      fail(`Asset key collision after flattening: '${key}' and '${collision}' both map to ${dest}`);
    }
    stagedFiles.set(dest, key);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(srcPath, dest);
    entries.push([key, dest]);
  };

  const nativeManifestPath = join(nativeManifestDir(target), 'manifest.json');
  mkdirSync(dirname(nativeManifestPath), { recursive: true });
  writeFileSync(nativeManifestPath, native.manifestJson);
  putAsset(nativeAssetManifestKey(target), nativeManifestPath);

  const webManifestPath = join(nativeIntermediatesDir(), 'web-assets', target, 'manifest.json');
  mkdirSync(dirname(webManifestPath), { recursive: true });
  writeFileSync(webManifestPath, web.manifestJson);
  putAsset(webAssetManifestKey(target), webManifestPath);

  // The runtime bundle is not embedded as a file asset: a shebang-stripped
  // copy is staged below and compiled into the entry module graph, which
  // removes the runtime extraction + dynamic import from the startup path.
  // The original bundle keeps its `#!` banner; only the staged copy handed to
  // the Bun compile step is rewritten.
  const stageMainPath = join(stageRoot, 'main.cjs');
  writeFileSync(
    stageMainPath,
    readFileSync(nativeJsBundlePath(), 'utf8').replace(/^#![^\n]*\r?\n/, ''),
  );
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
  copyFileSync(
    join(appRoot, 'scripts', 'native', 'bun-assets.setup.ts'),
    join(stageRoot, 'bun-assets.setup.ts'),
  );

  const outfile = nativeBinPath(target);
  mkdirSync(dirname(outfile), { recursive: true });
  // Bytecode is opt-in: measured no startup gain on this pipeline, and it
  // adds size plus a lock to the exact Bun version that built the artifact.
  // Re-verified on Bun 1.4.0 with --format=esm (bare --bytecode would force
  // CommonJS output): 803 -> 802 ms --version median, +55% binary size.
  // Startup here is bound by runtime init, not module compilation.
  const useBytecode = process.env.KIMI_CODE_BUN_ENABLE_BYTECODE === '1';
  console.log(`==> bun build --compile --target=${bunTarget}${useBytecode ? ' --bytecode' : ''}`);
  const buildArgs = ['build', '--compile', '--target', bunTarget];
  if (useBytecode) {
    buildArgs.push('--bytecode', '--format', 'esm');
  }
  // Compiled executables would otherwise autoload .env / bunfig.toml from the
  // user's cwd at runtime — surprising behavior for a standalone CLI that
  // reads its own config explicitly.
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

  stageStdioCli(target);

  await runSignStep({
    identity: profile === 'release' ? (process.env.APPLE_SIGNING_IDENTITY ?? '-') : '-',
    keychainPath: profile === 'release' ? (process.env.APPLE_KEYCHAIN_PATH ?? null) : null,
  });
  // flake.nix string-matches this exact expression via substituteInPlace; keep the line byte-identical.
  await runVerifyStep({ requireGatekeeper: false });

  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`==> Bun native build complete: ${outfile} (${mb} MB)`);
}

try {
  await buildBunNative();
} catch (error) {
  fail(String(error?.message ?? error));
}
