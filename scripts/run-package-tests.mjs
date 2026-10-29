#!/usr/bin/env bun
/**
 * Test runner for one workspace package.
 *
 * By default it delegates to Bun's own worker pool (`bun test --parallel=N`,
 * which spawns min(N, files) workers once and feeds them file paths). The
 * per-file path below runs only when a flag needs it, or when the pooled run
 * fails and the failures must be separated from contention:
 *
 *  - **Per-file timeout.** `bun test --timeout` bounds a single test body (and
 *    a hanging hook), but nothing bounds a whole file. A file whose top-level
 *    await never settles, or whose process refuses to exit, hangs the entire
 *    package — and with it every CI shard that owns the file.
 *  - **Position-modulo sharding.** Bun's own `--shard=N/M` shards by file too,
 *    but this runner keeps the assignment in one place so a package with fewer
 *    files than shards produces empty shards rather than duplicated work.
 *  - **Contention retry.** Files that spawn real processes (git, servers,
 *    compressors) starve each other when several run at once, and a failure
 *    under contention is not a failure. Every failing file is re-run alone;
 *    only the ones that still fail are reported. The pooled default cannot do
 *    this, so a pooled failure falls back to this path for the authoritative
 *    result.
 *
 * Usage:
 *   bun scripts/run-package-tests.mjs [--package=<dir>] [--root=<dir>]...
 *                               [--shard=N/M] [--parallel=N]
 *                               [--test-timeout=MS] [--file-timeout=MS]
 *                               [--include-heavy] [--timings=<path>]
 *                               [--per-file]
 *
 * `--per-file` forces the per-file path; `--shard`, `--timings`,
 * `--file-timeout`, `--retry` and `--report-slowest` imply it.
 *
 * `--timeout` is accepted as an alias for `--test-timeout` so that the root
 * runner can forward one spelling to both this script and plain `bun test`.
 *
 * `--timings=<path>` appends one JSON-lines record per run to `<path>`: the
 * package, the totals, and every test file's wall-clock duration. The record is
 * meant to be checked in, so a later large change can be compared against the
 * run that preceded it instead of being measured from scratch.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join, relative, sep } from 'node:path';

import { killProcessTree } from './lib/kill-process-tree.mjs';
import { limitSelfToCpus, resolveTestCpuLimit } from './lib/cpu-limit.mjs';
import { acquireTestSuiteLock } from './lib/test-suite-lock.mjs';

const args = process.argv.slice(2);
const ROOT = join(import.meta.dirname, '..');
const TIMINGS_MAX_RECORDS = 200;

const cpuLimit = resolveTestCpuLimit();
if (process.env['KIMI_TEST_CPU_LIMIT_APPLIED'] !== '1' && cpuLimit > 0) {
  if (limitSelfToCpus(cpuLimit, (line) => process.stderr.write(`${line}\n`))) {
    process.env['KIMI_TEST_CPU_LIMIT_APPLIED'] = '1';
  }
}
acquireTestSuiteLock(ROOT, ['run-package-tests', ...args].join(' '));

function flag(name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const packageArg = flag('package');
const PKG_DIR = packageArg === undefined ? process.cwd() : join(ROOT, packageArg);
const shardArg = flag('shard');
// `bun test` runs a package's files in one process, one after another. Upstream
// ran this suite on vitest, which spreads the files over worker threads, so a
// purely serial runner would trade vitest's speed for bun's serialization. The
// cap is 8 rather than one file per core: several suites bound their own waits
// tightly enough that a wider fan-out loses the race and reports a failure the
// code does not have. `lspInstance` gives an LSP server 100 ms to answer
// `initialize`, and a spawned `node` misses that once a core-count fan-out
// competes for the machine; `minidb`'s stress tests lose their timing
// assumptions the same way. 8 keeps the wall-clock win without manufacturing
// those failures, and it is already more than most machines have cores.
const MAX_PARALLEL = 8;
const defaultParallel = Math.max(
  1,
  Math.min(MAX_PARALLEL, os.availableParallelism?.() ?? os.cpus().length),
);
const rawParallel = flag('parallel');
const requestedParallel = rawParallel === undefined ? defaultParallel : Number(rawParallel);
const parsedParallel =
  Number.isInteger(requestedParallel) && requestedParallel >= 1
    ? requestedParallel
    : defaultParallel;
const parallel = Math.min(MAX_PARALLEL, parsedParallel);
if (rawParallel !== undefined && parsedParallel !== requestedParallel) {
  process.stderr.write(
    `--parallel=${String(rawParallel)} is not a positive integer; falling back to ${String(defaultParallel)}\n`,
  );
} else if (parsedParallel !== parallel) {
  process.stderr.write(
    `--parallel=${String(rawParallel)} exceeds the ${String(MAX_PARALLEL)}-way cap; using ${String(parallel)}\n`,
  );
}
const includeHeavy = process.env['KIMI_TEST_HEAVY'] === '1' || args.includes('--include-heavy');
const roots = args
  .filter((arg) => arg.startsWith('--root='))
  .map((arg) => arg.slice('--root='.length));
const TEST_TIMEOUT_MS = Number(flag('test-timeout') ?? flag('timeout') ?? 30_000);
const FILE_TIMEOUT_MS = Number(flag('file-timeout') ?? 300_000);
const reportSlowest = Number(flag('report-slowest') ?? 0);
const timingsPath = flag('timings');

// Bun's own runner already spreads files over a worker pool: `--parallel=N`
// spawns min(N, files) workers once and feeds them file paths, each worker
// reusing its process for its whole slice. The per-file spawner below is only
// needed for what Bun does not provide — shard-aware selection, per-file
// timeouts, contention retry and timings — so everything else runs through the
// native pool instead of paying one process start per test file.
const needsPerFile =
  shardArg !== undefined ||
  timingsPath !== undefined ||
  flag('file-timeout') !== undefined ||
  flag('retry') !== undefined ||
  reportSlowest > 0 ||
  args.includes('--per-file');

const NATIVE_BOOLEAN_FLAGS = new Set(['--bail', '--randomize', '--watch', '--coverage']);
const LEGACY_BOOLEAN_FLAGS = new Set(['--bail', '--randomize', '--coverage']);
const NATIVE_VALUED_FLAGS = ['--test-name-pattern=', '--coverage-reporter=', '--coverage-dir='];

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
  if (
    index === undefined ||
    count === undefined ||
    !Number.isInteger(index) ||
    !Number.isInteger(count)
  ) {
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

const retry = flag('retry');

function spawnArgs(rel) {
  const list = [
    'test',
    '--isolate',
    '--timeout',
    String(TEST_TIMEOUT_MS),
    '--pass-with-no-tests',
    '--max-concurrency=1',
  ];
  if (retry !== undefined) list.push('--retry', retry);
  if (ignoreOverride !== undefined) list.push('--path-ignore-patterns', ignoreOverride);
  for (const arg of args) {
    if (LEGACY_BOOLEAN_FLAGS.has(arg) || NATIVE_VALUED_FLAGS.some((prefix) => arg.startsWith(prefix))) {
      list.push(arg);
    }
  }
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
    const child = spawn('bun', spawnArgs(rel), {
      cwd: PKG_DIR,
      detached: process.platform !== 'win32',
    });
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
      killProcessTree(child.pid);
      finish(124, true);
    }, FILE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => finish(code ?? 1, false));
    child.on('error', () => finish(1, false));
  });
}

function filesFromFailureOutput(output) {
  const found = new Set();
  for (const match of output.matchAll(/([^\s()[\]"'`]+\.(?:test|spec)\.tsx?):\d+:\d+/g)) {
    const raw = match[1];
    const absolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') ? raw : join(PKG_DIR, raw);
    const rel = relative(PKG_DIR, absolute).split(sep).join('/');
    if (rel.startsWith('..') || !existsSync(join(PKG_DIR, rel))) continue;
    found.add(rel);
  }
  return found;
}

if (!needsPerFile) {
  const nativeRoots = (roots.length > 0 ? roots : ['test', 'src/human/test']).filter((root) =>
    existsSync(join(PKG_DIR, root)),
  );
  const nativeArgs = [
    'test',
    `--parallel=${String(parallel)}`,
    `--timeout=${String(TEST_TIMEOUT_MS)}`,
    '--pass-with-no-tests',
    '--max-concurrency=1',
  ];
  if (includeHeavy) nativeArgs.push('--path-ignore-patterns=**/node_modules/**');
  for (const arg of args) {
    if (
      NATIVE_BOOLEAN_FLAGS.has(arg) ||
      NATIVE_VALUED_FLAGS.some((prefix) => arg.startsWith(prefix))
    ) {
      nativeArgs.push(arg);
    }
  }
  nativeArgs.push(...nativeRoots.map((root) => `./${root}`));

  process.stderr.write(
    `test fan-out: ${String(parallel)} file(s) at a time, 1 test at a time, no CPU pin\n`,
  );
  let captured = '';
  const code = await new Promise((resolve) => {
    const child = spawn('bun', nativeArgs, {
      cwd: PKG_DIR,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const relay = (stream, target) => {
      stream.on('data', (chunk) => {
        captured += chunk.toString();
        target.write(chunk);
      });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on('close', (status) => resolve(status ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code === 0) process.exit(0);

  const failing = filesFromFailureOutput(captured);
  if (failing.size === 0) {
    process.stderr.write(
      'the pooled run failed but no file could be attributed; re-run with --per-file for the isolated verdict\n',
    );
    process.exit(code);
  }
  const candidates = selected.filter((file) => failing.has(relPath(file)));
  process.stderr.write(
    `native pool exited ${String(code)}; re-running ${String(candidates.length)} failing file(s) alone to separate contention from real failures\n`,
  );

  const failed = [];
  for (const file of candidates) {
    const isolated = await runFile(file);
    if (isolated.code === 0) {
      process.stdout.write(`FLAKY(contention) ${isolated.rel} — passes in isolation\n`);
      continue;
    }
    failed.push(isolated);
  }
  if (failed.length === 0) {
    process.stdout.write('\nall failures were contention; the package passes in isolation\n');
    process.exit(0);
  }
  for (const failure of failed) {
    process.stdout.write(
      failure.timedOut
        ? `HANG ${failure.rel} — no completion within ${FILE_TIMEOUT_MS}ms\n`
        : `FAIL ${failure.rel} (exit ${failure.code})\n`,
    );
    if (!failure.timedOut) process.stdout.write(failure.output);
  }
  process.stdout.write(`\nfailing files: ${failed.map((failure) => failure.rel).join(', ')}\n`);
  process.exit(1);
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
if (timingsPath !== undefined) {
  // One JSON line per run: cheap to append, diffable, and readable without a
  // parser that knows the schema version first.
  const record = {
    schema: 1,
    recordedAt: new Date().toISOString(),
    package: basename(PKG_DIR),
    parallel,
    files: selected.length,
    wallSeconds: Number(seconds),
    totals: { ...totals, hangs: hangs.length, failingFiles: failures.length },
    durations: durations
      .toSorted((a, b) => b.ms - a.ms)
      .map((entry) => ({
        file: entry.rel,
        ms: Math.round(entry.ms),
      })),
  };
  const target = join(ROOT, timingsPath);
  const lines = existsSync(target) ? readFileSync(target, 'utf8').split('\n').filter(Boolean) : [];
  const kept = [...lines, JSON.stringify(record)].slice(-TIMINGS_MAX_RECORDS);
  writeFileSync(target, `${kept.join('\n')}\n`);
  process.stdout.write(`timings appended to ${timingsPath}\n`);
}
if (hangs.length > 0 || failures.length > 0) {
  process.exit(1);
}
process.exit(0);
