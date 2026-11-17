import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { isHiddenFromModel } from '../packages/agent-core-v2/src/features/skill/catalog/configSection';
import { parseSkillText } from '../packages/agent-core-v2/src/features/skill/catalog/parser';
import type { SkillDefinition, SkillSource } from '../packages/agent-core-v2/src/features/skill/catalog/types';

interface DiscoveredSkill {
  readonly source: SkillSource;
  readonly root: string;
  readonly dirName: string;
  readonly path: string;
  readonly bytes: number;
  readonly skill?: SkillDefinition;
  readonly error?: string;
}

interface SkillReport extends DiscoveredSkill {
  readonly flags: readonly string[];
  readonly winner: boolean;
  readonly listingBytes: number;
}

const LISTING_DESC_MAX = 250;
const BIG_BODY_BYTES = 20 * 1024;
const BROAD_HINTS = /\b(all|any|general|generic|various|comprehensive|everything)\b|通用|各种|全面|任意/i;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function collect(root: string, source: SkillSource, out: DiscoveredSkill[]): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillMdPath = join(full, 'SKILL.md');
    let text: string;
    try {
      text = readFileSync(skillMdPath, 'utf8');
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    try {
      const skill = parseSkillText({ skillMdPath, skillDirName: name, source, text });
      out.push({ source, root, dirName: name, path: skillMdPath, bytes, skill });
    } catch (error) {
      out.push({
        source,
        root,
        dirName: name,
        path: skillMdPath,
        bytes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function listingBytesOf(skill: SkillDefinition): number {
  const lines = [`- ${skill.name}: ${truncate(skill.description, LISTING_DESC_MAX)}`];
  if (typeof skill.metadata.whenToUse === 'string' && skill.metadata.whenToUse.length > 0) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}

function isBlackHole(skill: SkillDefinition): boolean {
  const words = skill.name.split(/[\s_-]+/).filter((word) => word.length > 0);
  const nameShort = skill.name.length <= 14 && words.length <= 2;
  return nameShort && BROAD_HINTS.test(skill.description);
}

function flagOf(entry: DiscoveredSkill, winner: boolean): readonly string[] {
  const flags: string[] = [];
  if (entry.error !== undefined) flags.push('parse-error');
  if (entry.skill !== undefined) {
    if (!winner) flags.push('duplicate');
    if (entry.bytes > BIG_BODY_BYTES) flags.push('big-body');
    if (entry.skill.description.length > LISTING_DESC_MAX) flags.push('long-desc');
    if (isBlackHole(entry.skill)) flags.push('black-hole');
    if (entry.skill.metadata.verify === undefined) flags.push('no-verify');
  }
  return flags;
}

export interface AuditOptions {
  readonly roots: ReadonlyArray<readonly [string, SkillSource]>;
  readonly hidden?: readonly string[];
  readonly subSkills?: readonly string[];
}

export interface AuditResult {
  readonly discovered: number;
  readonly unique: number;
  readonly duplicates: number;
  readonly parseErrors: number;
  readonly listingChars: number;
  readonly listingTokensApprox: number;
  readonly flagCounts: Readonly<Record<string, number>>;
  readonly reports: readonly SkillReport[];
  readonly clusters: readonly { readonly label: string; readonly names: readonly string[] }[];
}

export function auditSkills(options: AuditOptions): AuditResult {
  const all: DiscoveredSkill[] = [];
  for (const [root, source] of options.roots) collect(root, source, all);

  const rank = (source: SkillSource): number =>
    source === 'project' ? 4 : source === 'user' ? 3 : source === 'extra' ? 2 : 1;
  const winners = new Map<string, { entry: DiscoveredSkill; skill: SkillDefinition }>();
  const losers = new Set<string>();
  for (const entry of all) {
    const skill = entry.skill;
    if (skill === undefined) continue;
    const name = skill.name.toLowerCase();
    const seen = winners.get(name);
    if (seen === undefined) {
      winners.set(name, { entry, skill });
      continue;
    }
    if (rank(skill.source) > rank(seen.skill.source)) {
      losers.add(seen.entry.path);
      winners.set(name, { entry, skill });
    } else {
      losers.add(entry.path);
    }
  }

  const reports: SkillReport[] = all.map((entry) => {
    const winner = entry.skill === undefined || !losers.has(entry.path);
    return {
      ...entry,
      winner,
      flags: flagOf(entry, winner),
      listingBytes: entry.skill === undefined || !winner ? 0 : listingBytesOf(entry.skill),
    };
  });

  const flagCounts: Record<string, number> = {};
  for (const report of reports) {
    for (const flag of report.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
  }

  const hidden = options.hidden ?? [];
  const subSkills = options.subSkills ?? [];
  const folded = (name: string): boolean =>
    isHiddenFromModel(name, hidden) || isHiddenFromModel(name, subSkills);
  const listingChars = reports.reduce(
    (sum, report) => sum + (report.skill !== undefined && folded(report.skill.name) ? 0 : report.listingBytes),
    0,
  );
  const clusters = new Map<string, string[]>();
  for (const report of reports) {
    if (report.skill === undefined || !report.winner) continue;
    const label = report.skill.name.toLowerCase().split(/[\s_-]+/)[0] ?? report.skill.name;
    const bucket = clusters.get(label) ?? [];
    bucket.push(report.skill.name);
    clusters.set(label, bucket);
  }

  return {
    discovered: all.length,
    unique: winners.size,
    duplicates: losers.size,
    parseErrors: all.filter((entry) => entry.error !== undefined).length,
    listingChars,
    listingTokensApprox: Math.ceil(listingChars / 4),
    flagCounts,
    reports,
    clusters: [...clusters.entries()]
      .filter(([, names]) => names.length > 1)
      .toSorted((a, b) => b[1].length - a[1].length)
      .map(([label, names]) => ({ label, names: names.toSorted() })),
  };
}

function defaultRoots(): Array<readonly [string, SkillSource]> {
  const home = homedir();
  return [
    [join(process.cwd(), '.agents/skills'), 'project'],
    [join(home, '.kimi-code/skills'), 'user'],
    [join(home, '.agents/skills'), 'user'],
  ];
}

function render(result: AuditResult): string {
  const header = [
    `skill audit: ${String(result.discovered)} discovered, ${String(result.unique)} unique, ` +
      `${String(result.duplicates)} duplicates, ${String(result.parseErrors)} parse errors`,
    `listing: ${String(result.listingChars)} chars, ~${String(result.listingTokensApprox)} tokens`,
  ];
  const flagLines: string[] = ['flags'];
  for (const [flag, count] of Object.entries(result.flagCounts).toSorted((a, b) => b[1] - a[1])) {
    flagLines.push(`  ${flag.padEnd(14)} ${String(count)}`);
  }
  const biggest = result.reports
    .filter((report) => report.skill !== undefined && report.winner)
    .toSorted((a, b) => b.bytes - a.bytes)
    .slice(0, 12);
  const sizeLines: string[] = ['largest'];
  for (const report of biggest) {
    sizeLines.push(
      `  ${(report.bytes / 1024).toFixed(1).padStart(6)} KB  ${report.skill?.name ?? report.dirName}`,
    );
  }
  const blackHoles = result.reports.filter((report) => report.flags.includes('black-hole'));
  const holeLines: string[] = [`black-hole candidates (${String(blackHoles.length)})`];
  for (const report of blackHoles.slice(0, 20)) {
    holeLines.push(`  ${report.skill?.name ?? report.dirName}`);
  }
  const clusterLines: string[] = [`merge candidates (${String(result.clusters.length)} clusters)`];
  for (const cluster of result.clusters.slice(0, 15)) {
    clusterLines.push(`  ${cluster.label}: ${cluster.names.join(', ')}`);
  }
  return [...header, '', ...flagLines, '', ...sizeLines, '', ...holeLines, '', ...clusterLines].join(
    '\n',
  );
}

function isMain(): boolean {
  return process.argv[1] !== undefined && basename(process.argv[1]).startsWith('skills-audit');
}

if (isMain()) {
  const roots = defaultRoots().filter(([root]) => existsSync(root));
  const readPatterns = (flag: string): string[] => {
    const argv = process.argv.find((arg) => arg.startsWith(`${flag}=`));
    return argv === undefined ? [] : argv.slice(flag.length + 1).split(',').filter((v) => v.length > 0);
  };
  const result = auditSkills({
    roots,
    hidden: readPatterns('--hidden'),
    subSkills: readPatterns('--sub-skills'),
  });
  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          discovered: result.discovered,
          unique: result.unique,
          duplicates: result.duplicates,
          parseErrors: result.parseErrors,
          listingChars: result.listingChars,
          listingTokensApprox: result.listingTokensApprox,
          flagCounts: result.flagCounts,
          clusters: result.clusters,
          skills: result.reports.map((report) => ({
            name: report.skill?.name ?? report.dirName,
            source: report.source,
            bytes: report.bytes,
            descriptionChars: report.skill?.description.length ?? 0,
            winner: report.winner,
            flags: report.flags,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${render(result)}\n`);
  }
}
