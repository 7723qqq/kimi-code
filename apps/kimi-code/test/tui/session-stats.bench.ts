import { bench, describe, reportBenchResults } from './bench-harness';

import {
  accumulateStepCompleted,
  createEmptySessionStats,
  firstTokenAverageMs,
} from '#/tui/utils/session-stats';

interface OldStats {
  firstTokenSamples: number[];
}

function oldAccumulate(stats: OldStats, sample: number): OldStats {
  return { firstTokenSamples: [...stats.firstTokenSamples, sample] };
}

function oldAverage(stats: OldStats): number {
  return stats.firstTokenSamples.reduce((sum, sample) => sum + sample, 0) /
    stats.firstTokenSamples.length;
}

function buildOld(steps: number): OldStats {
  return {
    firstTokenSamples: Array.from({ length: steps }, (_, index) => 100 + (index % 37)),
  };
}

function buildNew(steps: number): ReturnType<typeof createEmptySessionStats> {
  let stats = createEmptySessionStats();
  for (let index = 0; index < steps; index += 1) {
    stats = accumulateStepCompleted(stats, undefined, undefined, 100 + (index % 37));
  }
  return stats;
}

for (const steps of [1_000, 10_000, 50_000]) {
  const oldStats = buildOld(steps);
  const newStats = buildNew(steps);
  describe(`session-stats ${String(steps)} steps`, () => {
    bench('old accumulate (array copy)', () => {
      oldAccumulate(oldStats, 123);
    });
    bench('new accumulate (running sum)', () => {
      accumulateStepCompleted(newStats, undefined, undefined, 123);
    });
    bench('old average (full reduce)', () => {
      oldAverage(oldStats);
    });
    bench('new average (divide)', () => {
      firstTokenAverageMs(newStats);
    });
  });
}

reportBenchResults();
