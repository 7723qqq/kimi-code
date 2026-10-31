import {
  GIT_MEMORY_MANIFEST_LIMIT,
  GIT_MEMORY_MAX_DIRS,
  GIT_MEMORY_MAX_PARTNERS,
} from './types';
import type { ChangeGroup, GitFacts, Partner } from './types';

const CONTROL_AND_SPACE = /[\s\u0000-\u001f\u007f-\u009f]+/g;
const IMPERATIVE = /\b(must|should|shall|need to|have to|required to)\b/i;

export function sanitizeText(value: string, maxLength: number): string {
  const collapsed = value.replace(CONTROL_AND_SPACE, ' ').trim();
  if (maxLength <= 0) return '';
  if (collapsed.length <= maxLength) return collapsed;
  if (maxLength === 1) return '…';
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toFixed(2);
}

function changeLines(group: ChangeGroup): string[] {
  const lines = [
    `Change ${group.sha.slice(0, 7)} (${group.date}) ${sanitizeText(group.subject, 120)} - touched ${group.fileCount} files:`,
  ];
  if (group.truncated) {
    const dirs = group.dirs.slice(0, GIT_MEMORY_MAX_DIRS);
    lines.push(`  directories: ${dirs.map((dir) => sanitizeText(dir, 140)).join(', ')}`);
    if (group.dirs.length > dirs.length) {
      lines.push(`  ... and ${group.dirs.length - dirs.length} more directories`);
    }
  } else {
    for (const file of group.files) lines.push(`  ${sanitizeText(file, 140)}`);
  }
  lines.push(`  -> git show ${group.sha} --stat`);
  return lines;
}

function partnerText(partners: readonly Partner[]): string {
  return partners
    .slice(0, GIT_MEMORY_MAX_PARTNERS)
    .map(
      (partner) =>
        `${sanitizeText(partner.path, 140)} (${partner.count}, ${formatScore(partner.score)})`,
    )
    .join(', ');
}

export function renderRepoBlock(facts: GitFacts): string {
  const lines: string[] = [];

  if (facts.conventions.length > 0) {
    const text = facts.conventions
      .map((entry) => `${sanitizeText(entry.prefix, 40)} ${entry.count}`)
      .join(', ');
    lines.push(`Commit conventions: ${text}`);
  }

  const manifest = Object.entries(facts.strengths)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, GIT_MEMORY_MANIFEST_LIMIT);
  if (manifest.length > 0) {
    lines.push('path | last-change sha | intent | strength');
    for (const [path, strength] of manifest) {
      const group = facts.fileChanges[path]?.[0];
      const sha = group === undefined ? '' : group.sha.slice(0, 7);
      const subject = group === undefined ? '' : sanitizeText(group.subject, 100);
      lines.push(`${sanitizeText(path, 140)} | ${sha} | ${subject} | ${strength}`);
    }
  }

  if (facts.invariants.length > 0) {
    lines.push('Usually changes together:');
    for (const invariant of facts.invariants) {
      lines.push(
        `  ${sanitizeText(invariant.a, 140)} <-> ${sanitizeText(invariant.b, 140)} (${invariant.count})`,
      );
    }
  }

  if (lines.length === 0) return '';
  return `<repo-memory>\n${lines.join('\n')}\n</repo-memory>`;
}

export function renderFileBlock(
  path: string,
  groups: readonly ChangeGroup[],
  partners: readonly Partner[],
): string {
  const lines: string[] = [];
  for (const group of groups) lines.push(...changeLines(group));
  if (partners.length > 0) {
    lines.push(`Usually changes with: ${partnerText(partners)}`);
  }
  if (lines.length === 0) return '';
  return `<file-memory path="${sanitizeText(path, 200)}">\n${lines.join('\n')}\n</file-memory>`;
}

export function renderSignalBlock(
  entries: readonly { readonly path: string; readonly groups: readonly ChangeGroup[] }[],
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.groups.length === 0) continue;
    lines.push(`${sanitizeText(entry.path, 200)}:`);
    for (const group of entry.groups) lines.push(...changeLines(group));
  }
  if (lines.length === 0) return '';
  return `<repo-memory signal="true">\n${lines.join('\n')}\n</repo-memory>`;
}

export function containsImperative(text: string): boolean {
  return IMPERATIVE.test(text);
}
