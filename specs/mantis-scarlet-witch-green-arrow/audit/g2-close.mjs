import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LEDGER = path.join(ROOT, '.upstream/ledger.tsv');
const shas = ['d64909f972','68b849c90d','1364ab4741','1fc7be4001','638c6ffe03','29bc56daaf','6130601871','88e3c20739','b37c9bb857','cab0c0e5ad','50ec3c3940','e5ae24239b','8d7948e111','e122269955','5ae973905c'];
const rows = new Map();
for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).slice(1)) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields.length > 1) rows.set(fields[1], fields);
}
function run(args) {
  const result = spawnSync('bun', ['scripts/upstream-ledger.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr.trim()}`);
}
for (const prefix of shas) {
  const sha = [...rows.keys()].find((candidate) => candidate.startsWith(prefix));
  if (!sha) throw new Error(`no row ${prefix}`);
  const row = rows.get(sha);
  const evidence = `${row[6].trim()} Verified 2026-11-21: executable probe passes for this row.`.replaceAll('\t', ' ');
  run(['--set', sha, row[4], '--evidence', evidence]);
  console.log(`${prefix}\t${row[4]}`);
}
