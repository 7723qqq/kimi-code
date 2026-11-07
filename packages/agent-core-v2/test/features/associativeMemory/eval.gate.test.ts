import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import {
  collectCostMs,
  evaluateExtended,
  evaluateRecall,
  interferenceRate,
  retentionRate,
  type InterferenceSample,
  type RecallEvaluation,
  type RetentionSample,
} from '#/features/associativeMemory/eval';
import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import {
  EVAL_DISTRACTORS,
  EVAL_HARD_DISTRACTORS,
  EVAL_SPARSE_DISTRACTORS,
  EVAL_TOPICS,
  buildEvalService,
} from './eval-corpus';

const LEXICAL_HIT5_FLOOR = 1;
const LEXICAL_MRR_FLOOR = 1;
const HARD_HIT1_FLOOR = 0.5;
const HARD_MRR_FLOOR = 0.72;
const SPARSE_HIT5_FLOOR = 0.83;
const SPARSE_MRR_FLOOR = 0.58;

async function withCorpus<T>(
  distractors: readonly string[],
  task: (service: AssociativeMemoryService) => Promise<T>,
): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-memory-gate-'));
  const service = buildEvalService(homeDir);
  try {
    for (const note of distractors) await service.writeNote(note);
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function measure(distractors: readonly string[] = EVAL_DISTRACTORS): Promise<RecallEvaluation> {
  return withCorpus(distractors, async (service) => {
    const expected: string[][] = [];
    for (const topic of EVAL_TOPICS) {
      const ids: string[] = [];
      for (const note of topic.notes) ids.push((await service.writeNote(note)).noteId);
      expected.push(ids);
    }
    const lexical: string[][] = [];
    for (const topic of EVAL_TOPICS) {
      const recalled = await service.recall({
        cue: topic.cue,
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      lexical.push(recalled.items.map((item) => item.noteId));
    }
    return evaluateRecall(lexical, expected, 5);
  });
}

async function collect(): Promise<{
  readonly retention: number;
  readonly interference: number;
  readonly costMs: number;
}> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-memory-collect-'));
  const service = buildEvalService(homeDir);
  try {
    const distractorIds: string[] = [];
    for (const note of EVAL_DISTRACTORS) {
      distractorIds.push((await service.writeNote(note)).noteId);
    }
    const expected = new Map<string, string>();
    for (const topic of EVAL_TOPICS) {
      const ids: string[] = [];
      for (const note of topic.notes) ids.push((await service.writeNote(note)).noteId);
      expected.set(topic.cue, ids[0]!);
    }
    const startedAt = performance.now();
    const retention: RetentionSample[] = [];
    const interference: InterferenceSample[] = [];
    for (const topic of EVAL_TOPICS) {
      const recalled = await service.recall({
        cue: topic.cue,
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      const ids = recalled.items.map((item) => item.noteId);
      retention.push({ expectedId: expected.get(topic.cue)!, recalled: ids });
      interference.push({ recalled: ids, distractors: distractorIds });
    }
    return {
      retention: retentionRate(retention),
      interference: interferenceRate(interference),
      costMs: collectCostMs(startedAt, performance.now()),
    };
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory recall gate', () => {
  it('keeps every lexical cue at full hit@5 and MRR', async () => {
    for (let index = 0; index < 3; index += 1) {
      const evaluation = await measure();
      expect(evaluation.queries).toBe(EVAL_TOPICS.length);
      expect(evaluation.hitAt5).toBeGreaterThanOrEqual(LEXICAL_HIT5_FLOOR);
      expect(evaluation.mrr).toBeGreaterThanOrEqual(LEXICAL_MRR_FLOOR);
    }
  });

  it('produces the same ranking for freshly built stores', async () => {
    const first = await measure();
    const second = await measure();
    expect(second.hitAt5).toBe(first.hitAt5);
    expect(second.mrr).toBe(first.mrr);
  });

  it('keeps ranking under overlapping distractors above the recorded floor', async () => {
    const evaluation = await measure([...EVAL_DISTRACTORS, ...EVAL_HARD_DISTRACTORS]);
    expect(evaluation.queries).toBe(EVAL_TOPICS.length);
    expect(evaluation.hitAt5).toBeGreaterThanOrEqual(LEXICAL_HIT5_FLOOR);
    expect(evaluation.hitAt1).toBeGreaterThanOrEqual(HARD_HIT1_FLOOR);
    expect(evaluation.mrr).toBeGreaterThanOrEqual(HARD_MRR_FLOOR);
  });

  it('keeps ranking against per-topic near-duplicates above the recorded floor', async () => {
    const evaluation = await measure([...EVAL_DISTRACTORS, ...EVAL_SPARSE_DISTRACTORS]);
    expect(evaluation.queries).toBe(EVAL_TOPICS.length);
    expect(evaluation.hitAt5).toBeGreaterThanOrEqual(SPARSE_HIT5_FLOOR);
    expect(evaluation.mrr).toBeGreaterThanOrEqual(SPARSE_MRR_FLOOR);
  });

  it('returns the identical order for repeated recalls against one store', async () => {
    await withCorpus(EVAL_DISTRACTORS, async (service) => {
      const cue = EVAL_TOPICS[0]!.cue;
      const query = { cue, limit: 5, maxTokens: undefined, includeHistory: false };
      const first = await service.recall(query);
      const second = await service.recall(query);
      expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    });
  });

  it('collects retention, interference and cost from the real corpus', async () => {
    const collected = await collect();
    expect(collected.retention).toBeGreaterThanOrEqual(0);
    expect(collected.retention).toBeLessThanOrEqual(1);
    expect(collected.interference).toBeGreaterThanOrEqual(0);
    expect(collected.interference).toBeLessThanOrEqual(1);
    expect(collected.costMs).toBeGreaterThanOrEqual(0);
    const extended = evaluateExtended([], [], {
      retention: collected.retention,
      interference: collected.interference,
      costMs: collected.costMs,
    });
    expect(extended.retention).toBe(collected.retention);
    expect(extended.interference).toBe(collected.interference);
    expect(extended.costMs).toBe(collected.costMs);
  });
});
