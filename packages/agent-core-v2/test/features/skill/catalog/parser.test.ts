import { describe, expect, it } from 'bun:test';

import {
  SkillParseError,
  UnsupportedSkillTypeError,
  parseSkillText,
} from '#/features/skill/catalog/parser';

describe('parseSkillText', () => {
  it('parses a directory skill with required fields', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/commit/SKILL.md',
      skillDirName: 'commit',
      source: 'user',
      text: '---\nname: commit\ndescription: commit changes\n---\n# Commit',
    });
    expect(skill.name).toBe('commit');
    expect(skill.description).toBe('commit changes');
    expect(skill.source).toBe('user');
    expect(skill.content).toBe('# Commit');
  });

  it('applies metadata aliases', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\nwhen-to-use: when X\ndisable_model_invocation: true\n---\nbody',
    });
    expect(skill.metadata.whenToUse).toBe('when X');
    expect(skill.metadata.disableModelInvocation).toBe(true);
  });

  it('normalizes verify commands and rejects empty ones', () => {
    const single = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\nverify: pnpm test\n---\nbody',
    });
    expect(single.metadata.verify).toEqual(['pnpm test']);

    const list = parseSkillText({
      skillMdPath: '/skills/y/SKILL.md',
      skillDirName: 'y',
      source: 'user',
      text: '---\nname: y\ndescription: d\nverification: ["pnpm lint", "", "   ", "pnpm typecheck"]\n---\nbody',
    });
    expect(list.metadata.verify).toEqual(['pnpm lint', 'pnpm typecheck']);

    const missing = parseSkillText({
      skillMdPath: '/skills/z/SKILL.md',
      skillDirName: 'z',
      source: 'user',
      text: '---\nname: z\ndescription: d\nverify: []\n---\nbody',
    });
    expect(missing.metadata.verify).toBeUndefined();
  });

  it('caps verify commands at five entries of five hundred characters', () => {
    const long = 'x'.repeat(600);
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: `---\nname: x\ndescription: d\nverify: [${JSON.stringify(long)}, "a", "b", "c", "d", "e"]\n---\nbody`,
    });
    expect(skill.metadata.verify).toHaveLength(5);
    expect(skill.metadata.verify?.[0]).toHaveLength(500);
  });

  it('throws when a directory skill misses a required field', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '---\ndescription: d\n---\nbody',
      }),
    ).toThrow(SkillParseError);
  });

  it('throws when a directory skill has no frontmatter', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '# no frontmatter',
      }),
    ).toThrow(SkillParseError);
  });

  it('falls back to dir name and body description for flat skills', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/foo.md',
      skillDirName: 'foo',
      source: 'user',
      text: '# Foo skill\n\nDoes foo.',
    });
    expect(skill.name).toBe('foo');
    expect(skill.description).toBe('# Foo skill');
  });

  it('throws on an unsupported skill type', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '---\nname: x\ndescription: d\ntype: bogus\n---\nbody',
      }),
    ).toThrow(UnsupportedSkillTypeError);
  });

  it('extracts mermaid and d2 flowchart blocks', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\n---\n```mermaid\ngraph TD\n```\n\n```d2\nx -> y\n```',
    });
    expect(skill.mermaid).toBe('graph TD');
    expect(skill.d2).toBe('x -> y');
  });
});
