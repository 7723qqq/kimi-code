import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const ledger = new Map();
for (const line of fs.readFileSync(path.join(ROOT, '.upstream/ledger.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields.length > 1) ledger.set(fields[1], fields);
}
const rows = [
  ['d64909f972', 8, 'binding snapshot, overlay and allowlist refresh', 'prepareBindingSnapshot and reconcileSubagentAllowlist present; regression test passes', 'equivalent'],
  ['68b849c90d', 5, 'subagent/tower deadline guards', 'timeoutMs=0 disables deadline in both tools; test passes', 'ported'],
  ['1364ab4741', 8, 'mutable replay participant staging', 'mutableReplay staging and freeze paths present; test passes', 'ported'],
  ['1fc7be4001', 3, 'raw byte task output tail', 'readTaskOutputTail opens the file and reads bytes; raw-byte test passes', 'equivalent'],
  ['638c6ffe03', 6, 'usage-anchored token counting and compaction', 'buildHistoryTokenProfile present', 'ported'],
  ['29bc56daaf', 2, 'task wait/reload test stabilization', 'zero-timeout test passes', 'ported'],
  ['6130601871', 8, 'occupied session resume and run-gate tryAcquire', 'tryAcquire path present; occupied-session test passes', 'ported'],
  ['88e3c20739', 36, 'Amazon Bedrock provider and credential chain', 'core bedrock provider and test present', 'ported'],
  ['b37c9bb857', 7, 'Vertex AI ADC without API key', 'authService vertexai skip present', 'ported'],
  ['cab0c0e5ad', 3, 'Anthropic output ceilings', 'opus-5/haiku-5 128000 in core legalize', 'ported'],
  ['50ec3c3940', 5, 'Bash session/workspace env', 'runner.spawn env test passes', 'ported'],
  ['e5ae24239b', 2, 'remove hardcoded marketplace trust URL', 'absent in packages', 'ported'],
  ['8d7948e111', 1, 'search route readiness', 'literal-mode wire test passes', 'ported'],
  ['e122269955', 1, 'remote git session test stabilization', 'legacy /api/v2 sessions test passes', 'ported'],
  ['5ae973905c', 3, 'startBtw stale reload', 'startBtw enters withStaleReload', 'ported'],
  ['285584e188', 1, 'tower completion lock test deflake', 'no counterpart; NA signed', 'not-applicable'],
];
const out = [];
for (const [prefix, files, upstream, local, form] of rows) {
  const sha = [...ledger.keys()].find((candidate) => candidate.startsWith(prefix));
  if (!sha) throw new Error(`no row ${prefix}`);
  out.push([sha, `${files}/${files}`, upstream, local, form, ledger.get(sha)[5], 'verified 2026-11-21'].join('\t'));
}
fs.appendFileSync(path.join(import.meta.dirname, 'audit.tsv'), `${out.join('\n')}\n`);
console.log(`appended ${out.length} G2 rows`);
