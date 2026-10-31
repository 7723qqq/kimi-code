import { describe, expect, it } from 'bun:test';

import { GIT_MEMORY_FLAG_ENV, GIT_MEMORY_FLAG_ID } from '#/features/gitMemory/flag';
import {
  GIT_MEMORY_CHANGE_GROUPS,
  GIT_MEMORY_INVARIANT_LIMIT,
  GIT_MEMORY_INVARIANT_MIN_COUNT,
  GIT_MEMORY_INVARIANT_MIN_SCORE,
  GIT_MEMORY_MANIFEST_LIMIT,
  GIT_MEMORY_MAX_FILES_PER_GROUP,
  GIT_MEMORY_MAX_PARTNERS,
  GIT_MEMORY_PARTNER_MIN_COUNT,
  GIT_MEMORY_PARTNER_MIN_SCORE,
  GIT_MEMORY_WINDOW,
} from '#/features/gitMemory/types';

describe('git memory thresholds', () => {
  it('pins the thresholds the spec fixes', () => {
    expect(GIT_MEMORY_WINDOW).toBe(1500);
    expect(GIT_MEMORY_CHANGE_GROUPS).toBe(3);
    expect(GIT_MEMORY_INVARIANT_MIN_COUNT).toBe(5);
    expect(GIT_MEMORY_INVARIANT_MIN_SCORE).toBe(0.9);
    expect(GIT_MEMORY_INVARIANT_LIMIT).toBe(12);
    expect(GIT_MEMORY_PARTNER_MIN_COUNT).toBe(5);
    expect(GIT_MEMORY_PARTNER_MIN_SCORE).toBe(0.8);
    expect(GIT_MEMORY_MAX_FILES_PER_GROUP).toBe(25);
    expect(GIT_MEMORY_MANIFEST_LIMIT).toBe(30);
    expect(GIT_MEMORY_MAX_PARTNERS).toBe(10);
  });
});

describe('git memory flag', () => {
  it('uses the experimental env var and a stable flag id', () => {
    expect(GIT_MEMORY_FLAG_ENV).toBe('KIMI_CODE_EXPERIMENTAL_GIT_MEMORY');
    expect(GIT_MEMORY_FLAG_ID).toBe('git_memory');
  });
});
