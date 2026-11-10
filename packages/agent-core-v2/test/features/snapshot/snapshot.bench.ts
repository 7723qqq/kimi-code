import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import { FileSnapshotStore, snapshotContentHash } from '#/features/snapshot/fileSnapshotStore';

const ITERATIONS = 400;
const body = new TextEncoder().encode('export const value = 1;\n'.repeat(160));

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function report(label: string, samples: readonly number[]): void {
  const sorted = samples.toSorted((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  process.stdout.write(
    `${label.padEnd(18)} n=${String(samples.length)} mean=${mean.toFixed(3)}ms p50=${percentile(sorted, 50).toFixed(3)}ms p95=${percentile(sorted, 95).toFixed(3)}ms p99=${percentile(sorted, 99).toFixed(3)}ms max=${sorted.at(-1)!.toFixed(3)}ms\n`,
  );
}

const root = await mkdtemp(join(tmpdir(), 'kimi-snapshot-bench-'));
const target = join(root, 'file.ts');
const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));
await writeFile(target, body);

const baseline: number[] = [];
const snapshot: number[] = [];
let tick = 1_700_000_000_000;

for (let index = 0; index < ITERATIONS; index += 1) {
  const beforeWrite = performance.now();
  await writeFile(target, body);
  baseline.push(performance.now() - beforeWrite);

  tick += 1;
  const beforeSnapshot = performance.now();
  const pre = readFileSync(target);
  const record = await store.record({
    path: target,
    at: new Date(tick),
    tool: 'Write',
    mode: 'overwrite',
    size: pre.byteLength,
    bytes: pre,
    sessionId: 'ses_bench',
    agentId: `agent-${String(index % 8)}`,
  });
  await store.complete(target, record.id, {
    hash: snapshotContentHash(body),
    size: body.byteLength,
  });
  snapshot.push(performance.now() - beforeSnapshot);
}

report('write only', baseline);
report('read+snapshot', snapshot);
report('added', snapshot.map((value, index) => value - baseline[index]!));

await rm(root, { recursive: true, force: true });
