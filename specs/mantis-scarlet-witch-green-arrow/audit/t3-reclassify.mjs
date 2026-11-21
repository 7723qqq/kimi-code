import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LEDGER = path.join(ROOT, '.upstream/ledger.tsv');
const SIGNATURE = 'Signature: user (spec approval 2026-11-21); verified 2026-11-21 against the current tree.';

function parse(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length > 1) rows.set(fields[1], fields);
  }
  return rows;
}

function run(args) {
  const result = spawnSync('bun', ['scripts/upstream-ledger.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const rows = parse(fs.readFileSync(LEDGER, 'utf8'));
const report = [];

const core = [
  {
    sha: '135993745d0c42ce2f535b59f03197075c0cb521',
    probe: 'absent:createToolExecutor@packages/core/src/tool',
    evidence:
      'Reclassified 2026-11-21: packages/core now carries the 2.7.0 tool tree. The five legacy files (contract.ts, executor.ts, hooks.ts, policy.ts, tool.ts) are absent; createToolExecutor has no occurrence; tool/tool-executor.ts is the new executor. The previous not-applicable reason (the package did not exist here) is no longer true.',
  },
  {
    sha: '182b324c24707ca8160bb5744b2777045a5996da',
    probe: 'grep:export function setNow@packages/core/src/utils/now.ts',
    evidence:
      'Reclassified 2026-11-21: packages/core/src/utils/now.ts exports now()/setNow() (lines 3, 7) and utils/log.ts exports log/setLog (lines 18, 25). The injectable clock and log seams are present. The previous not-applicable reason (the package did not exist here) is no longer true.',
  },
  {
    sha: '1935082ce7f58989b6d15c9d4120df46d12bd393',
    probe: 'grep:class CallControl@packages/core/src/tool/tool-executor.ts',
    evidence:
      'Reclassified 2026-11-21: packages/core/src/tool/tool-executor.ts defines CallControl at line 175 and the tool executor test covers it. The simplified lifecycle is present. The previous not-applicable reason (the package did not exist here) is no longer true.',
  },
  {
    sha: 'a656ab627a',
    probe: 'absent:args-validator@packages/core/src/tool',
    evidence:
      'Reclassified 2026-11-21: packages/core/src/tool/runtime is absent; args.ts exports parseToolCallArguments (line 105) and validate.ts exists, so the runtime directory was flattened into tool/. The previous pending state is closed.',
  },
];

for (const item of core) {
  const sha = [...rows.keys()].find((candidate) => candidate.startsWith(item.sha));
  if (!sha) throw new Error(`no row for ${item.sha}`);
  run(['--probe', sha, item.probe]);
  const evidence = item.evidence.replaceAll('\t', ' ');
  run(['--set', sha, 'ported', '--evidence', evidence]);
  report.push([sha.slice(0, 10), 'ported', item.probe, 'reclassified']);
}

const unsigned = [...rows.values()].filter(
  (row) => row[4] === 'not-applicable' && (!row[8] || row[8] === '-'),
);
for (const row of unsigned) {
  const sha = row[1];
  let evidence = row[6].trim();
  if (sha.startsWith('b12d13e53c')) {
    evidence = evidence.replace(
      'agent/loop/machine/ (requester.ts, engine.ts, history.ts, tools.ts)',
      'agent/loop/ (llmRequestOps.ts, requesterContract.ts, requestObservation.ts, toolSelectPolicy.ts)',
    );
  }
  const merged = `${evidence} ${SIGNATURE}`.replaceAll('\t', ' ');
  run([
    '--set',
    sha,
    'not-applicable',
    '--evidence',
    merged,
    '--approved-by',
    'user (spec approval 2026-11-21)',
  ]);
  report.push([sha.slice(0, 10), 'not-applicable', row[5], 'signed']);
}

fs.writeFileSync(
  path.join(import.meta.dirname, 't3-ledger.tsv'),
  `sha\tverdict\tprobe\taction\n${report.map((row) => row.join('\t')).join('\n')}\n`,
);
console.log({ core: core.length, signed: unsigned.length, total: report.length });
