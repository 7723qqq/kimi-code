import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitService } from '#/app/git/gitService';
import { ErrorCodes } from '#/errors';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

describe('GitService', () => {
  let repo: string;
  let service: GitService;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-service-'));
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    service = new GitService();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function commitAll(message: string): void {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', message);
  }

  describe('status', () => {
    it('reports a clean tree', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      const result = await service.status(repo);
      expect(typeof result.branch).toBe('string');
      expect(result.entries).toEqual({});
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
      expect(result.pullRequest).toBeNull();
    });

    it('reports a modified file with numstat', async () => {
      writeFileSync(join(repo, 'a.txt'), 'line1\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');

      const result = await service.status(repo);
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(0);
    });

    it('restricts entries to the path filter', async () => {
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'a2\n');
      writeFileSync(join(repo, 'b.txt'), 'b2\n');

      const result = await service.status(repo, new Set(['a.txt']));
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
    });

    it('throws FS_GIT_UNAVAILABLE when not a repo', async () => {
      const notRepo = mkdtempSync(join(tmpdir(), 'not-repo-'));
      try {
        await expect(service.status(notRepo)).rejects.toMatchObject({
          code: ErrorCodes.FS_GIT_UNAVAILABLE,
        });
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    });
  });

  describe('diff', () => {
    it('returns the unified diff for a tracked modified file', async () => {
      writeFileSync(join(repo, 'a.txt'), 'old\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'new\n');

      const result = await service.diff(repo, 'a.txt', join(repo, 'a.txt'));
      expect(result.path).toBe('a.txt');
      expect(result.diff).toContain('+new');
      expect(result.diff).toContain('-old');
      expect(result.truncated).toBe(false);
    });

    it('returns an all-added diff for an untracked file', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      writeFileSync(join(repo, 'b.txt'), 'brand new\n');

      const result = await service.diff(repo, 'b.txt', join(repo, 'b.txt'));
      expect(result.diff).toContain('+brand new');
    });

    it('throws FS_PATH_NOT_FOUND for a missing path', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      await expect(
        service.diff(repo, 'missing.txt', join(repo, 'missing.txt')),
      ).rejects.toMatchObject({ code: ErrorCodes.FS_PATH_NOT_FOUND });
    });
  });
});
