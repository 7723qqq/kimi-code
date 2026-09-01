#!/usr/bin/env node
// M3 consumer-whitelist guard for `@moonshot-ai/agent-core-v2` (see root
// `ROADMAP.md` §M3). New embedders default to the Rust engine in
// `packages/kimi-agent`; this script fails the build if a non-whitelisted
// package imports v2. The three marked consumers (kap-server, klient,
// acp-server) must also carry the M3 marker in their `package.json`
// `description` field so the load-bearing contract is discoverable.
//
// Run with `bun scripts/check-v2-library-surface.mjs` (or `bun run
// check:v2-library-surface` once wired into `package.json`). Exits 0 on
// pass, 1 on any violation.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKG_NAME = '@moonshot-ai/agent-core-v2';

// Packages that may import v2 as a library (M3 consumer disposition).
// Adding a new package here is an explicit M3 revisit; do not add it
// without a corresponding M3 ROADMAP entry.
const CONSUMER_WHITELIST = new Set([
  'packages/agent-core-v2', // self
  'packages/kap-server',
  'packages/klient',
  'packages/acp-server',
]);

// Apps are explicitly out: `apps/kimi-code` runs the v2 runner for the
// product (a separate v2 host, not a library consumer — see the runner in
// `apps/kimi-code/src/cli/v2/`), and `apps/vis`, `apps/vscode` don't import
// v2 directly. The runner is the M5 deletion path; this lint doesn't
// enforce it.

const MARKER_NEEDLE = 'M3-marked v2 library consumer';

let violations = 0;
function fail(message) {
  console.error(`check:v2-library-surface: ${message}`);
  violations += 1;
}

function listImports(source) {
  const matches = source.matchAll(/from\s+['"]@moonshot-ai\/agent-core-v2(?:\/[^'"]*)?['"]/g);
  return Array.from(matches, (m) => m[0]);
}

function walkPackage(pkgRel) {
  const pkgJson = path.join(ROOT, pkgRel, 'package.json');
  if (!fs.existsSync(pkgJson)) return;
  const isWhitelisted = CONSUMER_WHITELIST.has(pkgRel);
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, PKG_NAME)) {
    // Dep declared but no source-level import — likely transitive or a
    // stale entry. Not a violation by itself but worth surfacing.
  }
  for (const sub of ['src', 'test', 'scripts']) {
    const dir = path.join(ROOT, pkgRel, sub);
    if (!fs.existsSync(dir)) continue;
    walkDir(dir, pkgRel, isWhitelisted);
  }
}

function walkDir(dir, pkgRel, isWhitelisted) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkDir(full, pkgRel, isWhitelisted);
      continue;
    }
  if (!entry.isFile() || !/\.(ts|tsx|js|mjs|cjs|cts|mts)$/.test(entry.name)) continue;
    if (isWhitelisted) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const stmt of listImports(content)) {
      fail(
        `${pkgRel}/${path.relative(path.join(ROOT, pkgRel), full)}: ` +
          `non-whitelisted package imports ${PKG_NAME} (${stmt}). ` +
          `Add to CONSUMER_WHITELIST only via an explicit M3 ROADMAP entry.`,
      );
    }
  }
}

function walkWorkspaces() {
  for (const entry of fs.readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    walkPackage(path.join('packages', entry.name));
  }
}

function checkMarker(pkgRel) {
  const pkgJson = path.join(ROOT, pkgRel, 'package.json');
  if (!fs.existsSync(pkgJson)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const desc = pkg.description ?? '';
  if (!desc.includes(MARKER_NEEDLE)) {
    fail(
      `${pkgRel}/package.json#description must contain "${MARKER_NEEDLE}" — ` +
        'see ROADMAP.md §M3 for the M3 marker contract.',
    );
  }
}

for (const pkg of CONSUMER_WHITELIST) {
  if (pkg === 'packages/agent-core-v2') continue; // self, no marker required
  checkMarker(pkg);
}

walkWorkspaces();

if (violations > 0) {
  console.error(`\ncheck:v2-library-surface: ${violations} violation(s)`);
  process.exit(1);
}
console.log('check:v2-library-surface: OK');
