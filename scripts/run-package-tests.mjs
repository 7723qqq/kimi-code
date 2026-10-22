#!/usr/bin/env bun
/**
 * Per-file test runner for one workspace package.
 *
 * Why this exists instead of `bun test` directly:
 *
 *  - **Per-file timeout.** `bun test --timeout` bounds a single test body
 *    (and a hanging hook), but nothing bounds a whole file. A file whose
 *    top-level await never settles, or whose process refuses to exit, hangs
 *    the entire package — and with it every CI shard that owns the file.
 *    This runner kills a file that exceeds `--file-timeout` and reports it
 *    as a hang, so the failure is attributable instead of stalling the job.
 *  - **Position-modulo sharding.** Bun's own `--shard=N/M` shards by file
 *    too, but this runner keeps the assignment in one place so a package
 *    with fewer files than shards produces empty shards rather than
 *    duplicated work, and so the same assignment is used for the retry
 *    pass below.
 *  - **Contention retry.** Files that spawn real processes (git, servers,
 *    compressors) starve each other when several run at once, and a failure
 *    under contention is not a failure. Every failing file is re-run alone;
 *    only the ones that still fail are reported.
 *
 * Usage:
 *   bun scripts/run-package-tests.mjs [--package=<dir>] [--root=<dir>]...
 *                               [--shard=N/M] [--parallel=N]
 *                               [--test-timeout=MS] [--file-timeout=MS]
 *                               [--include-heavy]
 *
 * `--timeout` is accepted as an alias for `--test-timeout` so that the root
 * runner can forward one spelling to both this script and plain `bun test`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const ROOT = join(import.meta.dirname, '..');

function flag(name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const packageArg = flag('package');
const PKG_DIR = packageArg === undefined ? process.cwd() : join(ROOT, packageArg);
const shardArg = flag('shard');
// `bun test` runs a package's files in one process, one after another. Upstream
// ran this suite on vitest, which spreads the files over worker threads — one
// per core. Without a matching degree of parallelism the migration would trade
// vitest's speed for bun's serialization, so the default is the same: one file
// per core, minus one so the machine stays responsive.
const defaultParallel = Math.max(
  1,
  (os.availableParallelism?.() ?? os.cpus().length) - 1,
);
const parallel = Number(flag('parallel') ?? defaultParallel);
const includeHeavy = process.env['KIMI_TEST_HEAVY'] === '1' || args.includes('--include-heavy');
const roots = args
  .filter((arg) => arg.startsWith('--root='))
  .map((arg) => arg.slice('--root='.length));
const TEST_TIMEOUT_MS = Number(flag('test-timeout') ?? flag('timeout') ?? 30_000);
const FILE_TIMEOUT_MS = Number(flag('file-timeout') ?? 300_000);
const reportSlowest = Number(flag('report-slowest') ?? 0);

const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('dist')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (TEST_FILE_PATTERN.test(entry.name)) files.push(path);
  }
}
for (const root of roots.length > 0 ? roots : ['test', 'src/human/test']) {
  const abs = join(PKG_DIR, root);
  if (existsSync(abs)) walk(abs);
}
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const bunfigPath = join(PKG_DIR, 'bunfig.toml');
const bunfig = existsSync(bunfigPath) ? Bun.TOML.parse(readFileSync(bunfigPath, 'utf8')) : {};
const ignores = bunfig?.test?.pathIgnorePatterns ?? [];
const ignoreGlobs = ignores.map((pattern) => new Bun.Glob(pattern));

const relPath = (file) => relative(PKG_DIR, file).split(sep).join('/');

let selected = includeHeavy
  ? files
  : files.filter((file) => !ignoreGlobs.some((glob) => glob.match(relPath(file))));

if (shardArg !== undefined) {
  const parts = shardArg.split('/').map(Number);
  const [index, count] = parts;
  if (index === undefined || count === undefined || !Number.isInteger(index) || !Number.isInteger(count)) {
    console.error(`bad shard: ${shardArg}`);
    process.exit(2);
  }
  selected = selected.filter((_, position) => position % count === index - 1);
}

// Bun applies the package's own `pathIgnorePatterns` unless they are
// overridden on the command line. The heavy sets are exactly what those
// patterns exclude, so the override has to be passed explicitly or the
// runner would select a heavy file and then watch bun skip it.
const ignoreOverride = includeHeavy
  ? '**/node_modules/**'
  : ignores.length > 0
    ? ignores.join(',')
    : undefined;

function spawnArgs(rel) {
  const list = ['test', '--isolate', '--timeout', String(TEST_TIMEOUT_MS)];
  if (ignoreOverride !== undefined) list.push('--path-ignore-patterns', ignoreOverride);
  list.push(`./${rel}`);
  return list;
}

function parseCount(output, name) {
  const match = output.match(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, 'm'));
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function runFile(file) {
  const rel = relPath(file);
  return new Promise((resolve) => {
    const child = spawn('bun', spawnArgs(rel), { cwd: PKG_DIR });
    let output = '';
    let settled = false;
    const startedAt = performance.now();
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ rel, code, timedOut, output, ms: performance.now() - startedAt });
    };
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124, true);
    }, FILE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => finish(code ?? 1, false));
    child.on('error', () => finish(1, false));
  });
}

const totals = { pass: 0, fail: 0, errors: 0, skip: 0 };
const failures = [];
const hangs = [];
const durations = [];

function absorb(result) {
  totals.pass += parseCount(result.output, 'pass');
  totals.fail += parseCount(result.output, 'fail');
  totals.errors += parseCount(result.output, 'errors');
  totals.skip += parseCount(result.output, 'skip');
}

let cursor = 0;
async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    const file = selected[index];
    if (file === undefined) return;
    const result = await runFile(file);
    durations.push({ rel: result.rel, ms: result.ms });
    if (result.code === 0) {
      absorb(result);
      continue;
    }
    // A file that timed out is a hang, not a contention artifact — retrying it
    // would double the wait for a result that cannot improve.
    if (result.timedOut) {
      hangs.push(result.rel);
      process.stdout.write(`HANG ${result.rel} — no completion within ${FILE_TIMEOUT_MS}ms\n`);
      continue;
    }
    // A file that failed while several ran in parallel may have lost a race
    // for CPU or for a shared port. Re-run it alone before calling it broken.
    const retry = await runFile(file);
    if (retry.code === 0) {
      absorb(retry);
      process.stdout.write(`FLAKY(contention) ${result.rel} — passes in isolation\n`);
      continue;
    }
    absorb(retry);
    if (retry.timedOut) {
      hangs.push(retry.rel);
      process.stdout.write(`HANG ${retry.rel} — no completion within ${FILE_TIMEOUT_MS}ms\n`);
    } else {
      failures.push(retry.rel);
      process.stdout.write(`FAIL ${retry.rel} (exit ${retry.code})\n`);
      process.stdout.write(retry.output);
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: Math.max(1, parallel) }, () => worker()));
const seconds = ((Date.now() - started) / 1000).toFixed(1);

process.stdout.write(
  `\n${selected.length} files, ${parallel}-way: ${totals.pass} pass, ${totals.fail} fail, ${totals.errors} errors, ${totals.skip} skip [${seconds}s]\n`,
);
if (hangs.length > 0) {
  process.stdout.write(`hanging files: ${hangs.join(', ')}\n`);
}
if (failures.length > 0) {
  process.stdout.write(`failing files: ${failures.join(', ')}\n`);
}
if (reportSlowest > 0) {
  const slowest = durations.toSorted((a, b) => b.ms - a.ms).slice(0, reportSlowest);
  process.stdout.write(`slowest files:\n`);
  for (const entry of slowest) {
    process.stdout.write(`  ${(entry.ms / 1000).toFixed(1)}s  ${entry.rel}\n`);
  }
}
if (hangs.length > 0 || failures.length > 0) {
  process.exit(1);
}
process.exit(0);
