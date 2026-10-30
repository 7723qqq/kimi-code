import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  configuredRoots,
  projectRoots,
  projectRootsForDirs,
  userRoots,
} from '#/features/skill/catalog/skillRoots';

async function normalizedRealpath(p: string): Promise<string> {
  return (await realpath(p)).replaceAll('\\', '/');
}

describe('skillRoots', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-roots-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function markGitRoot(dir: string = root): Promise<void> {
    await mkdir(join(dir, '.git'), { recursive: true });
  }

  describe('projectRootsForDirs', () => {
    it('collects roots from every work dir without duplicating a shared project root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/skills/commit'), { recursive: true });
      const nested = join(root, 'packages/app');
      await mkdir(nested, { recursive: true });

      const single = await projectRoots(root);
      const merged = await projectRootsForDirs([root, nested]);

      expect(merged.length).toBeGreaterThan(0);
      expect(merged.map((entry) => entry.path)).toEqual(single.map((entry) => entry.path));
    });

    it('keeps roots from work dirs that belong to different projects', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/skills/commit'), { recursive: true });
      const other = join(root, 'other-project');
      await markGitRoot(other);
      await mkdir(join(other, '.agents/skills/review'), { recursive: true });

      const merged = await projectRootsForDirs([root, other]);

      expect(merged.some((entry) => entry.path.endsWith('.kimi-code/skills'))).toBe(true);
      expect(merged.some((entry) => entry.path.endsWith('.agents/skills'))).toBe(true);
    });
  });

  describe('projectRoots', () => {
    it('resolves the brand .kimi-code/skills directory at the .git root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/skills/commit'), { recursive: true });

      const roots = await projectRoots(root);

      expect(
        roots.some((r) => r.path.endsWith('.kimi-code/skills') && r.source === 'project'),
      ).toBe(true);
    });

    it('falls back to the generic .agents/skills directory', async () => {
      await markGitRoot();
      await mkdir(join(root, '.agents/skills/review'), { recursive: true });

      const roots = await projectRoots(root);

      expect(roots.some((r) => r.path.endsWith('.agents/skills') && r.source === 'project')).toBe(
        true,
      );
      expect(roots.some((r) => r.path.endsWith('.kimi-code/skills'))).toBe(false);
    });

    it('walks up from a child directory to the .git root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/skills/commit'), { recursive: true });
      const child = join(root, 'src/pkg');
      await mkdir(child, { recursive: true });

      const roots = await projectRoots(child);

      expect(roots.some((r) => r.path.endsWith('.kimi-code/skills'))).toBe(true);
    });

    it('orders the brand directory before the generic directory', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/skills'), { recursive: true });
      await mkdir(join(root, '.agents/skills'), { recursive: true });

      const roots = await projectRoots(root);
      const brandIdx = roots.findIndex((r) => r.path.endsWith('.kimi-code/skills'));
      const genericIdx = roots.findIndex((r) => r.path.endsWith('.agents/skills'));

      expect(brandIdx).toBeGreaterThanOrEqual(0);
      expect(genericIdx).toBeGreaterThan(brandIdx);
    });
  });

  describe('userRoots', () => {
    it('resolves the brand skills directory under homeDir', async () => {
      await mkdir(join(root, 'skills/notes'), { recursive: true });

      const roots = await userRoots(root, root);

      expect(roots.some((r) => r.path.endsWith('/skills') && r.source === 'user')).toBe(true);
    });

    it('falls back to the generic .agents/skills under osHomeDir', async () => {
      const homeDir = join(root, 'brand-home');
      const osHomeDir = join(root, 'os-home');
      await mkdir(homeDir, { recursive: true });
      await mkdir(join(osHomeDir, '.agents/skills/notes'), { recursive: true });

      const roots = await userRoots(homeDir, osHomeDir);

      expect(roots.some((r) => r.path.endsWith('.agents/skills') && r.source === 'user')).toBe(
        true,
      );
    });
  });

  describe('configuredRoots', () => {
    it('resolves ~, ~/, absolute, and project-relative paths', async () => {
      await markGitRoot();
      const homeDir = join(root, 'home');
      const absDir = join(root, 'abs');
      await mkdir(homeDir, { recursive: true });
      await mkdir(join(homeDir, 'notes'), { recursive: true });
      await mkdir(absDir, { recursive: true });
      await mkdir(join(root, 'relative'), { recursive: true });

      const roots = await configuredRoots(
        ['~', '~/notes', absDir, 'relative'],
        root,
        homeDir,
        'extra',
      );
      const paths = roots.map((root) => root.path);

      expect(roots.every((root) => root.source === 'extra')).toBe(true);
      expect(paths).toContain(await normalizedRealpath(homeDir));
      expect(paths).toContain(await normalizedRealpath(join(homeDir, 'notes')));
      expect(paths).toContain(await normalizedRealpath(absDir));
      expect(paths).toContain(await normalizedRealpath(join(root, 'relative')));
    });
  });
});
