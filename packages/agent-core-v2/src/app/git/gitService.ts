/**
 * `git` domain (L1) — `IGitService` implementation.
 *
 * Runs `git status` / `git diff` (and `gh pr view`) against a repository on the
 * local disk by spawning `git` / `gh` through `node:child_process` directly.
 * Bound at App scope — it owns no Session dependency, so the caller supplies an
 * absolute `cwd` and already-confined repo-relative paths.
 *
 * The process runner below mirrors v1 `services/fs/fsGitService.ts`: a small
 * self-contained `runCommand` + `killChild` that collects stdout/stderr and the
 * exit code, with optional timeout / abort support (used by `gh pr view`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';

import type { FsDiffResponse, FsGitStatusResponse, FsPullRequest } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';

import { IGitService } from './git';
import { parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';

/** Cap a single file's unified diff so a runaway generated file cannot blow up
 *  the envelope; the response carries `truncated` so the UI can say so. */
const DIFF_MAX_BYTES = 1_048_576;

const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

export class GitService implements IGitService {
  declare readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();

  async status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    const inside = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await runCommand('git', ['status', '--porcelain=v1', '--branch'], cwd);
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, pathFilter);

    // Aggregate line stats against HEAD. Only worth a second spawn when the
    // tree is dirty AND there is a HEAD to diff against (a repo with no commits
    // yet has neither side); otherwise the stats stay 0. Dirtiness is read from
    // the UNFILTERED porcelain and the numstat is NOT scoped by `pathFilter` —
    // the header counter reflects the whole working tree.
    const dirty = porc.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('## '));
    if (dirty) {
      const head = await runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
      if (head.exitCode === 0) {
        const numstat = await runCommand('git', ['diff', '--no-color', '--numstat', 'HEAD', '--'], cwd);
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd);
    return result;
  }

  async diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    const inside = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await runCommand('git', ['status', '--porcelain=v1', '--', relPath], cwd);
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    // A repo with no commits yet has no HEAD to diff against — every changed
    // file is all-new there, same as the untracked case.
    const headRes = await runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      // An untracked file has no HEAD side; diff it against /dev/null so the UI
      // gets an all-added hunk. `git diff --no-index` exits 1 when files differ.
      const res = await runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', relPath],
        cwd,
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await runCommand('git', ['diff', '--no-color', 'HEAD', '--', relPath], cwd);
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        // Not changed at all — distinguish "clean file" (empty diff is fine)
        // from a path that does not exist anywhere.
        const exists = await stat(absPath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new KimiError(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${relPath}`, {
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

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PR_SPAWN_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await runCommand(
        'gh',
        ['pr', 'view', '--json', 'number,url,state'],
        cwd,
        {
          env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
          signal: controller.signal,
        },
      );
      const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
      this.pullRequestCache.set(cwd, { value, fetchedAt: now });
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  private gitUnavailable(cwd: string, detail: string): KimiError {
    return new KimiError(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: ${detail}`, {
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
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const kill = (): void => {
      killChild(child);
    };
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        kill();
        finish({ exitCode: -1, stdout, stderr });
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', () => {
      finish({ exitCode: -1, stdout, stderr });
    });
    child.once('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function killChild(child: ChildProcess): void {
  // On Windows, `ChildProcess.kill()` only signals the direct child (e.g. the
  // `cmd.exe` wrapper when a shell is involved, or the `git`/`gh` parent),
  // leaving grandchildren alive and holding the cwd. Terminate the whole
  // process tree so the working directory is released promptly.
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {});
      return;
    } catch {
      // fall through to the direct kill below
    }
  }
  try {
    child.kill();
  } catch {
    /* best effort */
  }
}

registerScopedService(LifecycleScope.App, IGitService, GitService, InstantiationType.Delayed, 'git');
