import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const packageDirs = ['', 'apps', 'packages', 'plugins', 'workbuddy-agents-all'];
const packageFiles = [];

for (const dir of packageDirs) {
  if (dir === '') {
    packageFiles.push('package.json');
    continue;
  }
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    packageFiles.push(join(dir, entry.name, 'package.json'));
  }
}

const forbidden = /^(?:node|node\.exe|npm|npm\.cmd|npx|npx\.cmd|pnpm|pnpm\.cmd|yarn|yarn\.cmd)$/i;
const segments = /(?:&&|\|\||[;|])\s*/;
const failures = [];

for (const file of packageFiles) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, file), 'utf8'));
  } catch {
    continue;
  }
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    for (const segment of command.split(segments)) {
      const token = segment.trim().split(/\s+/, 1)[0];
      if (forbidden.test(token)) {
        failures.push(`${file}: scripts.${name} starts with ${token}`);
      }
    }
  }
}

const entryGlob = new Bun.Glob('{scripts,apps,packages}/**/*.{ts,mts,cts,js,mjs,cjs}');
for (const rel of entryGlob.scanSync({ cwd: root })) {
  if (rel.includes('node_modules')) continue;
  const head = await readFile(join(root, rel), 'utf8').then((text) => text.slice(0, 128), () => '');
  if (head.startsWith('#!/usr/bin/env node') || head.startsWith('#!/usr/bin/node')) {
    failures.push(`${rel}: node shebang`);
  }
}

if (failures.length > 0) {
  process.stderr.write('check-bun-entrypoints: node entrypoints are not allowed\n');
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.exit(1);
}
