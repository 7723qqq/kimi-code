import { describe, expect, it } from 'bun:test';

import { GIT_MEMORY_FLAG_ENV, GIT_MEMORY_FLAG_ID } from '#/features/gitMemory/flag';
import {
  GIT_MEMORY_FILE_COMMITS,
  GIT_MEMORY_INDEX_VERSION,
  GIT_MEMORY_MAX_FILES_PER_GROUP,
  GIT_MEMORY_REPO_COMMITS,
  GIT_MEMORY_SIGNAL_COMMITS,
  GIT_MEMORY_SIGNAL_PATHS,
  GIT_MEMORY_WINDOW,
} from '#/features/gitMemory/types';

describe('git memory thresholds', () => {
  it('pins the thresholds the spec fixes', () => {
    expect(GIT_MEMORY_WINDOW).toBe(1500);
    expect(GIT_MEMORY_REPO_COMMITS).toBe(5);
    expect(GIT_MEMORY_FILE_COMMITS).toBe(3);
    expect(GIT_MEMORY_SIGNAL_COMMITS).toBe(2);
    expect(GIT_MEMORY_SIGNAL_PATHS).toBe(2);
    expect(GIT_MEMORY_MAX_FILES_PER_GROUP).toBe(25);
    expect(GIT_MEMORY_INDEX_VERSION).toBe(1);
  });
});

describe('git memory flag', () => {
  it('uses the experimental env var and a stable flag id', () => {
    expect(GIT_MEMORY_FLAG_ENV).toBe('KIMI_CODE_EXPERIMENTAL_GIT_MEMORY');
    expect(GIT_MEMORY_FLAG_ID).toBe('git_memory');
  });
});
