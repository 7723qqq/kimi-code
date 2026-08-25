/**
 * Compare cold-ish start wall time of packaged native binaries.
 *
 * Usage:
 *   node scripts/native/bench-native.mjs <binary> [<binary> ...] [--runs N]
 *
 * Each binary is invoked as `<bin> --version`; the first run per binary is a
 * warmup (page cache, asset extraction) and discarded. Reports min / median /
 * mean / p95 wall-clock milliseconds so builds of one target can be compared
 * side by side. Copy each build aside before benching — every build writes to
 * the same dist-native/bin/<target>/kimi path.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const runsFlagIndex = argv.indexOf('--runs');
const runs = runsFlagIndex >= 0 ? Number(argv[runsFlagIndex + 1]) : 20;
// Exclude the flag itself and its value only when the flag is present;
// an absent --runs must not drop argv[0] (index === runsFlagIndex + 1 === 0).
const binaries = argv.filter(
  (arg, index) => arg !== '--runs' && !(runsFlagIndex >= 0 && index === runsFlagIndex + 1),
);

if (binaries.length === 0 || !Number.isInteger(runs) || runs < 2) {
  console.error('Usage: node scripts/native/bench-native.mjs <binary> [<binary> ...] [--runs 20]');
  process.exit(1);
}

for (const binary of binaries) {
  if (!existsSync(binary)) {
    console.error(`Binary not found: ${resolve(binary)}`);
    process.exit(1);
  }
}

/** One `--version` invocation; returns wall-clock ms or throws with stderr. */
function runOnce(binary) {
  const started = performance.now();
  const result = spawnSync(binary, ['--version'], { encoding: 'utf-8' });
  const elapsedMs = performance.now() - started;
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    const detail = [result.stderr.trim(), result.error?.message].filter(Boolean).join('\n');
    throw new Error(`${binary} --version failed (status ${String(result.status)}): ${detail}`);
  }
  return elapsedMs;
}

function percentile(sortedSamples, fraction) {
  const index = Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * fraction) - 1);
  return sortedSamples[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    mean: total / sorted.length,
    p95: percentile(sorted, 0.95),
  };
}

const ms = (value) => value.toFixed(1).padStart(8);

const results = [];
let maxLabelWidth = 0;
for (const binary of binaries) {
  const label = resolve(binary);
  maxLabelWidth = Math.max(maxLabelWidth, label.length);
  runOnce(binary);
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    samples.push(runOnce(binary));
  }
  results.push({ label, ...summarize(samples) });
}

const header = `${'binary'.padEnd(maxLabelWidth)}  ${'min'.padStart(8)}  ${'median'.padStart(8)}  ${'mean'.padStart(8)}  ${'p95'.padStart(8)}  (ms, --version)`;
console.log(header);
console.log('-'.repeat(header.length));
for (const result of results) {
  console.log(
    `${result.label.padEnd(maxLabelWidth)}  ${ms(result.min)}  ${ms(result.median)}  ${ms(result.mean)}  ${ms(result.p95)}`,
  );
}
