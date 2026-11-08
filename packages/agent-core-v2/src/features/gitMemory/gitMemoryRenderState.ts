import type { CommitRecord } from './types';

const RENDER_STATE_CAP = 512;

export class GitMemoryRenderState {
  private readonly paths = new Set<string>();
  private readonly commits = new Set<string>();
  private readonly memories = new Set<string>();
  private readonly directoryHistory = new Map<string, readonly CommitRecord[]>();
  private readonly memoryScopes = new Map<string, string[]>();

  hasPath(path: string): boolean {
    return this.paths.has(path);
  }

  markPath(path: string): void {
    this.paths.add(path);
  }

  get renderedCommits(): ReadonlySet<string> {
    return this.commits;
  }

  markCommit(sha: string): void {
    this.commits.add(sha);
  }

  hasMemory(sha: string): boolean {
    return this.memories.has(sha);
  }

  markMemory(sha: string): void {
    this.memories.add(sha);
  }

  clearMemories(): void {
    this.memories.clear();
  }

  directoryCommits(directory: string): readonly CommitRecord[] | undefined {
    return this.directoryHistory.get(directory);
  }

  setDirectoryCommits(directory: string, commits: readonly CommitRecord[]): void {
    this.directoryHistory.set(directory, commits);
  }

  scopes(path: string): string[] | undefined {
    return this.memoryScopes.get(path);
  }

  setScopes(path: string, patterns: string[]): void {
    this.memoryScopes.set(path, patterns);
  }

  clear(): void {
    this.paths.clear();
    this.commits.clear();
    this.memories.clear();
    this.directoryHistory.clear();
    this.memoryScopes.clear();
  }

  trim(): void {
    trimSet(this.paths);
    trimSet(this.commits);
    trimSet(this.memories);
    trimMap(this.directoryHistory);
    trimMap(this.memoryScopes);
  }
}

function trimSet(set: Set<string>): void {
  while (set.size > RENDER_STATE_CAP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

function trimMap<K, V>(map: Map<K, V>): void {
  while (map.size > RENDER_STATE_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
