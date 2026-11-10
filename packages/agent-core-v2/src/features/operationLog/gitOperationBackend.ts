import { mkdir, stat } from 'node:fs/promises';

import { dirname, join, resolve } from 'pathe';

import { OperationLogError, type OperationGitHead, type OperationView } from './operationLog';

interface GitOperationBackendOptions {
  readonly repoRoot: string;
  readonly storageRoot: string;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface GitRunOptions {
  readonly shadowIndex?: boolean;
  readonly input?: string;
  readonly allowedExitCodes?: readonly number[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    throw error;
  }
}

export class GitOperationError extends Error {
  override readonly name = 'GitOperationError';

  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'unknown error'}`);
  }
}

export class GitOperationBackend {
  private constructor(
    private readonly repoRoot: string,
    private readonly gitDir: string,
    private readonly actualObjectDir: string,
    private readonly shadowIndexPath: string,
    private readonly shadowObjectDir: string,
  ) {}

  static async open(options: GitOperationBackendOptions): Promise<GitOperationBackend> {
    const repoRoot = resolve(options.repoRoot);
    const storageRoot = resolve(options.storageRoot);
    const rootResult = await runGit(repoRoot, ['rev-parse', '--show-toplevel']);
    const gitDirResult = await runGit(repoRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--absolute-git-dir',
    ]);
    const objectDirResult = await runGit(repoRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'objects',
    ]);
    return new GitOperationBackend(
      rootResult.stdout.trim(),
      gitDirResult.stdout.trim(),
      objectDirResult.stdout.trim(),
      join(storageRoot, 'index'),
      join(storageRoot, 'objects'),
    );
  }

  async captureView(): Promise<OperationView> {
    await mkdir(dirname(this.shadowIndexPath), { recursive: true, mode: 0o700 });
    await mkdir(this.shadowObjectDir, { recursive: true, mode: 0o700 });
    const head = await this.readHead();
    await this.git(['read-tree', ...(head.kind === 'unborn' ? ['--empty'] : ['HEAD'])]);
    await this.git(['add', '-A', '--', '.']);
    const tree = (await this.git(['write-tree'])).stdout.trim();
    const [refs, indexTree, unfinishedOperation] = await Promise.all([
      this.readRefs(),
      this.readActualIndexTree(),
      this.readUnfinishedOperation(),
    ]);
    return {
      tree,
      head,
      refs,
      indexTree,
      ...(unfinishedOperation === undefined ? {} : { unfinishedOperation }),
    };
  }

  async assertRestorable(view: OperationView): Promise<void> {
    const currentUnfinished = await this.readUnfinishedOperation();
    if (currentUnfinished !== undefined) {
      throw new OperationLogError(
        'unfinished-operation',
        `Cannot restore while a ${currentUnfinished} is in progress`,
        { operation: currentUnfinished },
      );
    }
    if (!(await this.actualIndexIsClean())) {
      throw new OperationLogError('staged-changes', 'Cannot restore with staged changes');
    }
    if (view.unfinishedOperation !== undefined) {
      throw new OperationLogError(
        'unfinished-operation',
        `Cannot restore a view recorded during a ${view.unfinishedOperation}`,
        { operation: view.unfinishedOperation },
      );
    }
    const expectedIndexTree = await this.treeForHead(view.head);
    if (view.indexTree === '' || view.indexTree !== expectedIndexTree) {
      throw new OperationLogError('staged-changes', 'The target view contains staged changes');
    }
  }

  private async readHead(): Promise<OperationGitHead> {
    const symbolic = await this.git(['symbolic-ref', '-q', 'HEAD'], {
      allowedExitCodes: [0, 1],
    });
    const targetResult = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      allowedExitCodes: [0, 1],
    });
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim();
      if (targetResult.exitCode !== 0) return { kind: 'unborn', ref };
      return { kind: 'branch', ref, target: targetResult.stdout.trim() };
    }
    if (targetResult.exitCode !== 0) {
      throw new OperationLogError(
        'invalid',
        'Cannot resolve HEAD as a branch, detached commit, or unborn branch',
      );
    }
    return { kind: 'detached', target: targetResult.stdout.trim() };
  }

  private async readRefs(): Promise<Readonly<Record<string, string>>> {
    const result = await this.git(['for-each-ref', '--format=%(refname)%00%(objectname)']);
    const refs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const separator = line.indexOf('\0');
      if (separator <= 0) throw new OperationLogError('corrupt', 'Unexpected git ref record');
      refs[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
    return refs;
  }

  private async readActualIndexTree(): Promise<string> {
    if (!(await pathExists(join(this.gitDir, 'index')))) return this.emptyTree();
    const unmerged = await this.git(['diff', '--cached', '--name-only', '--diff-filter=U'], {
      shadowIndex: false,
    });
    if (unmerged.stdout.trim() !== '') return '';
    return (await this.git(['write-tree'], { shadowIndex: false })).stdout.trim();
  }

  private async actualIndexIsClean(): Promise<boolean> {
    const result = await this.git(['diff', '--cached', '--quiet'], {
      shadowIndex: false,
      allowedExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  }

  private async treeForHead(head: OperationGitHead): Promise<string> {
    if (head.kind === 'unborn') return this.emptyTree();
    return (
      await this.git(['rev-parse', `${head.target}^{tree}`], { shadowIndex: false })
    ).stdout.trim();
  }

  private async emptyTree(): Promise<string> {
    return (await this.git(['mktree'], { input: '', shadowIndex: false })).stdout.trim();
  }

  private async readUnfinishedOperation(): Promise<'merge' | 'rebase' | undefined> {
    if (
      (await pathExists(join(this.gitDir, 'rebase-merge'))) ||
      (await pathExists(join(this.gitDir, 'rebase-apply')))
    ) {
      return 'rebase';
    }
    if (await pathExists(join(this.gitDir, 'MERGE_HEAD'))) return 'merge';
    return undefined;
  }

  private git(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const env: Record<string, string> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OBJECT_DIRECTORY: this.shadowObjectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: this.actualObjectDir,
    };
    if (options.shadowIndex !== false) env['GIT_INDEX_FILE'] = this.shadowIndexPath;
    return runGit(this.repoRoot, args, env, options);
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
  options: GitRunOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    timeout: 60_000,
  });
  if (options.input !== undefined) {
    if (proc.stdin === undefined) throw new Error('Git stdin is unavailable');
    await proc.stdin.write(options.input);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = { stdout, stderr, exitCode };
  if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
    throw new GitOperationError(args, stderr, exitCode);
  }
  return result;
}
