import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import { GitOperationBackend } from '#/features/operationLog/gitOperationBackend';

const roots: string[] = [];

async function gitEnv(
  cwd: string,
  environment: Readonly<Record<string, string>>,
  ...args: string[]
): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...environment },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return gitEnv(cwd, {}, ...args);
}

async function gitCaptured(cwd: string, storage: string, ...args: string[]): Promise<string> {
  const actualObjectDir = await git(
    cwd,
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'objects',
  );
  return gitEnv(
    cwd,
    {
      GIT_OBJECT_DIRECTORY: join(storage, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: actualObjectDir,
    },
    ...args,
  );
}

async function createRepo(withInitialCommit = true): Promise<{ repo: string; storage: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-operation-git-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const storage = join(root, 'storage');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await git(repo, 'config', 'user.email', 'operation-test@example.com');
  await git(repo, 'config', 'user.name', 'Operation Test');
  if (withInitialCommit) {
    await writeFile(join(repo, '.gitignore'), '*.log\n');
    await writeFile(join(repo, 'a.txt'), 'initial\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'initial');
  }
  return { repo, storage };
}

function open(repo: string, storage: string): Promise<GitOperationBackend> {
  return GitOperationBackend.open({ repoRoot: repo, storageRoot: storage });
}

async function actualState(repo: string) {
  return {
    head: await git(repo, 'rev-parse', 'HEAD'),
    symbolicHead: await git(repo, 'symbolic-ref', '-q', 'HEAD'),
    refs: await git(repo, 'for-each-ref', '--format=%(refname)%00%(objectname)'),
    indexHash: new Bun.CryptoHasher('sha256')
      .update(await readFile(join(repo, '.git', 'index')))
      .digest('hex'),
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitOperationBackend', () => {
  it('captures tree, HEAD, refs and index fingerprint without mutating the repository', async () => {
    const { repo, storage } = await createRepo();
    const before = await actualState(repo);
    await writeFile(join(repo, 'a.txt'), 'modified\n');
    await writeFile(join(repo, 'new.txt'), 'new file\n');
    await writeFile(join(repo, 'ignored.log'), 'ignored\n');

    const backend = await open(repo, storage);
    const view = await backend.captureView();
    const after = await actualState(repo);

    expect(after).toEqual(before);
    expect(view.head).toEqual({ kind: 'branch', ref: 'refs/heads/main', target: before.head });
    expect(view.refs['refs/heads/main']).toBe(before.head);
    expect(view.indexTree).toBe(await git(repo, 'rev-parse', 'HEAD^{tree}'));
    expect(view.tree).not.toBe(view.indexTree);
    const files = await gitCaptured(repo, storage, 'ls-tree', '-r', '--name-only', view.tree);
    expect(files.split('\n').toSorted()).toEqual(['.gitignore', 'a.txt', 'new.txt']);
    expect(await Bun.file(join(repo, '.git', 'index')).exists()).toBe(true);
  });

  it('captures a detached HEAD', async () => {
    const { repo, storage } = await createRepo();
    const target = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '--detach', 'HEAD');

    const view = await (await open(repo, storage)).captureView();

    expect(view.head).toEqual({ kind: 'detached', target });
  });

  it('captures an unborn HEAD without creating an index', async () => {
    const { repo, storage } = await createRepo(false);
    await writeFile(join(repo, 'new.txt'), 'new file\n');

    const view = await (await open(repo, storage)).captureView();

    expect(view.head).toEqual({ kind: 'unborn', ref: 'refs/heads/main' });
    expect(view.refs).toEqual({});
    expect(view.indexTree).toBe(await git(repo, 'mktree'));
    expect(await Bun.file(join(repo, '.git', 'index')).exists()).toBe(false);
  });

  it('rejects restoring while the current index has staged changes', async () => {
    const { repo, storage } = await createRepo();
    await writeFile(join(repo, 'a.txt'), 'staged\n');
    await git(repo, 'add', 'a.txt');
    const backend = await open(repo, storage);
    const view = await backend.captureView();

    expect(await rejectionOf(backend.assertRestorable(view))).toMatchObject({
      code: 'staged-changes',
    });
  });

  it('rejects a target view whose index had staged changes even after committing them', async () => {
    const { repo, storage } = await createRepo();
    await writeFile(join(repo, 'a.txt'), 'staged\n');
    await git(repo, 'add', 'a.txt');
    const backend = await open(repo, storage);
    const stagedView = await backend.captureView();
    await git(repo, 'commit', '-m', 'staged');

    expect(await rejectionOf(backend.assertRestorable(stagedView))).toMatchObject({
      code: 'staged-changes',
    });
  });

  it.each([
    { operation: 'merge', marker: 'MERGE_HEAD' },
    { operation: 'rebase', marker: 'rebase-merge' },
  ])('rejects current and target $operation states', async ({ operation, marker }) => {
    const { repo, storage } = await createRepo();
    const markerPath = join(repo, '.git', marker);
    if (operation === 'merge')
      await writeFile(markerPath, `${await git(repo, 'rev-parse', 'HEAD')}\n`);
    else await mkdir(markerPath, { recursive: true });
    const backend = await open(repo, storage);
    const view = await backend.captureView();

    expect(view.unfinishedOperation).toBe(operation);
    expect(await rejectionOf(backend.assertRestorable(view))).toMatchObject({
      code: 'unfinished-operation',
      details: { operation },
    });

    await rm(markerPath, { recursive: true, force: true });
    expect(await rejectionOf(backend.assertRestorable(view))).toMatchObject({
      code: 'unfinished-operation',
      details: { operation },
    });
  });
});
