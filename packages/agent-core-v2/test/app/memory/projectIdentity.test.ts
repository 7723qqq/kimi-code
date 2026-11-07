import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  legacyProjectIdFromCwd,
  normalizeRemoteUrl,
  resolveProjectIdentity,
} from '#/app/memory/projectIdentity';

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `project-identity-${name}-`));
}

async function makeRepo(root: string, config: string): Promise<void> {
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), config, 'utf-8');
}

describe('project identity', () => {
  it('falls back to the working directory outside git', async () => {
    const dir = await tempDir('plain');
    try {
      const identity = resolveProjectIdentity(dir);
      expect(identity.kind).toBe('path');
      expect(identity.id).toBe(legacyProjectIdFromCwd(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keys a repository without a remote by its root, so subdirectories agree', async () => {
    const root = await tempDir('noremote');
    try {
      await makeRepo(root, '[core]\n\trepositoryformatversion = 0\n');
      await mkdir(join(root, 'packages', 'deep'), { recursive: true });
      const atRoot = resolveProjectIdentity(root);
      const atNested = resolveProjectIdentity(join(root, 'packages', 'deep'));
      expect(atRoot.kind).toBe('git-repo');
      expect(atNested.id).toBe(atRoot.id);
      expect(atRoot.id).not.toBe(legacyProjectIdFromCwd(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keys a repository with an origin remote by the remote, so clones and moves agree', async () => {
    const config = '[remote "origin"]\n\turl = git@github.com:MoonshotAI/kimi-code.git\n';
    const first = await tempDir('clone-a');
    const second = await tempDir('clone-b');
    try {
      await makeRepo(first, config);
      await makeRepo(second, config);
      const a = resolveProjectIdentity(first);
      const b = resolveProjectIdentity(second);
      expect(a.kind).toBe('git-remote');
      expect(a.id).toBe(b.id);
      expect(a.detail).toBe('github.com/MoonshotAI/kimi-code');
      const renamed = `${first}-moved`;
      await mkdir(renamed, { recursive: true });
      await mkdir(join(renamed, '.git'), { recursive: true });
      await writeFile(join(renamed, '.git', 'config'), config, 'utf-8');
      expect(resolveProjectIdentity(renamed).id).toBe(a.id);
      await rm(renamed, { recursive: true, force: true });
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it('follows a gitdir pointer and the shared commondir of a worktree', async () => {
    const main = await tempDir('wt-main');
    const linked = await tempDir('wt-linked');
    try {
      const config = '[remote "origin"]\n\turl = https://example.com/team/repo.git\n';
      await makeRepo(main, config);
      const worktreeDir = join(main, '.git', 'worktrees', 'linked');
      await mkdir(worktreeDir, { recursive: true });
      await writeFile(join(worktreeDir, 'commondir'), '../..\n', 'utf-8');
      await writeFile(join(linked, '.git'), `gitdir: ${worktreeDir}\n`, 'utf-8');
      const identity = resolveProjectIdentity(linked);
      expect(identity.kind).toBe('git-remote');
      expect(identity.detail).toBe('example.com/team/repo');
      expect(identity.id).toBe(resolveProjectIdentity(main).id);
    } finally {
      await rm(main, { recursive: true, force: true });
      await rm(linked, { recursive: true, force: true });
    }
  });

  it('normalises scp and URL spellings of the same remote', () => {
    expect(normalizeRemoteUrl('git@GitHub.com:Owner/Repo.git')).toBe('github.com/Owner/Repo');
    expect(normalizeRemoteUrl('https://github.com/Owner/Repo')).toBe('github.com/Owner/Repo');
    expect(normalizeRemoteUrl('ssh://git@github.com/Owner/Repo.git')).toBe('github.com/Owner/Repo');
    expect(normalizeRemoteUrl('https://github.com/Owner/Repo/')).toBe('github.com/Owner/Repo');
    expect(normalizeRemoteUrl('D:\\repos\\mine')).toBeUndefined();
    expect(normalizeRemoteUrl('   ')).toBeUndefined();
  });
});
