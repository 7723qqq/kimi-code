import { join } from 'node:path';

import { resetRendered } from '#/agent/injection/renderedLines';
import { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { stubBootstrap } from '../../app/bootstrap/stubs';

export interface EvalTopic {
  readonly name: string;
  readonly cue: string;
  readonly synonymCue: string;
  readonly notes: readonly string[];
}

export const EVAL_TOPICS: readonly EvalTopic[] = [
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

export const EVAL_DISTRACTORS: readonly string[] = [
  'the week starts on monday',
  'the office kitchen is on the third floor',
  'the team meets every tuesday afternoon',
  'the rollout meeting moved the cache ttl discussion to the third floor',
  'invoice questions go to the office manager on the third floor',
  'the monday alert digest mentions the deploy rollout and the search index',
];

export const EVAL_HARD_DISTRACTORS: readonly string[] = [
  'the cache ttl discussion moved to the deploy rollout meeting',
  'invoice charge failed because the session credential expired',
  'the search index rebuild paused the email alert digest',
  'the rollout reverted the cache layer change and the billing invoice',
  'session token refresh and cache eviction share the same timer',
  'the notification service alert uses the same index shard as search',
  'the payment invoice and the deploy artifact share a release note',
  'alert digests and cache eviction both run on the same minute boundary',
];

export const EVAL_SPARSE_DISTRACTORS: readonly string[] = [
  'the cache layer sets a ttl of 60 on cached entries',
  'the billing invoice charge prorates the rounded amount',
  'the deploy rollout reverts the released artifact on errors',
  'the search index query splits the shard by tenant',
  'the email alert delivery retries the digest hourly',
  'the login session credential refreshes the token twice',
];

export function buildEvalService(homeDir: string): AssociativeMemoryService {
  resetRendered();
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  const service = new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project'), sessionId: homeDir } as never,
        { list: async () => [], get: async () => undefined, setReadOnly() {} } as never,
      );
    }
    protected override now(): number {
      return 1_000;
    }
  })();
  return service;
}
