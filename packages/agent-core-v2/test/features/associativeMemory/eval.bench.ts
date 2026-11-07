import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { evaluateRecall, formatEvaluation } from '#/features/associativeMemory/eval';

import {
  EVAL_DISTRACTORS,
  EVAL_HARD_DISTRACTORS,
  EVAL_SPARSE_DISTRACTORS,
  EVAL_TOPICS,
  buildEvalService,
} from './eval-corpus';

const TIERS: readonly (readonly [string, readonly string[]])[] = [
  ['easy', EVAL_DISTRACTORS],
  ['clustered', [...EVAL_DISTRACTORS, ...EVAL_HARD_DISTRACTORS]],
  ['per-topic-duplicates', [...EVAL_DISTRACTORS, ...EVAL_SPARSE_DISTRACTORS]],
];

interface TierReport {
  readonly lexical: ReturnType<typeof evaluateRecall>;
  readonly synonym: ReturnType<typeof evaluateRecall>;
}

async function evaluateTier(distractors: readonly string[]): Promise<TierReport> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-memory-bench-'));
  const service = buildEvalService(homeDir);
  try {
    for (const note of distractors) await service.writeNote(note);

    const expected: string[][] = [];
    for (const topic of EVAL_TOPICS) {
      const ids: string[] = [];
      for (const note of topic.notes) ids.push((await service.writeNote(note)).noteId);
      expected.push(ids);
    }

    const lexical: string[][] = [];
    const synonym: string[][] = [];
    for (const topic of EVAL_TOPICS) {
      const cued = await service.recall({
        cue: topic.cue,
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      lexical.push(cued.items.map((item) => item.noteId));
      const paraphrased = await service.recall({
        cue: topic.synonymCue,
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      synonym.push(paraphrased.items.map((item) => item.noteId));
    }

    return {
      lexical: evaluateRecall(lexical, expected, 5),
      synonym: evaluateRecall(synonym, expected, 5),
    };
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory recall benchmark', () => {
  for (const [name, distractors] of TIERS) {
    it(`reports recall for the ${name} tier`, async () => {
      const report = await evaluateTier(distractors);
      console.log(`\n${name}`);
      console.log(`  lexical  ${formatEvaluation(report.lexical)}`);
      console.log(`  synonym  ${formatEvaluation(report.synonym)}`);
      expect(report.lexical.queries).toBe(EVAL_TOPICS.length);
      expect(report.lexical.hitAt5).toBeGreaterThan(0);
    });
  }
});
