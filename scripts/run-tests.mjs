#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const PASS_THROUGH = new Set([
  '--shard',
  '--timeout',
  '--coverage',
  '--coverage-reporter',
  '--coverage-dir',
  '--bail',
  '--test-name-pattern',
  '--randomize',
]);

const args = process.argv.slice(2);
const forwarded = [];
let watch = false;
let only = undefined;
let script = 'test';
for (const arg of args) {
  const name = arg.split('=')[0];
  if (name === '--watch') {
    watch = true;
    continue;
  }
  if (name === '--package') {
    only = arg.slice('--package='.length);
    continue;
  }
  if (name === '--script') {
    script = arg.slice('--script='.length);
    continue;
  }
  if (PASS_THROUGH.has(name)) forwarded.push(arg);
}
if (watch) forwarded.push('--watch');
if (args.includes('--include-heavy')) forwarded.push('--path-ignore-patterns=**/node_modules/**');
if (args.some((arg) => arg.startsWith('--shard'))) forwarded.push('--pass-with-no-tests');

const packages = [];
for (const group of ['packages', 'apps', 'apps/vis']) {
  const groupDir = join(ROOT, group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir)) {
    if (name === 'node_modules') continue;
    const dir = join(groupDir, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.scripts?.[script]) continue;
    packages.push({ dir, name: manifest.name });
  }
}

packages.sort((a, b) => a.name.localeCompare(b.name));

const selected = only === undefined ? packages : packages.filter((pkg) => pkg.name === only || pkg.dir.endsWith(only));

if (selected.length === 0) {
  process.stderr.write(`no package matched --package=${String(only)}\n`);
  process.exit(1);
}

if (watch) {
  const children = selected.map((pkg) => {
    const label = pkg.dir.slice(ROOT.length + 1).replace(/\\/g, '/');
    process.stdout.write(`\n=== ${pkg.name} (${label}) ===\n`);
    return Bun.spawn(['bun', 'run', script, '--', ...forwarded], {
      cwd: pkg.dir,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: process.env,
    });
  });
  await Promise.all(children.map((child) => child.exited));
  process.exit(0);
}

const failures = [];
for (const pkg of selected) {
  const label = pkg.dir.slice(ROOT.length + 1).replace(/\\/g, '/');
  process.stdout.write(`\n=== ${pkg.name} (${label}) ===\n`);
  const result = spawnSync('bun', ['run', script, ...(forwarded.length > 0 ? ['--', ...forwarded] : [])], {
    cwd: pkg.dir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) failures.push({ name: pkg.name, status: result.status ?? 1 });
}

process.stdout.write('\n');
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`FAILED ${failure.name} (exit ${failure.status})\n`);
  process.exit(1);
}
process.stdout.write(`all ${selected.length} package suites passed\n`);
