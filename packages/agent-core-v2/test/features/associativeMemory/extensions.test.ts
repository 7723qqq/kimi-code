import { describe, expect, it } from 'bun:test';

import {
  applyDecay,
  applyMotivatedForgetting,
  applySleepDownscale,
  restoreCaptured,
} from '#/features/associativeMemory/decay';
import {
  collectCalibration,
  collectCostMs,
  evaluateExtended,
  interferenceRate,
  retentionRate,
} from '#/features/associativeMemory/eval';
import { calibrate, updateConfidence } from '#/features/associativeMemory/metacognition';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import { interleave, rankByNeedGain } from '#/features/associativeMemory/scheduler';
import { collectSchemaLinks } from '#/features/associativeMemory/schema';
import { cascadeLevel, deriveNodeStates } from '#/features/associativeMemory/state';
import type { Edge, RecallTraceNode } from '#/features/associativeMemory/types';
import { WorkingBuffer } from '#/features/associativeMemory/workingBuffer';

function hebbianEdge(id: string, strengthenCount = 1): Edge {
  return {
    id,
    from: 'a1',
    to: id,
    kind: 'hebbian',
    weight: 1,
    strengthenCount,
    validFrom: 0,
    validUntil: undefined,
    createdAt: 0,
    lastUsedAt: 0,
  };
}

describe('WorkingBuffer', () => {
  it('bounds the buffer by capacity and by age', () => {
    const buffer = new WorkingBuffer(2, 100);
    buffer.touch('alpha', 0);
    buffer.touch('beta', 0);
    buffer.touch('gamma', 0);
    expect(buffer.snapshot(0).size).toBe(2);
    expect(buffer.has('gamma', 0)).toBe(true);
  });

  it('expires items once the ttl passes', () => {
    const buffer = new WorkingBuffer(10, 100);
    buffer.touch('the cache ttl is sixty seconds', 0);
    expect(buffer.has('the cache ttl is sixty seconds', 50)).toBe(true);
    expect(buffer.has('the cache ttl is sixty seconds', 101)).toBe(false);
    expect(buffer.snapshot(101).size).toBe(0);
  });

  it('reactivates silent items that match a later cue', () => {
    const buffer = new WorkingBuffer(10, 100);
    buffer.touch('the cache ttl is sixty seconds', 0);
    expect(buffer.reactivate('cache', 10)).toEqual([]);
    const silent = buffer.reactivate('cache', 60);
    expect(silent).toHaveLength(1);
    expect(silent[0]?.text).toBe('the cache ttl is sixty seconds');
    expect(buffer.snapshot(60).silent).toHaveLength(1);
  });

  it('does not reactivate unrelated cues', () => {
    const buffer = new WorkingBuffer(10, 100);
    buffer.touch('the cache ttl is sixty seconds', 0);
    expect(buffer.reactivate('deployment', 60)).toEqual([]);
  });
});

describe('metacognition', () => {
  it('moves confidence toward the observed outcome', () => {
    expect(updateConfidence(0.5, true, 0.2)).toBeCloseTo(0.6, 5);
    expect(updateConfidence(0.5, false, 0.2)).toBeCloseTo(0.4, 5);
  });

  it('clamps confidence into the unit interval', () => {
    expect(updateConfidence(0.99, true, 1)).toBe(1);
    expect(updateConfidence(0.01, false, 1)).toBe(0);
  });

  it('groups samples into calibration buckets', () => {
    const buckets = calibrate(
      [
        { confidence: 0.1, confirmed: false },
        { confidence: 0.25, confirmed: false },
        { confidence: 0.9, confirmed: true },
      ],
      5,
    );
    expect(buckets).toHaveLength(5);
    expect(buckets[0]!.count + buckets[1]!.count).toBe(2);
    expect(buckets[4]!.observed).toBe(1);
    expect(buckets[4]!.count).toBe(1);
  });
});

describe('node state and cascade levels', () => {
  it('maps strengthening counts to discrete bounded levels', () => {
    expect(cascadeLevel(0, 4)).toBe(0);
    expect(cascadeLevel(1, 4)).toBe(1);
    expect(cascadeLevel(3, 4)).toBe(2);
    expect(cascadeLevel(1000, 4)).toBe(4);
  });

  it('derives thetaM from the average out-edge strengthening', () => {
    const states = deriveNodeStates(
      [hebbianEdge('x', 1), hebbianEdge('y', 3)],
      new Map([['a1', 5]]),
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    expect(states.get('a1')?.thetaM).toBe(2);
    expect(states.get('a1')?.activity).toBe(5);
    expect(states.get('a1')?.cascadeLevel).toBe(cascadeLevel(2, 4));
  });

  it('keeps deeply consolidated edges from decaying as fast as shallow ones', () => {
    const shallow = applyDecay([hebbianEdge('x', 1)], 1000, ASSOCIATIVE_MEMORY_PARAMS)[0]!;
    const deep = applyDecay([hebbianEdge('y', 16)], 1000, ASSOCIATIVE_MEMORY_PARAMS)[0]!;
    expect(deep.weight).toBeGreaterThan(shallow.weight);
  });
});

describe('sleep downscale and capture', () => {
  it('downscales every hebbian edge but leaves relationship edges alone', () => {
    const relation: Edge = { ...hebbianEdge('z'), kind: 'concept' };
    const scaled = applySleepDownscale([hebbianEdge('x'), relation], ASSOCIATIVE_MEMORY_PARAMS);
    expect(scaled[0]!.weight).toBeCloseTo(0.9, 5);
    expect(scaled[1]!.weight).toBe(1);
  });

  it('restores captured edges independently of the downscale step', () => {
    const captured: Edge = { ...hebbianEdge('y'), strengthenCount: 3 };
    const scaled = applySleepDownscale([hebbianEdge('x'), captured], ASSOCIATIVE_MEMORY_PARAMS);
    expect(scaled[0]!.weight).toBeCloseTo(0.9, 5);
    expect(scaled[1]!.weight).toBeCloseTo(0.9, 5);
    const restored = restoreCaptured(scaled, ASSOCIATIVE_MEMORY_PARAMS);
    expect(restored[1]!.weight).toBeCloseTo(1, 5);
    expect(restored[0]!.weight).toBeCloseTo(0.9, 5);
  });
});

describe('evaluateExtended', () => {
  it('carries the base metrics plus the extra dimensions', () => {
    const evaluation = evaluateExtended([['a', 'b']], [['b']], {
      retention: 0.8,
      interference: 0.1,
      costMs: 12,
    });
    expect(evaluation.hitAt1).toBe(0);
    expect(evaluation.hitAt5).toBe(1);
    expect(evaluation.mrr).toBeCloseTo(0.5, 5);
    expect(evaluation.retention).toBe(0.8);
    expect(evaluation.interference).toBe(0.1);
    expect(evaluation.costMs).toBe(12);
    expect(evaluation.calibration).toEqual([]);
  });
});

describe('replay scheduling', () => {
  it('ranks by need times gain rather than gain alone', () => {
    const items = [
      { id: 'a', need: 1, gain: 3 },
      { id: 'b', need: 4, gain: 1 },
    ];
    const ranked = rankByNeedGain(
      items,
      (item) => item.need,
      (item) => item.gain,
      (left, right) => (left.id < right.id ? -1 : 1),
    );
    expect(ranked[0]?.id).toBe('b');
  });

  it('interleaves strata instead of taking the top scores consecutively', () => {
    expect(interleave([1, 2, 3, 4, 5, 6], 3, 3)).toEqual([1, 3, 5]);
  });

  it('never exceeds the requested limit', () => {
    expect(interleave([1, 2, 3], 10, 3)).toHaveLength(3);
  });
});

describe('evaluation collection', () => {
  it('computes retention and interference from observed recalls', () => {
    expect(
      retentionRate([
        { expectedId: 'a', recalled: ['a', 'b'] },
        { expectedId: 'c', recalled: ['b'] },
      ]),
    ).toBeCloseTo(0.5, 5);
    expect(
      interferenceRate([
        { recalled: ['a'], distractors: ['x'] },
        { recalled: ['x'], distractors: ['x'] },
      ]),
    ).toBeCloseTo(0.5, 5);
  });

  it('collects cost and calibration from samples', () => {
    expect(collectCostMs(10, 25)).toBe(15);
    expect(collectCostMs(30, 10)).toBe(0);
    const buckets = collectCalibration([{ confidence: 0.9, confirmed: true }]);
    expect(buckets).toHaveLength(5);
    expect(buckets[4]?.observed).toBe(1);
  });
});

describe('motivated forgetting', () => {
  it('downscales only the hebbian edges of neglected source atoms', () => {
    const relation: Edge = { ...hebbianEdge('y'), kind: 'concept' };
    const result = applyMotivatedForgetting(
      [hebbianEdge('x'), relation],
      new Set(['a1']),
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    expect(result[0]?.weight).toBeCloseTo(0.95, 5);
    expect(result[1]?.weight).toBe(1);
  });
});

describe('truncated successor structure', () => {
  const trace: readonly RecallTraceNode[] = [
    { id: 'a', kind: 'seed', score: 1, viaEdge: undefined, truncated: false },
    {
      id: 'b',
      kind: 'spread',
      score: 0.5,
      viaEdge: { from: 'a', weight: 1, decayed: 0.5 },
      truncated: false,
    },
    {
      id: 'c',
      kind: 'spread',
      score: 0.25,
      viaEdge: { from: 'b', weight: 1, decayed: 0.25 },
      truncated: false,
    },
  ];

  it('reconstructs only multi-hop seed to target links', () => {
    expect(collectSchemaLinks(trace, ASSOCIATIVE_MEMORY_PARAMS)).toEqual([
      { from: 'a', to: 'c', hops: 2 },
    ]);
  });

  it('respects the minimum hop and top-k bounds', () => {
    const oneHop = { ...ASSOCIATIVE_MEMORY_PARAMS, schemaMinHops: 3 };
    expect(collectSchemaLinks(trace, oneHop)).toEqual([]);
    const capped = { ...ASSOCIATIVE_MEMORY_PARAMS, schemaTopK: 0 };
    expect(collectSchemaLinks(trace, capped)).toEqual([]);
  });
});

describe('calibration monotonicity', () => {
  it('keeps observed accuracy non-decreasing across populated confidence buckets', () => {
    const buckets = calibrate(
      [
        { confidence: 0.1, confirmed: false },
        { confidence: 0.2, confirmed: false },
        { confidence: 0.45, confirmed: true },
        { confidence: 0.45, confirmed: false },
        { confidence: 0.65, confirmed: true },
        { confidence: 0.7, confirmed: true },
        { confidence: 0.9, confirmed: true },
        { confidence: 0.95, confirmed: true },
      ],
      5,
    ).filter((bucket) => bucket.count > 0);
    expect(buckets.length).toBeGreaterThan(1);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]!.observed).toBeGreaterThanOrEqual(buckets[index - 1]!.observed);
    }
  });
});
