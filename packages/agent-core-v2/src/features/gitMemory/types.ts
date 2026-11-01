export const GIT_MEMORY_WINDOW = 1500;
export const GIT_MEMORY_REPO_COMMITS = 25;
export const GIT_MEMORY_FILE_COMMITS = 8;
export const GIT_MEMORY_DIR_COMMITS = 5;
export const GIT_MEMORY_SIGNAL_COMMITS = 2;
export const GIT_MEMORY_SIGNAL_PATHS = 2;
export const GIT_MEMORY_MAX_FILES_PER_GROUP = 25;
export const GIT_MEMORY_TREE_DEPTH = 3;
export const GIT_MEMORY_INDEX_VERSION = 2;

export interface CommitRecord {
  readonly sha: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
  readonly body: string;
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
  readonly dirs: readonly string[];
}
