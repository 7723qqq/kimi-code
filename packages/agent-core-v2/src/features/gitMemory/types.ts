export const GIT_MEMORY_WINDOW = 1500;
export const GIT_MEMORY_CHANGE_GROUPS = 3;
export const GIT_MEMORY_INVARIANT_MIN_COUNT = 5;
export const GIT_MEMORY_INVARIANT_MIN_SCORE = 0.9;
export const GIT_MEMORY_INVARIANT_LIMIT = 12;
export const GIT_MEMORY_PARTNER_MIN_COUNT = 5;
export const GIT_MEMORY_PARTNER_MIN_SCORE = 0.8;
export const GIT_MEMORY_MAX_FILES_PER_GROUP = 25;
export const GIT_MEMORY_CLIQUE_PARTNER_LIMIT = 30;
export const GIT_MEMORY_INDEX_VERSION = 1;

export interface CommitInput {
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
  readonly files: readonly string[];
}

export interface ChangeGroup {
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export interface Partner {
  readonly path: string;
  readonly count: number;
  readonly score: number;
}

export interface Invariant {
  readonly a: string;
  readonly b: string;
  readonly count: number;
}

export interface ConventionEntry {
  readonly prefix: string;
  readonly count: number;
}

export interface GitFacts {
  readonly conventions: readonly ConventionEntry[];
  readonly invariants: readonly Invariant[];
  readonly fileChanges: Readonly<Record<string, readonly ChangeGroup[]>>;
  readonly filePartners: Readonly<Record<string, readonly Partner[]>>;
  readonly strengths: Readonly<Record<string, number>>;
}

export interface GitMemoryIndex {
  readonly version: number;
  readonly repoRoot: string;
  readonly headSha: string;
  readonly window: number;
  readonly computedAt: string;
  readonly facts: GitFacts;
}
