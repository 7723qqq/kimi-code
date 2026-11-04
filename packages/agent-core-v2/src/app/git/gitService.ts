import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { resolveProgramPath } from '#/environment/programPath';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import type { FsDiffResponse, FsGitStatusResponse, FsPullRequest } from './git';
import { IGitService } from './git';
import { parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';
import { findGitWorkTree, type GitWorkTree } from './workTree';

const DIFF_MAX_BYTES = 1_048_576;

const GIT_SPAWN_TIMEOUT_MS = 30_000;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export class GitService implements IGitService {
  declare readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { branch: string; value: FsPullRequest | null; fetchedAt: number }
  >();

  constructor(
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  async status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(
        cwd,
        inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`,
      );
    }

    const porc = await this.runCommand('git', ['status', '--porcelain=v1', '--branch', '-z'], cwd);
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, pathFilter);

    const dirty = porc.stdout
      .split('\0')
      .some((record) => record.length > 0 && !record.startsWith('## '));
    if (dirty) {
      const head = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
      if (head.exitCode === 0) {
        const numstat = await this.runCommand(
          'git',
          ['diff', '--no-color', '--numstat', 'HEAD', '--'],
          cwd,
        );
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd, result.branch);
    return result;
  }

  async diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(
        cwd,
        inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`,
      );
    }

    const statusRes = await this.runCommand(
      'git',
      ['status', '--porcelain=v1', '--', relPath],
      cwd,
    );
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(
        cwd,
        statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`,
      );
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      const res = await this.runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', NULL_DEVICE, relPath],
        cwd,
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await this.runCommand('git', ['diff', '--no-color', 'HEAD', '--', relPath], cwd);
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await this.fs.lstat(absPath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${relPath}`, {
            details: { path: relPath },
          });
        }
      }
      diffStdout = res.stdout;
    }

    const truncated = diffStdout.length > DIFF_MAX_BYTES;
    return {
      path: relPath,
      diff: truncated ? diffStdout.slice(0, DIFF_MAX_BYTES) : diffStdout,
      truncated,
    };
  }

  findWorkTree(cwd: string): Promise<GitWorkTree | null> {
    return findGitWorkTree(this.fs, cwd);
  }

  private async readPullRequest(cwd: string, branch: string): Promise<FsPullRequest | null> {
    if (branch === '') return null;
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (
      cached !== undefined &&
      cached.branch === branch &&
      now - cached.fetchedAt < PULL_REQUEST_TTL_MS
    ) {
      return cached.value;
    }

    const res = await this.runCommand('gh', ['pr', 'view', '--json', 'number,url,state'], cwd, {
      env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
      timeoutMs: PR_SPAWN_TIMEOUT_MS,
    });
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    this.pullRequestCache.set(cwd, { branch, value, fetchedAt: now });
    return value;
  }

  private async runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const program = localProgramPath(cmd, cwd);
    if (program === undefined) {
      return { exitCode: -1, stdout: '', stderr: '' };
    }
    const workspaceId = this.resolveWorkspaceId(cwd);
    const lease = this.resolver.acquire({ workspaceId, runtimeId: 'local' }, ['process']);
    const spawned = await lease.runtime.process!
      .spawn(program, args, { cwd, env: options.env })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      return { exitCode: -1, stdout: '', stderr: '' };
    }
    const { proc } = spawned;

    const work = Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? GIT_SPAWN_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([
        work.then(([stdout, stderr, exitCode]) => ({
          kind: 'done' as const,
          stdout,
          stderr,
          exitCode,
        })),
        timeout.then((kind) => ({ kind })),
      ]);
      if (result.kind === 'done') {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      await proc.kill('SIGKILL').catch(() => {});
      const [stdout, stderr] = await work
        .then(([so, se]) => [so, se] as const)
        .catch(() => ['', ''] as const);
      return { exitCode: -1, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void proc.dispose();
      lease.dispose();
    }
  }

  private resolveWorkspaceId(cwd: string): string {
    const workspace = this.workspaces.findByRoot(cwd);
    if (workspace === undefined) {
      throw new Error(`workspace for root ${cwd} is not materialized`);
    }
    return workspace.id;
  }

  private gitUnavailable(cwd: string, detail: string): Error2 {
    return new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: ${detail}`, {
      details: { cwd, detail },
    });
  }
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

function localProgramPath(cmd: string, cwd: string): string | undefined {
  try {
    return resolveProgramPath(cmd, { cwd });
  } catch {
    return undefined;
  }
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

registerScopedService(
  LifecycleScope.App,
  IGitService,
  GitService,
  ScopeActivation.OnScopeCreated,
  'git',
);
