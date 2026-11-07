import { describe, expect, it } from 'bun:test';

import { classifyGating } from '#/features/associativeMemory/gating';

describe('memory gating', () => {
  it('enters encode mode for a new scope or topic', () => {
    expect(
      classifyGating({
        sameCueRepeated: false,
        unstableRecall: false,
        newScopeOrTopic: true,
        positiveFeedback: false,
      }).mode,
    ).toBe('encode');
  });

  it('enters consolidate mode for an unstable repeated cue', () => {
    expect(
      classifyGating({
        sameCueRepeated: true,
        unstableRecall: true,
        newScopeOrTopic: false,
        positiveFeedback: false,
      }).mode,
    ).toBe('consolidate');
  });

  it('uses positive feedback to boost write strength', () => {
    expect(
      classifyGating({
        sameCueRepeated: false,
        unstableRecall: false,
        newScopeOrTopic: true,
        positiveFeedback: true,
      }).boost,
    ).toBeGreaterThan(1);
  });
});
