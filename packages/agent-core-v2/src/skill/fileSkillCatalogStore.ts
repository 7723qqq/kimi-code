/**
 * `skill` domain (L5) — filesystem `ISkillCatalogStore` backend.
 *
 * Discovers skill bundles by walking skill roots on the local filesystem and
 * parsing each SKILL.md through `parser`. This is the only file in the skill
 * domain that imports `node:fs`; the rest of the domain depends on the
 * `ISkillCatalogStore` interface and stays filesystem-agnostic. Bound at App
 * scope by the composition root (tests register the in-memory backend instead).
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

import {
  SkillParseError,
  UnsupportedSkillTypeError,
  parseSkillText,
} from './parser';
import type { SkillDiscoveryResult, ISkillCatalogStore } from './skillCatalogStore';
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

// Relative to brandHomeDir, which already IS the brand data dir (~/.kimi-code or
// $KIMI_CODE_HOME) — no '.kimi-code' segment here, or it would nest twice.
const USER_BRAND_DIRS = ['skills'] as const;
const USER_GENERIC_DIRS = ['.agents/skills'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/skills'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

// Bounds recursion so a directory symlink cycle inside a skill root cannot
// loop forever. Real skill trees are 1-3 levels deep.
const MAX_SKILL_SCAN_DEPTH = 8;

export class FileSkillCatalogStore implements ISkillCatalogStore {
  declare readonly _serviceBrand: undefined;

  async discoverProject(
    workDir: string,
    extraRoots?: readonly SkillRoot[],
  ): Promise<SkillDiscoveryResult> {
    const roots = await resolveProjectRoots(workDir, extraRoots);
    return scanRoots(roots);
  }

  async discoverUser(homeDir: string, osHomeDir: string): Promise<SkillDiscoveryResult> {
    const roots = await resolveUserRoots(homeDir, osHomeDir);
    return scanRoots(roots);
  }
}

async function resolveProjectRoots(
  workDir: string,
  extraRoots?: readonly SkillRoot[],
): Promise<readonly SkillRoot[]> {
  const projectRoot = await findProjectRoot(workDir);
  const roots: SkillRoot[] = [];
  await pushBrandGroup(roots, PROJECT_BRAND_DIRS, projectRoot, 'project');
  await pushFirstExisting(roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  if (extraRoots !== undefined) {
    for (const root of extraRoots) {
      await pushProvidedRoot(roots, root);
    }
  }
  return roots;
}

async function resolveUserRoots(
  homeDir: string,
  osHomeDir: string,
): Promise<readonly SkillRoot[]> {
  const roots: SkillRoot[] = [];
  // homeDir is already the brand data dir, so brand skills live at <homeDir>/skills.
  await pushBrandGroup(roots, USER_BRAND_DIRS, homeDir, 'user');
  await pushFirstExisting(roots, USER_GENERIC_DIRS, osHomeDir, 'user');
  return roots;
}

async function scanRoots(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> {
  const byName = new Map<string, SkillDefinition>();
  const skipped: SkippedSkill[] = [];

  async function walkSkillDir(
    dirPath: string,
    root: SkillRoot,
    isTopLevel: boolean,
    depth: number,
    subSkillParentName?: string,
  ): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      // Sorted so first-wins collision resolution across sibling directories
      // is deterministic rather than dependent on filesystem readdir order.
      entries = [...(await fs.readdir(dirPath))].toSorted();
    } catch {
      return;
    }

    const directorySkills = new Set<string>();
    const subdirs: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      // A directory holding SKILL.md is a skill bundle: register it, then keep
      // descending so nested SKILL.md bundles remain discoverable as sub-skills.
      if (await isFile(path.join(entryPath, 'SKILL.md'))) {
        directorySkills.add(entry);
      }
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      if (await isDir(entryPath)) subdirs.push(entry);
    }

    const allowedSubSkillBundles = new Map<string, string>();
    for (const entry of directorySkills) {
      const skill = await parseAndRegister({
        byName,
        skipped,
        skillMdPath: path.join(dirPath, entry, 'SKILL.md'),
        skillDirName: entry,
        root,
        subSkillParentName,
      });
      if (skill !== undefined && hasSubSkillEnabled(skill)) {
        allowedSubSkillBundles.set(entry, skill.name);
      }
    }

    // Flat .md skills count only at a root's top level; deeper .md files are
    // skill payload (e.g. references/foo.md), not skills.
    if (isTopLevel) {
      // A SKILL.md placed directly at a plugin skill root (e.g. plugin root
      // fallback) is treated as a single skill bundle. This only applies to
      // plugin-derived roots, not to user/project skill directories.
      if (root.plugin !== undefined) {
        const rootSkillMd = path.join(dirPath, 'SKILL.md');
        if (await isFile(rootSkillMd)) {
          await parseAndRegister({
            byName,
            skipped,
            skillMdPath: rootSkillMd,
            skillDirName: path.basename(dirPath),
            root,
          });
        }
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        if (entry === 'SKILL.md') continue;
        const skillName = entry.slice(0, -'.md'.length);
        if (directorySkills.has(skillName)) continue;
        const skillMdPath = path.join(dirPath, entry);
        if (!(await isFile(skillMdPath))) continue;
        await parseAndRegister({
          byName,
          skipped,
          skillMdPath,
          skillDirName: skillName,
          root,
        });
      }
    }

    for (const entry of subdirs) {
      if (directorySkills.has(entry) && !allowedSubSkillBundles.has(entry)) continue;
      const allowedSubSkillParentName = allowedSubSkillBundles.get(entry);
      await walkSkillDir(
        path.join(dirPath, entry),
        root,
        false,
        depth + 1,
        allowedSubSkillParentName ?? subSkillParentName,
      );
    }
  }

  for (const root of roots) {
    await walkSkillDir(root.path, root, true, 0);
  }

  return {
    skills: sortSkills([...byName.values()]),
    skipped,
    scannedRoots: roots.map((root) => root.path),
  };
}

async function parseAndRegister(input: {
  readonly byName: Map<string, SkillDefinition>;
  readonly skipped: SkippedSkill[];
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly root: SkillRoot;
  readonly subSkillParentName?: string;
}): Promise<SkillDefinition | undefined> {
  try {
    const text = await fs.readFile(input.skillMdPath, 'utf8');
    const parsed = parseSkillText({
      skillMdPath: input.skillMdPath,
      skillDirName: input.skillDirName,
      source: input.root.source,
      text,
    });
    const subSkillParentName = input.subSkillParentName;
    const skill =
      subSkillParentName !== undefined
        ? {
            ...parsed,
            name: qualifySubSkillName(subSkillParentName, parsed.name),
            metadata: {
              ...parsed.metadata,
              isSubSkill: true,
            },
          }
        : parsed;
    const discovered =
      input.root.plugin === undefined ? skill : { ...skill, plugin: input.root.plugin };
    const key = normalizeSkillName(discovered.name);
    if (!input.byName.has(key)) {
      input.byName.set(key, discovered);
    }
    return discovered;
  } catch (error) {
    if (error instanceof UnsupportedSkillTypeError) {
      input.skipped.push({
        path: input.skillMdPath,
        type: error.skillType,
        reason: `unsupported skill type "${error.skillType}"`,
      });
    }
    // SkillParseError and unexpected errors are dropped silently here; a future
    // phase will route them through the log service.
    return undefined;
  }
}

function sortSkills(skills: readonly SkillDefinition[]): readonly SkillDefinition[] {
  return [...skills].toSorted((a, b) => a.name.localeCompare(b.name));
}

async function pushFirstExisting(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(out, path.join(base, dir), source)) return;
  }
}

async function pushBrandGroup(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
): Promise<void> {
  for (const dir of dirs) {
    await pushExistingRoot(out, path.join(base, dir), source);
  }
}

async function pushExistingRoot(
  out: SkillRoot[],
  dir: string,
  source: SkillSource,
): Promise<boolean> {
  if (!(await isDir(dir))) return false;
  const resolved = await realpath(dir);
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
  return true;
}

async function pushProvidedRoot(out: SkillRoot[], root: SkillRoot): Promise<boolean> {
  if (!(await isDir(root.path))) return false;
  const resolved = await realpath(root.path);
  const existingIndex = out.findIndex((existing) => existing.path === resolved);
  if (existingIndex < 0) {
    out.push({ ...root, path: resolved });
    return true;
  }
  const existing = out[existingIndex];
  if (existing !== undefined && existing.plugin === undefined && root.plugin !== undefined) {
    out[existingIndex] = { ...existing, plugin: root.plugin };
  }
  return true;
}

function qualifySubSkillName(parentName: string, skillName: string): string {
  if (skillName === parentName || skillName.startsWith(`${parentName}.`)) return skillName;
  return `${parentName}.${skillName}`;
}

function hasSubSkillEnabled(skill: SkillDefinition): boolean {
  const nested = skill.metadata['metadata'];
  const nestedFlag =
    typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)['has-sub-skill'] === true ||
        (nested as Record<string, unknown>)['hasSubSkill'] === true
      : false;
  return (
    skill.metadata['has-sub-skill'] === true ||
    skill.metadata['hasSubSkill'] === true ||
    nestedFlag
  );
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function realpath(p: string): Promise<string> {
  return (await fs.realpath(p)).replaceAll('\\', '/');
}

async function findProjectRoot(workDir: string): Promise<string> {
  const start = path.resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
