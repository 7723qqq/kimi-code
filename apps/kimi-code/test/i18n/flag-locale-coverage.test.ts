import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import en from '#/i18n/locales/en';
import zh from '#/i18n/locales/zh';

/**
 * The experiment panel resolves its copy with a template key
 * (```…features.${feature.id}.title` ``), so a flag registered without locale
 * entries silently falls back to the English text the engine carries. Type
 * checking cannot see that key, and the static `t()` coverage gate cannot
 * either — this contract reads the engine's own flag registrations and holds
 * the feature block to them in both directions.
 */

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const ENGINE_SRC = join(REPO_ROOT, 'packages/agent-core-v2/src');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Every `*_FLAG_ID` constant the engine declares, wherever it lives. */
function flagIdConstants(files: readonly string[]): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\b([A-Z][A-Z0-9_]*_FLAG_ID)\s*=\s*'([^']+)'/g)) {
      constants.set(match[1]!, match[2]!);
    }
  }
  return constants;
}

/** Ids of the flags the engine registers through `registerFlagDefinition`. */
function registeredFlagIds(files: readonly string[]): string[] {
  const constants = flagIdConstants(files);
  const ids = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('registerFlagDefinition(')) continue;
    for (const match of source.matchAll(/\bid\s*:\s*'([^']+)'/g)) {
      ids.add(match[1]!);
    }
    for (const match of source.matchAll(/\bid\s*:\s*([A-Z][A-Z0-9_]*_FLAG_ID)\b/g)) {
      const id = constants.get(match[1]!);
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids].toSorted();
}

type FeatureCopy = Record<string, { title?: string; description?: string } | undefined>;

const enFeatures = en.tui.dialogs.experimentsSelector.features as unknown as FeatureCopy;
const zhFeatures = zh.tui.dialogs.experimentsSelector.features as unknown as FeatureCopy;

const isCopy = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

describe('experimental flag locale contract', () => {
  const ids = registeredFlagIds(walk(ENGINE_SRC));

  it('reads the engine registry rather than an empty directory', () => {
    // A moved directory or a renamed registration would otherwise turn every
    // assertion below into a vacuous pass.
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  it('declares title and description for every registered flag in both locales', () => {
    const missing = ids.flatMap((id) => {
      const gaps: string[] = [];
      if (!isCopy(enFeatures[id]?.title)) gaps.push(`en …${id}.title`);
      if (!isCopy(enFeatures[id]?.description)) gaps.push(`en …${id}.description`);
      if (!isCopy(zhFeatures[id]?.title)) gaps.push(`zh …${id}.title`);
      if (!isCopy(zhFeatures[id]?.description)) gaps.push(`zh …${id}.description`);
      return gaps;
    });

    expect(missing).toEqual([]);
  });

  it('keeps no feature copy for a flag the engine no longer registers', () => {
    const orphaned = Object.keys(enFeatures).filter((id) => !ids.includes(id));
    expect(orphaned).toEqual([]);
  });

  it('mirrors the feature block between the two locales', () => {
    expect(Object.keys(zhFeatures).toSorted()).toEqual(Object.keys(enFeatures).toSorted());
  });
});
