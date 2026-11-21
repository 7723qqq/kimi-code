import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LEDGER = path.join(ROOT, '.upstream/ledger.tsv');
const updates = [
  ['453ba6bb1d', 'ported', 'grep:## 2.6.0@docs/en/release-notes/changelog.md'],
  ['401b4a015f', 'ported', 'grep:## 2.6.1@docs/en/release-notes/changelog.md'],
  ['f082f04a09', 'ported', 'grep:## 2.6.2@docs/en/release-notes/changelog.md'],
  ['334d79870e', 'equivalent', 'grep:feedbackUrl@packages/agent-core-v2/src/llm-adapter/provider/provider.ts'],
  ['1ccbe4127d', 'equivalent', 'grep:async settled@packages/agent-core-v2/src/agent/loop/loopService.ts'],
  ['ff61a26074', 'equivalent', 'grep:--environment-cwd@docs/en/guides/remote-environment.md'],
  ['2eb3e87c66', 'equivalent', 'grep:--title "Kimi Code CLI@.github/workflows/canary-release.yml'],
];

const rows = new Map();
for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).slice(1)) {
  if (!line) continue;
  const fields = line.split('\t');
  if (fields.length > 1) rows.set(fields[1], fields);
}

function run(args) {
  const result = spawnSync('bun', ['scripts/upstream-ledger.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr.trim()}`);
}

for (const [prefix, verdict, probe] of updates) {
  const sha = [...rows.keys()].find((candidate) => candidate.startsWith(prefix));
  if (!sha) throw new Error(`no row ${prefix}`);
  const current = rows.get(sha);
  const evidence = `${current[6].trim()} Probe: ${probe}`.replaceAll('\t', ' ');
  run(['--probe', sha, probe]);
  run(['--set', sha, verdict, '--evidence', evidence]);
  console.log(`${prefix}\t${verdict}\t${probe}`);
}
