import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSkillCatalogStore } from '#/app/globalSkillCatalog/fileSkillCatalogStore';

describe('FileSkillCatalogStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSkill(rel: string, frontmatter: string, body = 'body'): Promise<void> {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `---\n${frontmatter}\n---\n${body}`);
  }

  async function markGitRoot(dir: string = root): Promise<void> {
    await mkdir(join(dir, '.git'), { recursive: true });
  }

  it('discovers a project directory skill under .kimi-code/skills', async () => {
    await markGitRoot();
    await writeSkill('.kimi-code/skills/commit/SKILL.md', 'name: commit\ndescription: commit changes');

    const result = await new FileSkillCatalogStore().discoverProject(root);

    expect(result.skills.map((s) => s.name)).toEqual(['commit']);
    expect(result.skills[0]?.source).toBe('project');
  });

  it('discovers a project skill under .agents/skills as a fallback', async () => {
    await markGitRoot();
    await writeSkill('.agents/skills/review/SKILL.md', 'name: review\ndescription: review code');

    const result = await new FileSkillCatalogStore().discoverProject(root);

    expect(result.skills.map((s) => s.name)).toEqual(['review']);
  });

  it('returns an empty result when no skill directories exist', async () => {
    await markGitRoot();

    const result = await new FileSkillCatalogStore().discoverProject(root);

    expect(result.skills).toEqual([]);
    expect(result.scannedRoots).toEqual([]);
  });

  it('discovers a flat .md skill at the root top level', async () => {
    await markGitRoot();
    await writeSkill('.kimi-code/skills/summarize.md', 'name: summarize\ndescription: summarize text');

    const result = await new FileSkillCatalogStore().discoverProject(root);

    expect(result.skills.map((s) => s.name)).toEqual(['summarize']);
  });

  it('lets .kimi-code/skills win over .agents/skills on name collision', async () => {
    await markGitRoot();
    await writeSkill('.kimi-code/skills/dup/SKILL.md', 'name: dup\ndescription: from brand');
    await writeSkill('.agents/skills/dup/SKILL.md', 'name: dup\ndescription: from generic');

    const result = await new FileSkillCatalogStore().discoverProject(root);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('from brand');
  });

  it('discovers user skills under homeDir/skills', async () => {
    await writeSkill('skills/notes/SKILL.md', 'name: notes\ndescription: personal notes');

    const result = await new FileSkillCatalogStore().discoverUser(root, root);

    expect(result.skills.map((s) => s.name)).toEqual(['notes']);
    expect(result.skills[0]?.source).toBe('user');
  });

  it('discovers sub-skills of a parent that opts in', async () => {
    await markGitRoot();
    await writeSkill(
      '.kimi-code/skills/parent/SKILL.md',
      'name: parent\ndescription: parent\nhas-sub-skill: true',
    );
    await writeSkill(
      '.kimi-code/skills/parent/child/SKILL.md',
      'name: child\ndescription: child skill',
    );

    const result = await new FileSkillCatalogStore().discoverProject(root);
    const names = result.skills.map((s) => s.name).toSorted();

    expect(names).toEqual(['parent', 'parent.child']);
    expect(result.skills.find((s) => s.name === 'parent.child')?.metadata.isSubSkill).toBe(true);
  });

  it('ignores node_modules and dot directories while walking', async () => {
    await markGitRoot();
    await writeSkill(
      '.kimi-code/skills/node_modules/hidden/SKILL.md',
      'name: hidden\ndescription: hidden',
    );

    const result = await new FileSkillCatalogStore().discoverProject(root);

    expect(result.skills.map((s) => s.name)).not.toContain('hidden');
  });
});
