#!/usr/bin/env node
/**
 * Recursively resolve workspace dependencies starting from apps/kimi-code
 * and verify they are all present in flake.nix workspacePaths.
 *
 * Exit code 0 if everything is in sync, 1 otherwise.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FLAKE_NIX = join(ROOT, 'flake.nix');
const START_PKG = '@moonshot-ai/kimi-code';

/**
 * Read the workspace directory globs from the root package.json.
 */
function getWorkspaceGlobs() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.workspaces?.packages ?? [];
}

/**
 * Expand globs like "packages/*" into actual directories. Negative globs
 * ("!dir" / "!dir/*") exclude their matches.
 */
function expandGlobsSafe(globs) {
  const dirs = new Set();
  const excluded = new Set();
  for (const g of globs) {
    const negated = g.startsWith('!');
    const pattern = negated ? g.slice(1) : g;
    const matched = [];
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const basePath = join(ROOT, base);
      if (!existsSync(basePath)) continue;
      for (const entry of readdirSync(basePath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          matched.push(join(base, entry.name).replaceAll('\\', '/'));
        }
      }
    } else {
      const p = join(ROOT, pattern);
      if (existsSync(p)) {
        matched.push(pattern);
      }
    }
    for (const dir of matched) {
      if (negated) excluded.add(dir);
      else dirs.add(dir);
    }
  }
  for (const dir of excluded) dirs.delete(dir);
  return [...dirs];
}

/**
 * Build a map of package name -> relative directory for all workspace packages.
 */
function buildWorkspaceMap(dirs) {
  const map = new Map();
  for (const dir of dirs) {
    const pkgPath = join(ROOT, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.name) {
      map.set(pkg.name, dir);
    }
  }
  return map;
}

/**
 * Recursively collect all workspace dependencies (transitive closure).
 */
function resolveWorkspaceDeps(workspaceMap, startName) {
  const visited = new Set();
  const closure = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);

    const dir = workspaceMap.get(name);
    if (!dir) return;

    const pkgPath = join(ROOT, dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const depSections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];

    for (const section of depSections) {
      if (!section) continue;
      for (const [depName, specifier] of Object.entries(section)) {
        if (
          typeof specifier === 'string' &&
          (specifier.includes('workspace') || specifier.startsWith('link:'))
        ) {
          closure.add(depName);
          visit(depName);
        }
      }
    }
  }

  visit(startName);
  return closure;
}

/**
 * Parse workspacePaths from flake.nix.
 */
function parseFlakeNix() {
  const content = readFileSync(FLAKE_NIX, 'utf8');

  const regex = /workspacePaths\s*=\s*\[(.*?)\]/s;
  const match = content.match(regex);
  if (!match) {
    throw new Error('Could not find workspacePaths in flake.nix');
  }
  const items = [];
  const itemRegex = /\.\/[^\s\]]+/g;
  let m;
  while ((m = itemRegex.exec(match[1])) !== null) {
    items.push(m[0]);
  }
  return items;
}

function main() {
  const globs = getWorkspaceGlobs();
  const dirs = expandGlobsSafe(globs);
  const workspaceMap = buildWorkspaceMap(dirs);

  if (!workspaceMap.has(START_PKG)) {
    console.error(`Start package ${START_PKG} not found in workspace.`);
    process.exit(1);
  }

  const closure = resolveWorkspaceDeps(workspaceMap, START_PKG);
  /** @type {string[]} */
  const closureNames = [...closure].toSorted((a, b) => a.localeCompare(b));

  const flakePaths = parseFlakeNix();
  const flakePathSet = new Set(flakePaths);

  /** @type {Array<{name: string, path: string}>} */
  const missingPaths = [];
  for (const name of closureNames) {
    const dir = workspaceMap.get(name);
    if (dir && !flakePathSet.has(`./${dir}`)) {
      missingPaths.push({ name, path: `./${dir}` });
    }
  }

  // Also check that the start package itself is in flake.nix
  const startDir = workspaceMap.get(START_PKG);
  if (startDir && !flakePathSet.has(`./${startDir}`)) {
    missingPaths.unshift({ name: START_PKG, path: `./${startDir}` });
  }

  const ok = missingPaths.length === 0;

  if (!ok) {
    console.error('❌ flake.nix workspacePaths is out of sync.\n');

    console.error('The following workspace paths are missing from flake.nix workspacePaths:');
    for (const { name, path } of missingPaths) {
      console.error(`  - ${path}  (${name})`);
    }

    console.error('\nPlease add the missing entries to workspacePaths in flake.nix.');
    console.error(`\nExpected workspacePaths (${flakePaths.length + missingPaths.length} total):`);
    const expectedPaths = new Set([...flakePaths, ...missingPaths.map((m) => m.path)]);
    for (const p of [...expectedPaths].toSorted((a, b) => a.localeCompare(b))) {
      console.error(`  ${p}`);
    }

    process.exit(1);
  }

  console.log(
    `✅ All ${closureNames.length} recursive workspace dependencies are present in flake.nix.`,
  );
}

main();
