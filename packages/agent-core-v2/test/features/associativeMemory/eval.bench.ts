import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { evaluateRecall, formatEvaluation } from '#/features/associativeMemory/eval';
import { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { stubBootstrap } from '../../app/bootstrap/stubs';

interface Topic {
  readonly name: string;
  readonly cue: string;
  readonly synonymCue: string;
  readonly notes: readonly string[];
}

const TOPICS: readonly Topic[] = [
  {
    name: 'auth',
    cue: 'login session credential',
    synonymCue: 'sign in',
    notes: [
      'the authentication service refreshes the session token twice before failing',
      'session credentials expire after seven days',
    ],
  },
  {
    name: 'cache',
    cue: 'redis ttl expiry',
    synonymCue: 'in memory store',
    notes: [
      'the cache layer sets a 30 second ttl on entries',
      'cache eviction runs every minute under memory pressure',
    ],
  },
  {
    name: 'deploy',
    cue: 'release rollout revert',
    synonymCue: 'ship a build',
    notes: [
      'the deploy rollout pauses on error rates',
      'rollback reverts the previous artifact',
    ],
  },
  {
    name: 'billing',
    cue: 'payment invoice charge',
    synonymCue: 'charge the card',
    notes: [
      'the billing invoice proration rounds down',
      'invoice generation runs at midnight',
    ],
  },
  {
    name: 'search',
    cue: 'index shard query',
    synonymCue: 'look things up',
    notes: [
      'the search index sharding splits by tenant',
      'index rebuilds run offline',
    ],
  },
  {
    name: 'notify',
    cue: 'email alert delivery',
    synonymCue: 'ping the oncall',
    notes: [
      'the notification service retries email delivery twice',
      'alert digests are sent every hour',
    ],
  },
];

const DISTRACTORS: readonly string[] = [
  'the week starts on monday',
  'the office kitchen is on the third floor',
  'the team meets every tuesday afternoon',
];

describe('associative memory recall benchmark', () => {
  let homeDir: string;

  beforeAll(async () => {
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'associative-memory-eval-'));
  });

  afterAll(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  it('measures hit@k and mrr on a synthetic corpus', async () => {
    const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
    const service = new (class extends AssociativeMemoryService {
      constructor() {
        super(
          bootstrap as never,
          { enabled: () => true } as never,
          { debug() {}, info() {}, warn() {}, error() {} } as never,
          { register: () => ({ dispose() {} }) } as never,
          { get: () => [] } as never,
        );
      }
      protected override now(): number {
        return 1_000;
      }
    })();

    for (const note of DISTRACTORS) await service.writeNote(note);

    const expected: string[][] = [];
    for (const topic of TOPICS) {
      const noteIds: string[] = [];
      for (const note of topic.notes) {
        const written = await service.writeNote(note);
        noteIds.push(written.noteId);
      }
      expected.push(noteIds);
    }

    const results: string[][] = [];
    for (const topic of TOPICS) {
      const recalled = await service.recall({
        cue: topic.cue,
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      results.push(recalled.items.map((item) => item.noteId));
    }

    const synonymResults: string[][] = [];
    for (const topic of TOPICS) {
      const recalled = await service.recall({
        cue: topic.synonymCue,
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      synonymResults.push(recalled.items.map((item) => item.noteId));
    }

    console.log(`\nassociative memory recall benchmark (${String(TOPICS.length)} topics)`);
    TOPICS.forEach((topic, index) => {
      const single = evaluateRecall([results[index]!], [expected[index]!], 5);
      console.log(`  ${topic.name.padEnd(8)} lexical  ${formatEvaluation(single)}`);
    });
    console.log(`  overall  lexical  ${formatEvaluation(evaluateRecall(results, expected, 5))}`);
    console.log('  (synonym cues share no terms with the notes: sparse-only baseline,');
    console.log('   external embeddings are expected to lift these)');
    TOPICS.forEach((topic, index) => {
      const single = evaluateRecall([synonymResults[index]!], [expected[index]!], 5);
      console.log(`  ${topic.name.padEnd(8)} synonym  ${formatEvaluation(single)}`);
    });
    console.log(`  overall  synonym  ${formatEvaluation(evaluateRecall(synonymResults, expected, 5))}`);

    const overall = evaluateRecall(results, expected, 5);
    expect(overall.queries).toBe(TOPICS.length);
    expect(overall.hitAt5).toBeGreaterThan(0);
  });
});
