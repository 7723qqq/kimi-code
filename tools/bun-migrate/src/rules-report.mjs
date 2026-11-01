#!/usr/bin/env bun
import { cryptoHasherSupports, runtimeReport } from '../src/capabilities.mjs';
import { CONSTANT_VALUE_DIFFERENCES } from '../src/constant-values.mjs';
import { ERROR_CASES, ERROR_GAPS } from '../src/error-shapes.mjs';
import { CAPABILITY_REPLACEMENTS, MODULE_REPLACEMENTS } from '../src/modules-map.mjs';
import { activeGaps } from '../src/node-gaps.mjs';
import { PACKAGE_REPLACEMENTS } from '../src/packages-map.mjs';
import { PAIRINGS } from '../src/pairings.mjs';
import { SIGNATURE_DIFF_SUMMARY, SIGNATURE_GAPS } from '../src/signature-gaps.mjs';
import { probeAll } from '../src/silent-gaps.mjs';

const runtime = runtimeReport();
const nodeRules = PAIRINGS.map((pairing) => ({
  from: `${pairing.from}#${pairing.exportName}`,
  to: pairing.bunExpression,
  effect: pairing.effect,
  summary: pairing.summary,
}));

const packageRules = PACKAGE_REPLACEMENTS.map((entry) => ({
  from: entry.package,
  to: entry.bun,
  effect: entry.effect,
  summary: entry.summary,
}));

function group(rules) {
  const byEffect = new Map();
  for (const rule of rules) {
    if (!byEffect.has(rule.effect)) byEffect.set(rule.effect, []);
    byEffect.get(rule.effect).push(rule);
  }
  return byEffect;
}

const order = ['speed', 'report-only'];

process.stdout.write(`bun ${runtime.bun}\n`);
process.stdout.write(
  `probes: CryptoHasher=${runtime.cryptoHasher} Bun.file=${runtime.bunFile} Bun.write=${runtime.bunWrite}\n`,
);

const sections = [
  { title: 'node: builtins', rules: nodeRules },
  { title: 'npm packages', rules: packageRules },
];
for (const { title, rules } of sections) {
  process.stdout.write(`\n=== ${title} (${rules.length}) ===\n`);
  const grouped = group(rules);
  for (const effect of order) {
    const bucket = grouped.get(effect) ?? [];
    if (bucket.length === 0) continue;
    process.stdout.write(`\n${effect} (${bucket.length})\n`);
    for (const rule of bucket) {
      process.stdout.write(`  ${rule.from.padEnd(34)} -> ${rule.to}\n`);
    }
  }
}

process.stdout.write(`\n=== module replacements (${MODULE_REPLACEMENTS.length}) ===\n`);
for (const entry of MODULE_REPLACEMENTS) {
  process.stdout.write(`\n  ${entry.from} -> ${entry.to}  [${entry.effect}]\n`);
  process.stdout.write(`    ${entry.summary}\n`);
  process.stdout.write(
    `    divergences: ${entry.divergences.length}, missing: ${entry.missing.length}\n`,
  );
  for (const item of entry.divergences) {
    process.stdout.write(`      - ${item.behaviour}\n`);
  }
}

process.stdout.write(`\n=== capability replacements (${CAPABILITY_REPLACEMENTS.length}) ===\n`);
for (const entry of CAPABILITY_REPLACEMENTS) {
  process.stdout.write(`\n  ${entry.from} -> ${entry.to}  [${entry.effect}]\n`);
  process.stdout.write(`    ${entry.summary}\n`);
  process.stdout.write(`    verified: ${entry.verified.join(', ')}\n`);
  process.stdout.write(`    Bun is missing: ${entry.bunMissing.join(', ')}\n`);
}

const algorithms = ['sha256', 'sha512', 'sha3-256', 'md5', 'blake2b512', 'shake128', 'secp256k1'];
process.stdout.write('\nalgorithm probe sample\n');
for (const algorithm of algorithms) {
  process.stdout.write(
    `  ${algorithm.padEnd(12)} ${cryptoHasherSupports(algorithm) ? 'hashable' : 'unsupported'}\n`,
  );
}

const gaps = activeGaps();
const silent = probeAll();
process.stdout.write(`\n=== node: gaps on this Bun (${gaps.length}) ===\n`);
if (gaps.length === 0) {
  process.stdout.write('  none: every recorded gap is closed, the list can be trimmed\n');
} else {
  for (const gap of gaps) {
    process.stdout.write(`  ${gap.module}#${gap.member}\n`);
    process.stdout.write(`    ${gap.workaround}\n`);
  }
}

process.stdout.write(
  `\n=== constant value differences (${CONSTANT_VALUE_DIFFERENCES.length}) ===\n`,
);
for (const entry of CONSTANT_VALUE_DIFFERENCES) {
  process.stdout.write(`  ${entry.module} ${entry.path}\n`);
  process.stdout.write(`    node ${entry.node} vs bun ${entry.bun}\n`);
}

process.stdout.write(`\n=== signature differences (${SIGNATURE_GAPS.length} curated) ===\n`);
process.stdout.write(`  raw arity diff: ${SIGNATURE_DIFF_SUMMARY.totalArityDifferences}\n`);
process.stdout.write(`  ${SIGNATURE_DIFF_SUMMARY.reason}\n`);
for (const gap of SIGNATURE_GAPS) {
  process.stdout.write(
    `  ${gap.module}#${gap.member}: node ${gap.node.length} params vs bun ${gap.bun.length}\n`,
  );
}

process.stdout.write(`\n=== silent degradation (${silent.length}) ===\n`);
for (const entry of silent) {
  const observed = entry.result.ok
    ? JSON.stringify(entry.result.observed)
    : `probe failed: ${entry.result.observed.error}`;
  process.stdout.write(`  [${entry.severity}] ${entry.api}\n`);
  process.stdout.write(`    ${entry.summary}\n`);
  process.stdout.write(`    observed: ${observed}\n`);
}

const agreeing = ERROR_CASES.filter((entry) => entry.expect === null).length;
process.stdout.write(`\n=== error shapes (${ERROR_CASES.length} cases, ${agreeing} agree) ===\n`);
process.stdout.write(`  ${ERROR_GAPS.length} recorded divergence(s)\n`);
for (const gap of ERROR_GAPS) {
  process.stdout.write(`  [${gap.severity}] ${gap.observable}\n`);
  process.stdout.write(`    node: ${gap.node}\n`);
  process.stdout.write(`    bun:  ${gap.bun}\n`);
  process.stdout.write(`    breaks: ${gap.breaks}\n`);
  process.stdout.write(`    instead: ${gap.workaround}\n`);
}

if (process.argv.includes('--json')) {
  process.stdout.write(`\n${JSON.stringify({ runtime, nodeRules, packageRules }, null, 2)}\n`);
}
