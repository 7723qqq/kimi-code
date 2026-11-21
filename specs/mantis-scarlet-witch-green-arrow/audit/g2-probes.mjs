import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LEDGER = path.join(ROOT, '.upstream/ledger.tsv');
const updates = [
  ['d64909f972', 'equivalent',
    'test:packages/agent-core-v2/test/agent/profile/binding.test.ts#keeps declared tools separate from the live overlay until an explicit snapshot bind',
    'Upstream regression test name updated; the port needed the stale conversationTime undoable registration removed and the local environment Windows-path resolve restored.'],
  ['68b849c90d', 'ported',
    'test:packages/agent-core-v2/test/tool/tool.test.ts#treats timeoutMs=0 as no deadline for background subagents and preserves the metadata',
    'Upstream test name is the timeoutMs=0 background subagent case; probe updated from the stale name.'],
  ['50ec3c3940', 'ported',
    'test:packages/agent-core-v2/test/os/backends/node-local/tools/bash.test.ts#runs through runner.spawn, injects cwd, noninteractive env, and closes stdin',
    'The commit extends the existing runner.spawn env assertion with KIMI_CODE_SESSION_ID/WORKSPACE_ID; probe updated.'],
  ['88e3c20739', 'ported',
    'test:packages/core/test/llm/bedrock.test.ts#keeps token lifecycle, routing, and Anthropic authentication provider-local',
    'The Bedrock test lives in packages/core, not agent-core-v2; probe path corrected.'],
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
