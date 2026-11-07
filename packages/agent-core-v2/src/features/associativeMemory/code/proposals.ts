import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'pathe';
import { dump } from 'js-yaml';

import { parseFrontmatter } from '#/_base/text/frontmatter';

import { toHardRule } from './rules';
import type { HardRule, MemoryCode } from '../types';

export const proposalsFileName = 'proposals.md';
export const MAX_PENDING_PROPOSALS = 50;

async function readProposalLines(path: string): Promise<string[]> {
  try {
    const text = await Bun.file(path).text();
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export async function proposeRule(homeDir: string, storeRoot: string, rule: unknown): Promise<void> {
  const dir = join(homeDir, storeRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, proposalsFileName);
  const lines = [...(await readProposalLines(path)), `- ${JSON.stringify(rule)}`];
  const kept = lines.slice(-MAX_PENDING_PROPOSALS);
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
}

export async function approveProposal(
  homeDir: string,
  storeRoot: string,
  index: number,
  defaults: MemoryCode,
): Promise<HardRule> {
  const dir = join(homeDir, storeRoot);
  const proposalsPath = join(dir, proposalsFileName);
  const lines = (await Bun.file(proposalsPath).text())
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const picked = lines[index];
  if (picked === undefined) throw new Error(`proposal ${String(index)} not found`);
  const rule = toHardRule(JSON.parse(picked.replace(/^-\s*/, '')));
  if (rule === undefined) throw new Error(`proposal ${String(index)} is not a valid rule`);

  const codePath = join(dir, 'code.md');
  let content = '';
  try {
    content = await Bun.file(codePath).text();
  } catch {
    content = '';
  }
  const parsed = parseFrontmatter(content);
  const data = parsed.data as { rules?: unknown } | null | undefined;
  const existing = Array.isArray(data?.rules) ? (data.rules as HardRule[]) : [];
  const rules = [...defaults.rules, ...existing, rule];
  const body = (parsed.body ?? '').trim();
  await writeFile(
    codePath,
    `---\n${dump({ rules })}---\n${body.length > 0 ? `${body}\n` : ''}`,
    'utf8',
  );

  const remaining = [...lines.slice(0, index), ...lines.slice(index + 1)];
  if (remaining.length === 0) {
    await writeFile(proposalsPath, '', 'utf8');
  } else {
    await writeFile(proposalsPath, `${remaining.join('\n')}\n`, 'utf8');
  }
  return rule;
}

export function proposalsPath(homeDir: string, storeRoot: string): string {
  return join(homeDir, storeRoot, proposalsFileName);
}
