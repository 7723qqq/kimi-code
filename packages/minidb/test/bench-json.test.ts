import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Runs the real bench script in --quick mode and pins the machine-readable
// JSON report's shape: later phases diff before/after numbers, so the field
// names below are a stable contract.
import { expect, test } from 'bun:test';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

test('bench --quick emits a JSON report with a stable schema', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-bench-json-'));
  try {
    const reportPath = path.join(dir, 'report.json');
    await promisify(execFile)(
      process.execPath,
      // Bun executes .ts benches natively; Node needs the tsx loader hook.
      [
        path.join(pkgDir, 'bench', 'bench.ts'),
        '--quick',
        '--json',
        reportPath,
      ],
      { cwd: pkgDir, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));

    // Top-level envelope.
    expect(report.schemaVersion).toBe(1);
    expect(report.tool).toBe('minidb/bench');
    expect(typeof report.startedAt).toBe('string');
    expect(!Number.isNaN(Date.parse(report.startedAt)), 'startedAt is an ISO timestamp').toBeTruthy();
    expect(typeof report.node).toBe('string');
    expect(typeof report.platform).toBe('string');
    expect(typeof report.arch).toBe('string');
    expect(typeof report.seed).toBe('number');
    expect(Array.isArray(report.scenarios)).toBeTruthy();
    expect(report.scenarios.length >= 10, 'all scenario families ran').toBeTruthy();

    // Every scenario row carries the shared measurement fields.
    for (const s of report.scenarios) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length > 0).toBeTruthy();
      expect(typeof s.durationMs, `${s.name}.durationMs`).toBe('number');
      expect(s.durationMs >= 0).toBeTruthy();
      if (s.ops !== undefined) expect(typeof s.ops, `${s.name}.ops`).toBe('number');
      if (s.opsPerSec !== undefined)
        expect(typeof s.opsPerSec, `${s.name}.opsPerSec`).toBe('number');
      for (const k of ['mean', 'p50', 'p95', 'p99', 'max']) {
        expect(typeof s.eventLoopDelayMs[k], `${s.name}.eventLoopDelayMs.${k}`).toBe('number');
      }
      expect(s.peakRssBytes > 0, `${s.name}.peakRssBytes`).toBeTruthy();
      expect(s.peakHeapUsedBytes > 0, `${s.name}.peakHeapUsedBytes`).toBeTruthy();
      if (s.latencyMs !== undefined) {
        for (const k of ['p50', 'p95', 'p99', 'max']) {
          expect(typeof s.latencyMs[k], `${s.name}.latencyMs.${k}`).toBe('number');
        }
      }
    }

    const byName = (re) => report.scenarios.find((s) => re.test(s.name));

    // Cold open rows expose the recovery/rebuild breakdown.
    const cold = byName(/cold open/);
    expect(cold, 'a cold-open scenario exists').toBeTruthy();
    for (const k of [
      'keys',
      'recoveryBytes',
      'recoveryFrames',
      'recoveryDurationMs',
      'indexRebuildDurationMs',
      'textRebuildDurationMs',
      'walFsyncs',
    ]) {
      expect(typeof cold.extra[k], `cold open extra.${k}`).toBe('number');
    }

    // The acceptance scenario: an idle everysec db performs zero fsyncs.
    const idle = byName(/idle everysec/);
    expect(idle, 'the idle everysec scenario exists').toBeTruthy();
    expect(idle.extra.walFsyncs, 'idle everysec db: zero background fsyncs').toBe(0);
    expect(idle.extra.walFsyncErrors).toBe(0);

    // A write re-arms the background sync.
    const dirty = byName(/write then idle/);
    expect(dirty, 'the dirty-window scenario exists').toBeTruthy();
    expect(dirty.extra.walFsyncs >= 1, 'a write triggers a background fsync').toBeTruthy();

    // Search rows report per-query hit counts and medians.
    for (const re of [/search word/, /search ngram/]) {
      const search = byName(re);
      expect(search, `${re} scenario exists`).toBeTruthy();
      expect(Array.isArray(search.extra.queries)).toBeTruthy();
      for (const q of search.extra.queries) {
        expect(typeof q.q).toBe('string');
        expect(typeof q.hits).toBe('number');
        expect(typeof q.medianMs).toBe('number');
      }
    }

    // The compaction row exposes the phase breakdown.
    const compact = byName(/compact \d/);
    expect(compact, 'a compaction scenario exists').toBeTruthy();
    for (const k of [
      'keys',
      'compactionDurationMs',
      'compactionSnapshotDurationMs',
      'compactionRotationDurationMs',
      'compactionPostingsDurationMs',
      'snapshotBytesWritten',
    ]) {
      expect(typeof compact.extra[k], `compact extra.${k}`).toBe('number');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test('open-lifecycle bench --quick emits the phase-1 baseline report', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-open-bench-json-'));
  try {
    const reportPath = path.join(dir, 'report.json');
    await promisify(execFile)(
      process.execPath,
      [
        path.join(pkgDir, 'bench', 'open-lifecycle.ts'),
        '--quick',
        '--json',
        reportPath,
      ],
      { cwd: pkgDir, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));

    // Top-level envelope.
    expect(report.schemaVersion).toBe(1);
    expect(report.tool).toBe('minidb/bench/open-lifecycle');
    expect(Array.isArray(report.scenarios)).toBeTruthy();

    const byName = (re) => report.scenarios.find((s) => re.test(s.name));

    // Every row carries the event-loop-delay + input-latency baselines.
    for (const s of report.scenarios) {
      expect(typeof s.durationMs, `${s.name}.durationMs`).toBe('number');
      for (const k of ['mean', 'p50', 'p95', 'p99', 'max']) {
        expect(typeof s.eventLoopDelayMs[k], `${s.name}.eventLoopDelayMs.${k}`).toBe('number');
      }
      expect(s.inputLatencyMs, `${s.name}.inputLatencyMs`).toBeTruthy();
      for (const k of ['count', 'p50', 'p95', 'p99', 'max']) {
        expect(typeof s.inputLatencyMs[k], `${s.name}.inputLatencyMs.${k}`).toBe('number');
      }
    }

    // The four scenario families exist with their lifecycle phase breakdown.
    const PHASES = [
      'openMs',
      'generationCandidateLoadMs',
      'storeImageLoadMs',
      'nonTextImageLoadMs',
      'textImageLoadMs',
      'postingsIntegrityCheckMs',
      'walScanMs',
      'walApplyMs',
      'fullRecoveryMs',
      'textRebuildMs',
    ];
    const small = byName(/small corpus, healthy generation/);
    const wal = byName(/large WAL delta/);
    const large = byName(/large full-text generation/);
    const corrupt = byName(/corrupt generation \(full-recovery fallback\)/);
    const deferred = byName(/deferred text rebuild \(degraded -> ready\)/);
    for (const [name, s] of Object.entries({ small, wal, large, corrupt, deferred })) {
      expect(s, `${name} scenario exists`).toBeTruthy();
      for (const k of PHASES)
        expect(typeof s.extra.phases[k], `${name}.extra.phases.${k}`).toBe('number');
    }

    // Healthy generation opens: no full recovery, no corpus tokenization.
    for (const [name, s] of Object.entries({ small, wal, large })) {
      expect(s.extra.state, name).toBe('ready');
      expect(s.extra.path, name).toStrictEqual(['no-generation', 'generation-load', 'wal-catch-up', 'ready']);
      expect(s.extra.phases.fullRecoveryMs, name).toBe(0);
      expect(s.extra.phases.textRebuildMs, name).toBe(0);
      expect(s.extra.generationLoads, name).toBe(1);
      expect(s.extra.indexRebuildDecoded, name).toBe(0);
    }
    // The WAL-delta open really replayed the delta (and close did NOT
    // republish it into a fresh generation — the scenario would be void).
    expect(wal.extra.walDeltaAppliedOps > 0, 'wal delta replayed').toBeTruthy();
    expect(wal.extra.closePublishedGeneration, 'close left the generation untouched').toBe(false);
    expect(wal.extra.phases.walApplyMs > 0, 'wal apply measured').toBeTruthy();

    // The corrupt generation fell back to a full recovery and returned
    // degraded; the background deferred build then brought it to ready.
    expect(corrupt.extra.state).toBe('degraded');
    expect(corrupt.extra.path).toStrictEqual([
      'no-generation',
      'generation-load',
      'full-rebuild',
      'degraded',
    ]);
    expect(corrupt.extra.phases.fullRecoveryMs > 0, 'full recovery measured').toBeTruthy();
    expect(corrupt.extra.generationLoadFallbacks).toBe(1);
    expect(deferred.extra.state).toBe('ready');
    expect(deferred.extra.textDeferredBuilds >= 1, 'deferred build committed').toBeTruthy();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 300_000);
