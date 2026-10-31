export const GIT_MEMORY_WINDOW = 1500;
export const GIT_MEMORY_REPO_COMMITS = 5;
export const GIT_MEMORY_FILE_COMMITS = 3;
export const GIT_MEMORY_SIGNAL_COMMITS = 2;
export const GIT_MEMORY_SIGNAL_PATHS = 2;
export const GIT_MEMORY_MAX_FILES_PER_GROUP = 25;
export const GIT_MEMORY_INDEX_VERSION = 1;

export interface CommitRecord {
  readonly sha: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
  readonly files: readonly string[];
}

export interface GitMemoryIndex {
  readonly version: number;
  readonly repoRoot: string;
  readonly headSha: string;
  readonly window: number;
  readonly computedAt: string;
  readonly commits: readonly CommitRecord[];
  readonly byPath: Readonly<Record<string, readonly number[]>>;
}
