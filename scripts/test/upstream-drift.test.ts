import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { analyzeUpstream } from '../upstream-drift';

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function write(cwd: string, path: string, content: string): void {
  const target = join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'upstream-drift-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

describe('upstream-drift', () => {
  it('classifies missing, equivalent, adapted, test, platform and rename commits', () => {
    const root = initRepo();
    try {
      write(root, 'src/a.ts', 'a1\n');
      write(root, 'src/m.ts', 'm1\n');
      write(root, 'src/old.ts', 'old\n');
      write(root, 'test/a.test.ts', 'test1\n');
      write(root, 'package.json', '{"name":"x"}\n');
      write(
        root,
        '.upstream/drift-paths.json',
        JSON.stringify({ platform: ['package.json'], tests: ['test/**'], forkOnly: [] }),
      );
      const base = commit(root, 'base');

      git(root, ['checkout', '-q', '-b', 'upstream', base]);
      write(root, 'src/m.ts', 'm2\n');
      const missingSha = commit(root, 'feat: change m to m2 (#1)');
      write(root, 'src/b.ts', 'b1\n');
      const equivalentSha = commit(root, 'feat: add b (#2)');
      write(root, 'src/a.ts', 'a3\n');
      const adaptedSha = commit(root, 'feat: change a to a3 (#3)');
      write(root, 'test/a.test.ts', 'test2\n');
      const testSha = commit(root, 'test: change the test (#4)');
      write(root, 'package.json', '{"name":"x","v":2}\n');
      const platformSha = commit(root, 'chore: bump package (#5)');
      git(root, ['mv', 'src/old.ts', 'src/new.ts']);
      const renameSha = commit(root, 'refactor: rename old to new (#6)');

      git(root, ['checkout', '-q', '-b', 'fork', base]);
      git(root, ['cherry-pick', equivalentSha]);
      write(root, 'src/a.ts', 'aX\n');
      commit(root, 'refactor: adapt a');

      const result = analyzeUpstream({
        cwd: root,
        upstream: 'upstream',
        base,
        pathsPath: '.upstream/drift-paths.json',
      });
      const bySha = new Map(result.analyses.map((analysis) => [analysis.sha, analysis]));

      expect(bySha.get(missingSha)?.status).toBe('missing');
      expect(bySha.get(missingSha)?.kind).toBe('source');
      expect(bySha.get(equivalentSha)?.status).toBe('equivalent');
      expect(bySha.get(equivalentSha)?.evidence).toContain('patch-id');
      expect(bySha.get(adaptedSha)?.status).toBe('adapted');
      expect(bySha.get(testSha)?.status).toBe('test-missing');
      expect(bySha.get(platformSha)?.status).toBe('platform-missing');
      expect(bySha.get(renameSha)?.status).toBe('missing');
      expect(bySha.get(renameSha)?.changes[0]?.status.startsWith('R')).toBe(true);

      const fast = analyzeUpstream({
        cwd: root,
        upstream: 'upstream',
        base,
        pathsPath: '.upstream/drift-paths.json',
        fast: true,
      });
      const fastBySha = new Map(fast.analyses.map((analysis) => [analysis.sha, analysis]));
      expect(fastBySha.get(missingSha)?.status).toBe('missing');
      expect(fastBySha.get(equivalentSha)?.status).toBe('equivalent');
      expect(fastBySha.get(adaptedSha)?.status).toBe('adapted');
      expect(fastBySha.get(testSha)?.status).toBe('test-missing');
      expect(fastBySha.get(platformSha)?.status).toBe('platform-missing');
      expect(fastBySha.get(renameSha)?.status).toBe('missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
