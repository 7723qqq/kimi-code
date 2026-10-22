import { describe, expect, it } from 'bun:test';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  resolveTailContract,
  TAIL_ANCHOR_INJECTION_VARIANT,
  TAIL_ANCHOR_THRESHOLD_TOKENS,
} from '#/features/deepseekAdaptation/tailAnchorInjection';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import type { ContextInjectionContext } from '#/features/reminder/types';

function reminderMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: wrapSystemReminder(text) }],
  } as unknown as ContextMessage;
}

function injection(overrides: Partial<ContextInjectionContext> = {}): ContextInjectionContext {
  return {
    injectedPositions: [],
    lastInjectedAt: null,
    isNewTurn: true,
    ...overrides,
  } as ContextInjectionContext;
}

describe('deepseek tail contract injection', () => {
  it('fires past the threshold and carries both contract sections', () => {
    const text = resolveTailContract(
      injection({ estimatedTokens: TAIL_ANCHOR_THRESHOLD_TOKENS }),
      'deepseek-v4.1-flash',
    );
    expect(text).toContain('Objective:');
    expect(text).toContain('Hard constraints:');
  });

  it('stays quiet below the threshold', () => {
    expect(
      resolveTailContract(
        injection({ estimatedTokens: TAIL_ANCHOR_THRESHOLD_TOKENS - 1 }),
        'deepseek-v4.1-flash',
      ),
    ).toBeUndefined();
  });

  it('is idempotent while a previous injection is still in context', () => {
    expect(
      resolveTailContract(
        injection({
          estimatedTokens: TAIL_ANCHOR_THRESHOLD_TOKENS * 2,
          lastInjection: reminderMessage('Objective: earlier anchor'),
          lastInjectedAt: 3,
        }),
        'deepseek-v4.1-flash',
      ),
    ).toBeUndefined();
  });

  it('fires again once compaction dropped the previous injection', () => {
    expect(
      resolveTailContract(
        injection({ estimatedTokens: TAIL_ANCHOR_THRESHOLD_TOKENS * 2 }),
        'deepseek-v4.1-flash',
      ),
    ).toBeDefined();
  });

  it('ignores models outside the family and unknown wire names', () => {
    expect(
      resolveTailContract(
        injection({ estimatedTokens: TAIL_ANCHOR_THRESHOLD_TOKENS * 2 }),
        'gpt-4o',
      ),
    ).toBeUndefined();
    expect(
      resolveTailContract(injection({ estimatedTokens: TAIL_ANCHOR_THRESHOLD_TOKENS * 2 }), undefined),
    ).toBeUndefined();
  });

  it('exposes a stable variant name distinct from the adaptation variant', () => {
    expect(TAIL_ANCHOR_INJECTION_VARIANT).toBe('deepseek_tail_contract');
    expect(TAIL_ANCHOR_INJECTION_VARIANT).not.toBe('deepseek_adaptation');
  });
});
