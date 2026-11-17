import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { auditSkills } from '../skills-audit';

function seedSkill(root: string, dirName: string, frontmatter: string, body = 'body'): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'skills-audit-'));
}

describe('auditSkills', () => {
  it('counts winners, duplicates and parse failures', () => {
    const root = tempRoot();
    seedSkill(root, 'demo', 'name: demo\ndescription: a demo skill');
    seedSkill(root, 'demo-clone', 'name: demo\ndescription: another demo skill');
    seedSkill(root, 'other', 'name: other\ndescription: a different skill');
    seedSkill(root, 'broken', 'name: broken');

    const result = auditSkills({ roots: [[root, 'user']] });

    expect(result.discovered).toBe(4);
    expect(result.unique).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.parseErrors).toBe(1);
    const flags = (name: string): readonly string[] =>
      result.reports.find((report) => report.dirName === name)?.flags ?? [];
    expect(flags('demo-clone')).toContain('duplicate');
    expect(flags('broken')).toContain('parse-error');
  });

  it('folds sub-skills and hidden skills out of the listing cost', () => {
    const root = tempRoot();
    seedSkill(root, 'keep', 'name: keep\ndescription: stays visible');
    seedSkill(root, 'genre-rpg', 'name: genre-rpg\ndescription: rpg recipe');

    const raw = auditSkills({ roots: [[root, 'user']] });
    const folded = auditSkills({
      roots: [[root, 'user']],
      subSkills: ['genre-*'],
      hidden: ['no-such-skill'],
    });

    expect(folded.listingChars).toBeLessThan(raw.listingChars);
    expect(folded.unique).toBe(raw.unique);
  });

  it('flags broad short skills as black-hole candidates', () => {
    const root = tempRoot();
    seedSkill(root, 'ai', 'name: ai\ndescription: general purpose assistant');
    seedSkill(root, 'narrow', 'name: narrow-check\ndescription: checks the release notes for the v2 changelog format');

    const result = auditSkills({ roots: [[root, 'user']] });

    const flagsOf = (name: string): readonly string[] =>
      result.reports.find((report) => report.skill?.name === name)?.flags ?? [];
    expect(flagsOf('ai')).toContain('black-hole');
    expect(flagsOf('narrow-check')).not.toContain('black-hole');
  });
});
