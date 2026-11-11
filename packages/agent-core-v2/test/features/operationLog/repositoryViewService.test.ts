import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import { RepositoryViewService } from '#/features/operationLog/repositoryViewService';

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

async function gitRefs(repo: string): Promise<Record<string, string>> {
  const raw = await git(repo, 'for-each-ref', '--format=%(refname)%00%(objectname)');
  const refs: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('\0');
    refs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return refs;
}

async function referenceFileAt(
  repo: string,
  storage: string,
  tree: string,
  path: string,
): Promise<{ readonly hash: string; readonly size: number } | undefined> {
  const result = await gitCaptured(repo, storage, 'ls-tree', '-z', tree, '--', path);
  if (result === '') return undefined;
  const metadata = result.slice(0, result.indexOf('\t')).split(' ');
  const hash = metadata[2];
  if (metadata[1] !== 'blob' || hash === undefined) return undefined;
  return { hash, size: Number(await gitCaptured(repo, storage, 'cat-file', '-s', hash)) };
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

function open(repo: string, storage: string): Promise<RepositoryViewService> {
  return RepositoryViewService.open({ repoRoot: repo, storageRoot: storage });
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

describe('RepositoryViewService', () => {
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

  it('reads file metadata, binary blobs and changed paths from captured views', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const before = await backend.captureView();
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    await writeFile(join(repo, 'a.txt'), bytes);
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const after = await backend.captureView();

    const file = await backend.readFile(after, 'a.txt');
    expect(file).toBeDefined();
    expect(file!.size).toBe(bytes.byteLength);
    expect(await backend.readBlob(file!.hash)).toEqual(bytes);
    expect(await backend.readFile(after, 'missing.txt')).toBeUndefined();
    expect(await backend.changedFiles(before, after)).toEqual(['a.txt', 'new.txt']);
  });

  it('restores the complete tree, HEAD and refs while preserving ignored files', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const initial = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'committed\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'second');
    await git(repo, 'branch', 'topic');
    await writeFile(join(repo, 'a.txt'), 'working\n');
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n');
    await writeFile(join(repo, 'ignored.log'), 'ignored\n');
    const current = await backend.captureView();

    await backend.restoreView(current, initial);

    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('initial\n');
    expect(await Bun.file(join(repo, 'new.txt')).exists()).toBe(false);
    expect(await Bun.file(join(repo, 'untracked.txt')).exists()).toBe(false);
    expect(await Bun.file(join(repo, 'ignored.log')).text()).toBe('ignored\n');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(
      initial.head.kind === 'branch' ? initial.head.target : '',
    );
    expect(await git(repo, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(await git(repo, 'diff', '--cached', '--quiet')).toBe('');
    expect(await backend.captureView()).toEqual(initial);
  });

  it('restores a detached HEAD', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const target = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '--detach', 'HEAD');
    const detached = await backend.captureView();
    await git(repo, 'checkout', 'main');
    await writeFile(join(repo, 'a.txt'), 'branch\n');
    await git(repo, 'add', 'a.txt');
    await git(repo, 'commit', '-m', 'branch');
    const current = await backend.captureView();

    await backend.restoreView(current, detached);

    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(target);
    expect(await rejectionOf(git(repo, 'symbolic-ref', '-q', 'HEAD'))).toBeDefined();
    expect(await backend.captureView()).toEqual(detached);
  });

  it('restores an unborn HEAD and removes later branch refs', async () => {
    const { repo, storage } = await createRepo(false);
    await writeFile(join(repo, 'new.txt'), 'new file\n');
    const backend = await open(repo, storage);
    const unborn = await backend.captureView();
    await git(repo, 'add', 'new.txt');
    await git(repo, 'commit', '-m', 'initial');
    await writeFile(join(repo, 'other.txt'), 'other\n');
    const current = await backend.captureView();

    await backend.restoreView(current, unborn);

    expect(await git(repo, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');
    expect(await rejectionOf(git(repo, 'rev-parse', '--verify', 'HEAD'))).toBeDefined();
    expect(await git(repo, 'for-each-ref', '--format=%(refname)')).toBe('');
    expect(await Bun.file(join(repo, 'new.txt')).text()).toBe('new file\n');
    expect(await Bun.file(join(repo, 'other.txt')).exists()).toBe(false);
    expect(await backend.captureView()).toEqual(unborn);
  });

  it('rejects restoration when the current view differs from the expected view', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const initial = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'expected\n');
    const expected = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'external\n');

    expect(await rejectionOf(backend.restoreView(expected, initial))).toMatchObject({
      code: 'view-mismatch',
    });
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('external\n');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(
      expected.head.kind === 'branch' ? expected.head.target : '',
    );
  });

  it('rolls back the worktree when updating refs fails', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const initial = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'current\n');
    await git(repo, 'add', 'a.txt');
    await git(repo, 'commit', '-m', 'current');
    const current = await backend.captureView();
    const lockPath = join(repo, '.git', 'refs', 'heads', 'main.lock');
    await writeFile(lockPath, 'locked\n');

    expect(await rejectionOf(backend.restoreView(current, initial))).toMatchObject({
      name: 'GitOperationError',
    });
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('current\n');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(
      current.head.kind === 'branch' ? current.head.target : '',
    );

    await rm(lockPath, { force: true });
    expect(await backend.captureView()).toEqual(current);
  });

  it('requires recovery and blocks captures when rollback fails', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const initial = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'current\n');
    await git(repo, 'add', 'a.txt');
    await git(repo, 'commit', '-m', 'current');
    const current = await backend.captureView();
    await writeFile(join(repo, '.git', 'refs', 'heads', 'main.lock'), 'locked\n');
    const originalSpawn = Bun.spawn;
    let worktreeResets = 0;
    Bun.spawn = ((options: any) => {
      const command = options.cmd as readonly string[];
      if (command.includes('--reset') && command.includes('-u')) {
        worktreeResets += 1;
        if (worktreeResets === 2) throw new Error('Injected rollback failure');
      }
      return originalSpawn(options);
    }) as typeof Bun.spawn;

    try {
      expect(await rejectionOf(backend.restoreView(current, initial))).toMatchObject({
        code: 'recovery-required',
      });
      expect(worktreeResets).toBe(2);
      expect(await rejectionOf(backend.captureView())).toMatchObject({
        code: 'recovery-required',
      });
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('derives the default storage root from the absolute git directory', async () => {
    const { repo } = await createRepo();
    const gitDir = await git(repo, 'rev-parse', '--path-format=absolute', '--absolute-git-dir');

    const backend = await RepositoryViewService.open({ repoRoot: repo });

    expect(backend.storageRoot).toBe(join(gitDir, 'kimi-operation-log'));
  });

  it('reports whether the opened repository identity is still current', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);

    expect(await backend.isRepositoryCurrent()).toBe(true);

    await rm(join(repo, '.git'), { recursive: true, force: true });
    await git(repo, 'init', '-b', 'main');

    expect(await backend.isRepositoryCurrent()).toBe(false);
  });

  it('reads loose and packed refs exactly like for-each-ref', async () => {
    const { repo, storage } = await createRepo();
    await git(repo, 'branch', 'topic');
    await git(repo, 'tag', 'light');
    await git(repo, 'tag', '-a', 'annotated', '-m', 'annotated tag');
    const first = await git(repo, 'rev-parse', 'HEAD');
    await mkdir(join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    await writeFile(join(repo, '.git', 'refs', 'remotes', 'origin', 'main'), `${first}\n`);
    await writeFile(
      join(repo, '.git', 'refs', 'remotes', 'origin', 'HEAD'),
      'ref: refs/remotes/origin/main\n',
    );
    await writeFile(join(repo, '.git', 'refs', 'heads', 'ignored.lock'), `${first}\n`);
    await writeFile(join(repo, '.git', 'refs', 'heads', '.hidden'), `${first}\n`);
    await git(repo, 'pack-refs', '--all');
    await writeFile(join(repo, 'b.txt'), 'second\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'second');
    const second = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'update-ref', 'refs/heads/topic', second);

    const view = await (await open(repo, storage)).captureView();

    expect(view.refs).toEqual(await gitRefs(repo));
    expect(view.refs['refs/heads/topic']).toBe(second);
    expect(view.refs['refs/remotes/origin/HEAD']).toBe(first);
  });

  it('captures a linked worktree from the git ref probes', async () => {
    const { repo, storage } = await createRepo();
    const worktree = join(repo, '..', 'worktree');
    await git(repo, 'worktree', 'add', '-b', 'wt', worktree);
    const backend = await RepositoryViewService.open({
      repoRoot: worktree,
      storageRoot: join(storage, 'wt'),
    });

    const view = await backend.captureView();

    expect(view.head).toEqual({
      kind: 'branch',
      ref: 'refs/heads/wt',
      target: await git(worktree, 'rev-parse', 'HEAD'),
    });
    expect(view.refs).toEqual(await gitRefs(worktree));
  });

  it('records an unmerged index as an empty index tree', async () => {
    const { repo, storage } = await createRepo();
    await git(repo, 'checkout', '-b', 'side');
    await writeFile(join(repo, 'a.txt'), 'side\n');
    await git(repo, 'commit', '-am', 'side');
    await git(repo, 'checkout', 'main');
    await writeFile(join(repo, 'a.txt'), 'main\n');
    await git(repo, 'commit', '-am', 'main');
    expect(await rejectionOf(git(repo, 'merge', 'side'))).toBeDefined();

    const view = await (await open(repo, storage)).captureView();

    expect(view.unfinishedOperation).toBe('merge');
    expect(view.indexTree).toBe('');
  });

  it('captures a view with four git processes', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    await backend.captureView();
    const originalSpawn = Bun.spawn;
    let spawns = 0;
    Bun.spawn = ((options: any) => {
      const command = options.cmd as readonly string[];
      if (command[0] === 'git') spawns += 1;
      return originalSpawn(options);
    }) as typeof Bun.spawn;

    try {
      await backend.captureView();
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(spawns).toBe(4);
  });

  it('reads many view files with one batch process and the same metadata as ls-tree', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    const before = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'changed\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    await mkdir(join(repo, 'dir'), { recursive: true });
    await writeFile(join(repo, 'dir', 'file with space.txt'), 'space\n');
    const after = await backend.captureView();
    const paths = ['a.txt', 'new.txt', 'dir/file with space.txt', 'missing.txt'];
    const queries = [
      ...paths.map((path) => ({ view: before, path })),
      ...paths.map((path) => ({ view: after, path })),
    ];
    const originalSpawn = Bun.spawn;
    let spawns = 0;
    Bun.spawn = ((options: any) => {
      const command = options.cmd as readonly string[];
      if (command[0] === 'git') spawns += 1;
      return originalSpawn(options);
    }) as typeof Bun.spawn;

    let reads: readonly ({ readonly hash: string; readonly size: number } | undefined)[] = [];
    try {
      reads = await backend.readFiles(queries);
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(spawns).toBe(1);
    for (const [index, query] of queries.entries()) {
      expect(reads[index]).toEqual(
        await referenceFileAt(repo, storage, query.view.tree, query.path),
      );
    }
  });

  it('reads many blobs with one batch process and serves repeats from the cache', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    await writeFile(join(repo, 'binary.bin'), new Uint8Array([0, 1, 2, 255, 254]));
    await writeFile(join(repo, 'text.txt'), 'text\n');
    const view = await backend.captureView();
    const files = await backend.readFiles(
      ['binary.bin', 'text.txt'].map((path) => ({ view, path })),
    );
    const hashes = files.flatMap((file) => (file === undefined ? [] : [file.hash]));
    const originalSpawn = Bun.spawn;
    let spawns = 0;
    Bun.spawn = ((options: any) => {
      const command = options.cmd as readonly string[];
      if (command[0] === 'git') spawns += 1;
      return originalSpawn(options);
    }) as typeof Bun.spawn;

    let blobs: readonly (Uint8Array | undefined)[] = [];
    let cached: readonly (Uint8Array | undefined)[] = [];
    try {
      blobs = await backend.readBlobs(hashes);
      cached = await backend.readBlobs(hashes);
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(spawns).toBe(1);
    expect(blobs[0]).toEqual(new Uint8Array([0, 1, 2, 255, 254]));
    expect(new TextDecoder().decode(blobs[1])).toBe('text\n');
    expect(cached).toEqual(blobs);
  });

  it('fails closed when a stored blob is missing from the shadow object store', async () => {
    const { repo, storage } = await createRepo();
    const backend = await open(repo, storage);
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const view = await backend.captureView();
    const file = await backend.readFile(view, 'new.txt');
    if (file === undefined) throw new Error('Missing file');
    await rm(join(storage, 'objects'), { recursive: true, force: true });

    expect(await rejectionOf(backend.readBlobs([file.hash]))).toMatchObject({
      name: 'GitOperationError',
    });
  });
});
