import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { toPosixPath, listFiles, sha256 } from './fs-utils.mjs';
import {
  KAP_SEARCH_WORKER_ASSET,
  MINIDB_TEXT_BUILD_WORKER_ASSET,
  NATIVE_ASSET_MANIFEST_VERSION,
  buildAssetKey,
  buildManifestKey,
  buildRuntimeAssetKey,
} from './manifest.mjs';
import { PI_TUI_PACKAGE_NAME, resolveTargetDeps } from './native-deps.mjs';
import { nativeBinDir, nativeIntermediatesDir } from './paths.mjs';

export { NATIVE_ASSET_MANIFEST_VERSION };

const jsExtensions = ['.js', '.cjs', '.mjs', '.json', '.node'];
const runtimeEntryNames = ['index.js', 'index.cjs', 'index.mjs'];

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function resolvePackageRootGeneric(
  requireFromApp,
  packageName,
  parentPackageName,
  appRoot,
  target,
) {
  try {
    return dirname(requireFromApp.resolve(`${packageName}/package.json`));
  } catch (rootError) {
    if (parentPackageName !== null) {
      try {
        const parentPackageJsonPath = realpathSync(
          requireFromApp.resolve(`${parentPackageName}/package.json`),
        );
        const requireFromParent = createRequire(pathToFileURL(parentPackageJsonPath));
        return dirname(requireFromParent.resolve(`${packageName}/package.json`));
      } catch {}
    }
    fail(
      [
        `Native asset package is not installed for target ${target}: ${packageName}`,
        parentPackageName ? `Searched via parent: ${parentPackageName}` : '',
        `Resolve root: ${appRoot}`,
        'Run bun install --frozen-lockfile before building native assets.',
        rootError instanceof Error ? rootError.message : String(rootError),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function resolveFileCandidate(path) {
  if (existsSync(path)) return path;
  for (const extension of jsExtensions) {
    const candidate = `${path}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const entryName of runtimeEntryNames) {
    const candidate = join(path, entryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePackageEntry(packageRoot, packageJson) {
  const rawMain =
    typeof packageJson.main === 'string'
      ? packageJson.main
      : typeof packageJson.module === 'string'
        ? packageJson.module
        : 'index.js';
  return resolveFileCandidate(resolve(packageRoot, rawMain));
}

function relativeRuntimeSpecifiers(text) {
  const specifiers = new Set();
  for (const match of text.matchAll(/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/(?<![.\w])import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]);
  }
  for (const match of text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function addRuntimeDependencyFiles(packageRoot, filePath, selected) {
  const extension = extname(filePath);
  if (!['.js', '.cjs', '.mjs'].includes(extension)) return;

  const text = await readFile(filePath, 'utf-8');

  for (const specifier of relativeRuntimeSpecifiers(text)) {
    const candidate = resolveFileCandidate(resolve(dirname(filePath), specifier));
    if (candidate === null) continue;
    if (candidate.endsWith('.node')) continue;
    const packageRelativePath = relative(packageRoot, candidate);
    if (
      packageRelativePath.startsWith('..') ||
      isAbsolute(packageRelativePath) ||
      packageRelativePath.length === 0
    ) {
      continue;
    }
    if (selected.has(candidate)) continue;
    selected.add(candidate);
    await addRuntimeDependencyFiles(packageRoot, candidate, selected);
  }
}

async function collectPackageFiles({
  packageName,
  packageRoot,
  includeNativeFiles,
  includeEntryJs = true,
  requireEntryJs = false,
  nativeFileRelatives = [],
}) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const selected = new Set([packageJsonPath]);

  if (includeEntryJs) {
    const entry = resolvePackageEntry(packageRoot, packageJson);
    if (entry === null) {
      // `native-files` packages may legitimately lack a JS entry: kimi-agent
      // pre-bundles its runtime JS into main.cjs and ships only the .node
      // binary. Modes whose extracted tree must be requireable fail hard.
      if (requireEntryJs) {
        fail(`Native package ${packageName} has no resolvable entry point at ${packageRoot}`);
      }
    } else {
      selected.add(entry);
      await addRuntimeDependencyFiles(packageRoot, entry, selected);
    }
  }

  for (const nativeFileRelative of nativeFileRelatives) {
    const nativeFile = resolve(packageRoot, nativeFileRelative);
    if (!existsSync(nativeFile)) {
      fail(
        `Native package ${packageName} does not contain ${nativeFileRelative} at ${packageRoot}`,
      );
    }
    selected.add(nativeFile);
  }

  if (includeNativeFiles) {
    const files = await listFiles(packageRoot);
    for (const file of files) {
      if (file.endsWith('.node')) {
        selected.add(file);
      }
    }
  }

  // Codepoint order, not localeCompare — the manifest bytes hash into the
  // runtime cache root and must not vary with host ICU.
  const sorted = [...selected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (includeNativeFiles && !sorted.some((file) => file.endsWith('.node'))) {
    fail(`Native package ${packageName} does not contain a .node file at ${packageRoot}`);
  }
  return sorted;
}

async function packageManifestEntries({ packageName, packageRoot, files, target }) {
  const root = `node_modules/${packageName}`;
  const entries = [];
  const assets = {};

  for (const file of files) {
    const sourceBytes = await readFile(file);
    // Preserve the POSIX mode so extracted executables (e.g. node-pty's
    // darwin spawn-helper) stay executable after extraction.
    const mode = (await stat(file)).mode & 0o777;
    const packageRelativePath = toPosixPath(relative(packageRoot, file));
    const relativePath = `${root}/${packageRelativePath}`;
    const assetKey = buildAssetKey(target, root, packageRelativePath);
    entries.push({
      assetKey,
      relativePath,
      sha256: sha256(sourceBytes),
      // JSON.stringify drops undefined keys, so 0o644 entries stay unchanged.
      mode: mode === 0o644 ? undefined : mode,
    });
    assets[assetKey] = file;
  }

  return {
    packageManifest: {
      name: packageName,
      root,
      files: entries,
    },
    assets,
  };
}

export const nativeAssetManifestKey = buildManifestKey;

export async function collectNativeAssets({ appRoot, target }) {
  const requireFromApp = createRequire(pathToFileURL(resolve(appRoot, 'package.json')));
  const targetDeps = resolveTargetDeps(target); // throws on unsupported target

  const manifestPackages = [];
  const assets = {};

  for (const dep of targetDeps) {
    const packageRoot = resolvePackageRootGeneric(
      requireFromApp,
      dep.resolvedName,
      dep.parentName,
      appRoot,
      target,
    );
    const files = await collectPackageFiles({
      packageName: dep.resolvedName,
      packageRoot,
      includeNativeFiles: dep.collect === 'native-files',
      includeEntryJs: dep.collect !== 'native-file-only',
      requireEntryJs: dep.collect === 'js-only' || dep.collect === 'js-and-native-file',
      nativeFileRelatives: dep.nativeFileRelatives,
    });
    const result = await packageManifestEntries({
      packageName: dep.resolvedName,
      packageRoot,
      files,
      target,
    });
    manifestPackages.push(result.packageManifest);
    Object.assign(assets, result.assets);
  }

  const runtimeFiles = [];
  for (const [fileName, asset] of [
    ['text-build-worker.mjs', MINIDB_TEXT_BUILD_WORKER_ASSET],
    ['search-worker.mjs', KAP_SEARCH_WORKER_ASSET],
  ]) {
    const workerSource = resolve(nativeIntermediatesDir(), fileName);
    const workerBytes = await readFile(workerSource);
    const workerAssetKey = buildRuntimeAssetKey(target, asset.key);
    runtimeFiles.push({
      key: asset.key,
      assetKey: workerAssetKey,
      relativePath: asset.relativePath,
      sha256: sha256(workerBytes),
      mode: asset.mode,
    });
    assets[workerAssetKey] = workerSource;
  }

  const manifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target,
    packages: manifestPackages,
    runtimeFiles,
  };

  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    assets,
  };
}

/**
 * Map the collected pi-tui helper files onto the exec-side layout
 * (`<binDir>/native/<os>/prebuilds/<arch>/<helper>.node`).
 *
 * pi-tui's own loader (packages/pi-tui/src/native-modifiers.ts) and the
 * packaged-build smoke (src/native/smoke.ts) both look for the platform helper
 * directly next to the executable, a layout the embedded-asset cache (which
 * unpacks everything under node_modules/<pkg>/...) does not produce. Only
 * .node files under the package's native/ tree map there; Linux collects no
 * helper, so the result is empty and staging is a no-op.
 */
export function execSideHelperTargets(manifest) {
  const pkg = manifest.packages.find((entry) => entry.name === PI_TUI_PACKAGE_NAME);
  if (pkg === undefined) return [];
  const rootPrefix = `${pkg.root}/`;
  const targets = [];
  for (const file of pkg.files) {
    // relativePath is already POSIX-normalized where manifests are built
    // (toPosixPath in packageManifestEntries), so no separator conversion here.
    if (!file.relativePath.startsWith(rootPrefix)) continue;
    const packageRelativePath = file.relativePath.slice(rootPrefix.length);
    if (!packageRelativePath.startsWith('native/') || !packageRelativePath.endsWith('.node')) {
      continue;
    }
    targets.push({ assetKey: file.assetKey, relativePath: packageRelativePath });
  }
  return targets;
}

/**
 * Copy the collected pi-tui helpers into the exec-side layout next to the
 * built binary. Called by build-bun.mjs after the executable exists.
 */
export async function stageExecSideNativeHelpers({ target, manifest, assets, binDir }) {
  const resolvedBinDir = binDir ?? nativeBinDir(target);
  const staged = [];
  for (const entry of execSideHelperTargets(manifest)) {
    const sourcePath = assets[entry.assetKey];
    if (sourcePath === undefined) {
      fail(`Collected asset is missing for exec-side helper ${entry.assetKey}`);
    }
    const destination = resolve(resolvedBinDir, ...entry.relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
    staged.push(relative(resolvedBinDir, destination));
  }
  if (staged.length > 0) {
    console.log(`Staged exec-side helpers for ${target}: ${staged.join(', ')}`);
  }
  return staged;
}
