import { GIT_MEMORY_MAX_FILES_PER_GROUP } from './types';
import type { CommitRecord } from './types';

export function projectCommit(commit: CommitRecord, seen: ReadonlySet<string>): string[] {
  const short = commit.sha.slice(0, 7);
  if (seen.has(commit.sha)) return [`see commit ${short} above`];
  const lines = [`Commit ${short} ${commit.date} ${commit.author}`, `  ${commit.subject}`];
  const hasBody = commit.body.length > 0;
  if (hasBody) {
    for (const line of commit.body.split('\n')) lines.push(`  ${line}`);
  }
  if (commit.files.length > GIT_MEMORY_MAX_FILES_PER_GROUP) return lines;
  if (hasBody && commit.files.length > 0) lines.push('');
  for (const file of commit.files) lines.push(`  ${file}`);
  return lines;
}

export interface MemoryEntryView {
  readonly sha: string;
  readonly date: string;
  readonly title: string;
  readonly body: string;
}

export function projectMemoryBlock(entry: MemoryEntryView): string {
  return `<memory sha="${entry.sha}" date="${entry.date}">\n${entry.title}\n${entry.body}\n</memory>`;
}

export function projectRepoBlock(commits: readonly CommitRecord[]): string {
  if (commits.length === 0) return '';
  const lines: string[] = [];
  for (const commit of commits) lines.push(...projectCommit(commit, new Set<string>()));
  return `<repo-memory>\n${lines.join('\n')}\n</repo-memory>`;
}

export function projectRepoTree(dirs: readonly string[], depth: number): string {
  const lines = dirs.filter((dir) => dir.split('/').length <= depth);
  if (lines.length === 0) return '';
  return `<repo-tree depth="${String(depth)}">\n${lines.join('\n')}\n</repo-tree>`;
}

export function projectFileBlock(
  path: string,
  commits: readonly CommitRecord[],
  dirPath: string,
  dirCommits: readonly CommitRecord[],
  seen: ReadonlySet<string>,
): string {
  const local = new Set(seen);
  const lines: string[] = [];
  for (const commit of commits) {
    lines.push(...projectCommit(commit, local));
    local.add(commit.sha);
  }
  const parts: string[] = [];
  if (lines.length > 0) parts.push(lines.join('\n'));
  if (dirPath.length > 0 && dirCommits.length > 0) {
    parts.push(projectDirBlock(dirPath, dirCommits, local));
  }
  if (parts.length === 0) return '';
  return `<file-memory path="${path}">\n${parts.join('\n')}\n</file-memory>`;
}

export function projectDirBlock(
  path: string,
  commits: readonly CommitRecord[],
  seen: ReadonlySet<string>,
): string {
  if (commits.length === 0) return '';
  const lines: string[] = [];
  for (const commit of commits) lines.push(...projectCommit(commit, seen));
  return `<dir-memory path="${path}">\n${lines.join('\n')}\n</dir-memory>`;
}

export function projectSignalBlock(
  path: string,
  commits: readonly CommitRecord[],
  seen: ReadonlySet<string>,
): string {
  if (commits.length === 0) return '';
  const lines: string[] = [];
  for (const commit of commits) lines.push(...projectCommit(commit, seen));
  return `<repo-memory signal="${path}">\n${lines.join('\n')}\n</repo-memory>`;
}
