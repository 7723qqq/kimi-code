import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LEDGER = path.join(ROOT, '.upstream/ledger.tsv');
const updates = [
  ['b37c9bb857', 'ported', 'grep:vertexai@packages/agent-core-v2/src/app/auth/authService.ts',
    'Vertex ADC token-missing skip is at authService.ts:739; adapter project/location path is present.'],
  ['cab0c0e5ad', 'ported', 'grep:haiku-5@packages/core/src/llm/builtin/protocol/anthropic/legalize.ts',
    'packages/core anthropic legalize.ts carries opus-5 (line 140) and haiku-5 (line 153) at 128000.'],
  ['e5ae24239b', 'ported', 'absent:coding.deva.msh.team@packages',
    'The hardcoded marketplace trust URL has no occurrence in packages/.'],
  ['5ae973905c', 'ported', 'grep:async startBtw@packages/node-sdk/src/sdk-rpc-client-v2.ts',
    'startBtw is at line 2540 and immediately enters withStaleReload at line 2541.'],
];
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
for (const [prefix, verdict, probe, note] of updates) {
  const sha = [...rows.keys()].find((candidate) => candidate.startsWith(prefix));
  if (!sha) throw new Error(`no row ${prefix}`);
  const previous = rows.get(sha)[6].trim();
  const evidence = `${previous === '-' ? '' : `${previous} `}Probe: ${probe}. ${note}`.replaceAll('\t', ' ');
  run(['--probe', sha, probe]);
  run(['--set', sha, verdict, '--evidence', evidence]);
  console.log(`${prefix}\t${verdict}`);
}
