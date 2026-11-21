import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const HEAD_LEDGER = execSync('git show HEAD:.upstream/ledger.tsv', {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const CURRENT = fs.readFileSync(path.join(ROOT, '.upstream/ledger.tsv'), 'utf8');

function parse(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length > 1) rows.set(fields[1], fields);
  }
  return rows;
}

const oldRows = parse(HEAD_LEDGER);
const currentRows = parse(CURRENT);
const report = [];
let merged = 0;
let skipped = 0;
let failed = 0;

for (const [sha, row] of currentRows) {
  const old = oldRows.get(sha);
  if (!old || old[6] === row[6]) continue;
  const oldEvidence = old[6].trim();
  const newEvidence = row[6].trim();
  const verdict = row[4];
  if (oldEvidence === '' || oldEvidence === '-') {
    report.push([sha, oldEvidence.length, newEvidence.length, newEvidence.length, 'added-keep-new']);
    skipped++;
    continue;
  }
  if (verdict === 'not-applicable' || verdict === 'blocked') {
    report.push([sha, oldEvidence.length, newEvidence.length, oldEvidence.length, 'deferred-signature']);
    skipped++;
    continue;
  }
  const mergedEvidence = oldEvidence.includes(`Probe: ${newEvidence}`)
    ? oldEvidence
    : `${oldEvidence} Probe: ${newEvidence}`.replaceAll('\t', ' ');
  const result = spawnSync(
    'bun',
    ['scripts/upstream-ledger.mjs', '--set', sha, verdict, '--evidence', mergedEvidence],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL ${sha.slice(0, 10)}: ${result.stderr.trim()}`);
    report.push([sha, oldEvidence.length, newEvidence.length, mergedEvidence.length, 'failed']);
    continue;
  }
  merged++;
  report.push([sha, oldEvidence.length, newEvidence.length, mergedEvidence.length, 'merged']);
}

const reportPath = path.join(import.meta.dirname, 'ledger-evidence.tsv');
fs.writeFileSync(
  reportPath,
  `sha\told_len\tnew_len\tmerged_len\tstatus\n${report.map((row) => row.join('\t')).join('\n')}\n`,
);

console.log({ changed: report.length, merged, skipped, failed });
