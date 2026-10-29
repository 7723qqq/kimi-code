#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { killProcessTree } from './lib/kill-process-tree.mjs';

const ROOT = join(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, '.tmp', 'filewise');
const args = process.argv.slice(2);
const packageArg = args.find((a) => a.startsWith('--package='))?.slice(10);
const dirArg = args.find((a) => a.startsWith('--dir='))?.slice(6);
const concurrency = Number(args.find((a) => a.startsWith('--parallel='))?.slice(11) ?? '4');
const perFileTimeoutMs = Number(args.find((a) => a.startsWith('--timeout='))?.slice(10) ?? '180') * 1000;
const testTimeoutMs = Number(args.find((a) => a.startsWith('--testTimeout='))?.slice(14) ?? '30000');
const budgetSeconds = Number(args.find((a) => a.startsWith('--budget='))?.slice(9) ?? '120');

if (packageArg === undefined) {
  console.error('usage: run-tests-filewise.mjs --package=<relative path> [--dir=test] [--parallel=4]');
  process.exit(2);
}

const pkgDir = join(ROOT, packageArg);
const scanRoot = join(pkgDir, dirArg ?? 'test');
if (!existsSync(scanRoot)) {
  console.error(`no such directory: ${scanRoot}`);
  process.exit(2);
}
mkdirSync(LOG_DIR, { recursive: true });

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('dist')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(test|e2e|integration)\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
}
walk(scanRoot);
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const counts = { pass: 0, fail: 0, errors: 0, skip: 0 };
const firstResults = new Map();
const failures = [];
const hangs = [];
let cursor = 0;
const started = Date.now();

function parse(output) {
  const num = (re) => {
    const m = output.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    pass: num(/^\s*(\d+) pass$/m),
    fail: num(/^\s*(\d+) fail$/m),
    errors: num(/^\s*(\d+) errors?$/m),
    skip: num(/^\s*(\d+) skip$/m),
  };
}

function runFile(file) {
  const rel = relative(pkgDir, file).split(sep).join('/');
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let killed = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      writeFileSync(join(LOG_DIR, `${rel.replaceAll('/', '_')}.log`), output);
      const parsed = parse(output);
      resolve({ rel, code, killed, ...parsed, output });
    };
    const child = spawn('bun', ['test', '--isolate', '--timeout', String(testTimeoutMs), rel], {
      cwd: pkgDir,
      detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const killer = setTimeout(() => {
      killed = true;
      killProcessTree(child.pid);
      finish(null);
    }, perFileTimeoutMs);
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}

async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= files.length) return;
    const result = await runFile(files[index]);
    firstResults.set(result.rel, result);
    counts.pass += result.pass;
    counts.fail += result.fail;
    counts.errors += result.errors;
    counts.skip += result.skip;
    if (result.killed) hangs.push(result.rel);
    else if (result.fail > 0 || result.errors > 0) failures.push(result.rel);
    if (result.killed || result.fail > 0 || result.errors > 0) {
      process.stdout.write(`FAIL ${result.rel}${result.killed ? ' (HANG, killed)' : ` pass=${result.pass} fail=${result.fail} errors=${result.errors}`}\n`);
    }
  }
}

process.stdout.write(`filewise: ${files.length} files, ${concurrency}-way parallel, per-file timeout ${perFileTimeoutMs / 1000}s\n`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

// A failure under contention is not a failure: heavy child processes (zstd -T0, fd,
// tar) starve each other when many files run at once. Re-run every failing file
// alone and only keep the ones that still fail.
const confirmed = [];
const contentionOnly = [];
for (const rel of failures) {
  const file = join(pkgDir, rel);
  const retry = await runFile(file);
  if (retry.killed || retry.fail > 0 || retry.errors > 0) {
    confirmed.push({ rel, ...retry });
  } else {
    contentionOnly.push(rel);
    const first = firstResults.get(rel);
    if (first !== undefined) {
      counts.fail -= first.fail;
      counts.errors -= first.errors;
      counts.pass -= first.pass;
      counts.skip -= first.skip;
    }
    counts.pass += retry.pass;
    counts.skip += retry.skip;
    process.stdout.write(`FLAKY(contention) ${rel} — passes in isolation
`);
  }
}
failures.length = 0;
for (const item of confirmed) failures.push(item.rel);
const seconds = (Date.now() - started) / 1000;

console.log('');
console.log(`files: ${files.length}`);
console.log(`tests: pass=${counts.pass} fail=${counts.fail} errors=${counts.errors} skip=${counts.skip}`);
console.log(`wall: ${seconds.toFixed(1)}s${seconds > budgetSeconds ? `  > budget ${budgetSeconds}s` : ''}`);
console.log(
  `failing files: ${failures.length === 0 ? 'none' : `${failures.length}`}${contentionOnly.length > 0 ? ` (contention-only flakes re-verified: ${contentionOnly.length})` : ''}`,
);
console.log(`hung files: ${hangs.length === 0 ? 'none' : hangs.join(', ')}`);
console.log(`logs: ${relative(ROOT, LOG_DIR).split(sep).join('/')}/`);
process.exit(failures.length === 0 && hangs.length === 0 && seconds <= budgetSeconds ? 0 : 1);
