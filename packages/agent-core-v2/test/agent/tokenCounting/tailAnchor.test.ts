import { describe, expect, it } from 'bun:test';

import {
  planTailContract,
  renderTailContract,
  shouldReanchorTail,
  TAIL_CONTRACT_MAX_CHARS,
} from '#/agent/tokenCounting/tailAnchor';

describe('shouldReanchorTail', () => {
  it('fires exactly at the threshold', () => {
    expect(shouldReanchorTail({ estimatedTokens: 999, threshold: 1000 })).toBe(false);
    expect(shouldReanchorTail({ estimatedTokens: 1000, threshold: 1000 })).toBe(true);
  });

  it('stays quiet below the threshold even with a prior anchor', () => {
    expect(
      shouldReanchorTail({ estimatedTokens: 999, threshold: 1000, lastAnchorTokens: 0 }),
    ).toBe(false);
  });

  it('measures growth since the last anchor', () => {
    expect(
      shouldReanchorTail({ estimatedTokens: 1900, threshold: 1000, lastAnchorTokens: 1000 }),
    ).toBe(false);
    expect(
      shouldReanchorTail({ estimatedTokens: 2000, threshold: 1000, lastAnchorTokens: 1000 }),
    ).toBe(true);
  });

  it('never fires without a positive threshold', () => {
    expect(shouldReanchorTail({ estimatedTokens: 100000, threshold: 0 })).toBe(false);
  });

  it('is a pure function of its input', () => {
    const input = { estimatedTokens: 1200, threshold: 1000, lastAnchorTokens: 100 } as const;
    expect(shouldReanchorTail(input)).toBe(shouldReanchorTail(input));
  });
});

describe('planTailContract', () => {
  const base = {
    goal: 'ship the fix',
    constraints: ['no new deps', 'tests must pass'],
    threshold: 1000,
  } as const;

  it('renders the objective and the hard constraints', () => {
    const text = planTailContract({ ...base, estimatedTokens: 1200 });
    expect(text).toContain('Objective: ship the fix');
    expect(text).toContain('Hard constraints:');
    expect(text).toContain('- no new deps');
  });

  it('is idempotent while an injection is still present', () => {
    expect(
      planTailContract({ ...base, estimatedTokens: 1200, lastInjected: 'Objective: ship the fix' }),
    ).toBeUndefined();
  });

  it('fires again once compaction dropped the previous injection', () => {
    expect(planTailContract({ ...base, estimatedTokens: 1200, lastInjected: '   ' })).toBeDefined();
  });

  it('renders nothing below the threshold', () => {
    expect(planTailContract({ ...base, estimatedTokens: 10 })).toBeUndefined();
  });

  it('stays within the contract budget', () => {
    const text = renderTailContract({
      goal: 'x'.repeat(5000),
      constraints: ['y'.repeat(5000)],
    });
    expect(text.length).toBeLessThanOrEqual(TAIL_CONTRACT_MAX_CHARS);
  });
});
