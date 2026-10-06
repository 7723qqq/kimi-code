#!/usr/bin/env bun

// Dependency versions that the workspace catalog already pins.
//
// The root `workspaces.catalog` is the single place a shared dependency's range
// is declared. A package that repeats the range instead of writing `catalog:`
// still resolves today, but the next bump has to be made in two places, and the
// one that is missed is the one that ships.
//
// A range the catalog does not declare is fine — this check only reports a
// declared range that disagrees with the catalog's, which is the case where the
// two could silently drift apart.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/// `apps/kimi-web` installs from its own lockfile outside the root workspace,
/// so `catalog:` does not resolve there and its ranges are its own business.
const OUTSIDE_WORKSPACE = ['apps/kimi-web/'];

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function workspaceManifests() {
  const out = [];
  for (const parent of ['packages', 'apps']) {
    const dir = join(REPO_ROOT, parent);
    if (!existsSync(dir)) continue;
    for (const child of readdirSync(dir)) {
      const manifest = join(dir, child, 'package.json');
      if (existsSync(manifest)) out.push(manifest);
    }
  }
  for (const extra of ['apps/vis/server', 'apps/vis/web', 'docs']) {
    const manifest = join(REPO_ROOT, extra, 'package.json');
    if (existsSync(manifest)) out.push(manifest);
  }
  return out;
}

export function findViolations() {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const catalog = root.workspaces?.catalog ?? {};
  const violations = [];

  for (const manifest of workspaceManifests()) {
    const rel = relative(REPO_ROOT, manifest);
    if (OUTSIDE_WORKSPACE.some((p) => rel.startsWith(p))) continue;

    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const section of SECTIONS) {
      const deps = pkg[section];
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        const pinned = catalog[name];
        if (pinned === undefined) continue;
        if (range === 'catalog:') continue;
        // A range identical to the catalog's resolves the same way; writing it
        // out is redundant but not yet drift, so only a differing range is a
        // violation the catalog cannot explain.
        if (range === pinned) continue;
        violations.push({
          file: rel,
          message: `${section}.${name} is "${String(range)}" while the catalog pins "${String(pinned)}" — write "catalog:"`,
        });
      }
    }
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('check-catalog-versions: OK');
    return 0;
  }
  for (const v of violations) console.error(`${v.file}: ${v.message}`);
  console.error(`\ncheck-catalog-versions: ${violations.length} violation(s)`);
  return 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) process.exit(main());
