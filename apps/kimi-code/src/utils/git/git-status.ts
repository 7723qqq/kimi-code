/**
 * Cached git branch and working-tree status for the footer.
 *
 * getStatus() only reads the cache. The first read, refresh(), a HEAD change,
 * and a read past the 30s status TTL schedule a refresh. The git process
 * starts on a later turn, not on the caller's stack, and not when the cache
 * is constructed. HEAD is polled every 2 seconds. Pull request lookup stays
 * async and never blocks a read.
 */

import { join } from 'node:path';

import { FSWatcher } from 'chokidar';

import { resolveCommandPath } from '#/utils/process/resolve-command';

const STATUS_TTL_MS = 30_000;
const HEAD_POLL_INTERVAL_MS = 2_000;
const PULL_REQUEST_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 2_000;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/;
const UNBORN_PREFIXES = ['No commits yet on ', 'Initial commit on '];
const PORCELAIN_DETACHED_HEAD = 'HEAD (no branch)';

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  readonly pullRequest: PullRequestInfo | null;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
}

export interface GitStatusCache {
  /** Returns the last status, or `null` when it is not available yet or this is not a git repo. */
  getStatus(): GitStatus | null;
  /** Refresh now, ignoring the status TTL. No-op when a refresh is already running; one follow-up runs after it. */
  refresh(): void;
  dispose(): void;
}

export interface GitCommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeout: number;
  readonly maxBuffer?: number;
}

export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
}

export interface GitWatchHandle {
  close(): Promise<void>;
}

export interface GitStatusDeps {
  readonly now: () => number;
  readonly resolveCommand: (command: string, cwd: string) => string | undefined;
  readonly exec: (
    command: string,
    args: readonly string[],
    options: GitCommandOptions,
  ) => Promise<GitCommandResult | null>;
  readonly watch: (headPath: string, onChange: () => void) => GitWatchHandle | null;
}

export interface GitStatusCacheOptions {
  readonly onChange?: () => void;
  readonly deps?: Partial<GitStatusDeps>;
}

interface StatusState {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
  fetchedAt: number;
  loaded: boolean;
}

interface PullRequestState {
  value: PullRequestInfo | null;
  branch: string | null;
  fetchedAt: number;
  pendingBranch: string | null;
  requestId: number;
}

interface BunSubprocess {
  readonly stdout: { text(): Promise<string> };
  readonly exited: Promise<number>;
}

interface BunRuntime {
  spawn(
    command: readonly string[],
    options: {
      stdin: 'ignore';
      stdout: 'pipe';
      stderr: 'ignore';
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
      maxBuffer?: number;
    },
  ): BunSubprocess;
}

const EMPTY_STATUS: StatusState = {
  branch: null,
  dirty: false,
  ahead: 0,
  behind: 0,
  diffAdded: 0,
  diffDeleted: 0,
  fetchedAt: 0,
  loaded: false,
};

const DEFAULT_DEPS: GitStatusDeps = {
  now: () => Date.now(),
  resolveCommand: resolveCommandPath,
  exec: async (command, args, options) => {
    const bun = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
    if (bun === undefined) return null;
    try {
      const proc = bun.spawn([command, ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      });
      const stdout = await proc.stdout.text();
      const code = await proc.exited;
      return { code, stdout };
    } catch {
      return null;
    }
  },
  watch: (headPath, onChange) => {
    const watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      usePolling: true,
      interval: HEAD_POLL_INTERVAL_MS,
      ignorePermissionErrors: true,
    });
    watcher.on('add', onChange);
    watcher.on('change', onChange);
    watcher.on('unlink', onChange);
    watcher.on('error', () => undefined);
    watcher.add(headPath);
    return {
      close: async () => {
        await watcher.close();
      },
    };
  },
};

function resolveDeps(overrides: Partial<GitStatusDeps> | undefined): GitStatusDeps {
  return {
    now: overrides?.now ?? DEFAULT_DEPS.now,
    resolveCommand: overrides?.resolveCommand ?? DEFAULT_DEPS.resolveCommand,
    exec: overrides?.exec ?? DEFAULT_DEPS.exec,
    watch: overrides?.watch ?? DEFAULT_DEPS.watch,
  };
}

export function createGitStatusCache(
  workDir: string,
  options: GitStatusCacheOptions = {},
): GitStatusCache {
  const d = resolveDeps(options.deps);
  // Resolve through PATH to an absolute path — a bare name would let cmd.exe
  // pick up a `git.exe` planted in the workspace.
  const git = d.resolveCommand('git', workDir);
  let disposed = false;
  let epoch = 0;
  let repoDetected = false;
  let isRepo = false;
  let inFlight = false;
  let pendingForce = false;
  let refreshQueued = false;
  let queuedForce = false;
  let headWatcher: GitWatchHandle | null = null;
  let status: StatusState = EMPTY_STATUS;
  let pullRequest: PullRequestState = {
    value: null,
    branch: null,
    fetchedAt: 0,
    pendingBranch: null,
    requestId: 0,
  };

  const cache: GitStatusCache = {
    getStatus: () => {
      if (git === undefined || disposed) return null;
      if (repoDetected && !isRepo) return null;
      const now = d.now();
      if (!repoDetected || now - status.fetchedAt >= STATUS_TTL_MS) {
        requestRefresh(false);
      }
      if (status.loaded && status.branch !== null) {
        refreshPullRequestIfNeeded(status.branch, now);
      }
      return currentStatus();
    },
    refresh: () => {
      requestRefresh(true);
    },
    dispose: () => {
      disposed = true;
      epoch += 1;
      inFlight = false;
      pendingForce = false;
      refreshQueued = false;
      queuedForce = false;
      const watcher = headWatcher;
      headWatcher = null;
      if (watcher !== null) {
        void watcher.close().catch(() => undefined);
      }
    },
  };

  return cache;

  function requestRefresh(force: boolean): void {
    if (force) queuedForce = true;
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      const runForce = queuedForce;
      queuedForce = false;
      void runRefresh(runForce);
    });
  }

  async function runRefresh(force: boolean): Promise<void> {
    if (disposed || git === undefined) return;
    if (repoDetected && !isRepo) return;
    if (inFlight) {
      if (force) pendingForce = true;
      return;
    }
    if (!force && repoDetected && d.now() - status.fetchedAt < STATUS_TTL_MS) return;

    inFlight = true;
    const epochAtStart = epoch;
    try {
      if (!repoDetected) {
        await probeRepo(epochAtStart);
      }
      if (disposed || epoch !== epochAtStart || !isRepo) return;
      await loadStatus(epochAtStart);
    } finally {
      if (epoch === epochAtStart) {
        inFlight = false;
        if (pendingForce && !disposed) {
          pendingForce = false;
          void runRefresh(true);
        }
      }
    }
  }

  async function probeRepo(epochAtStart: number): Promise<void> {
    if (git === undefined) return;
    const result = await execGit(['-C', workDir, 'rev-parse', '--absolute-git-dir']);
    if (disposed || epoch !== epochAtStart) return;
    repoDetected = true;
    if (result === null || result.code !== 0) {
      isRepo = false;
      return;
    }
    const gitDir = result.stdout.trim();
    if (gitDir.length === 0) {
      isRepo = false;
      return;
    }
    isRepo = true;
    startHeadWatch(join(gitDir, 'HEAD'));
  }

  function startHeadWatch(headPath: string): void {
    if (disposed || headWatcher !== null) return;
    try {
      headWatcher = d.watch(headPath, () => {
        requestRefresh(true);
      });
    } catch {
      // Turn end and the status TTL still refresh if watching is unavailable.
      headWatcher = null;
    }
  }

  async function loadStatus(epochAtStart: number): Promise<void> {
    if (git === undefined) return;
    const result = await execGit(['-C', workDir, 'status', '--porcelain', '-b']);
    if (disposed || epoch !== epochAtStart) return;
    if (result === null || result.code !== 0) {
      status = { ...status, fetchedAt: d.now() };
      return;
    }

    const parsed = parsePorcelain(result.stdout);
    if (parsed === null) {
      status = { ...status, fetchedAt: d.now() };
      return;
    }
    if (parsed.branch === null) {
      publishStatus({
        branch: null,
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        fetchedAt: d.now(),
        loaded: true,
      });
      return;
    }

    let diffAdded = 0;
    let diffDeleted = 0;
    if (parsed.dirty) {
      const diff = await execGit(['-C', workDir, 'diff', '--numstat', 'HEAD', '--']);
      if (disposed || epoch !== epochAtStart) return;
      if (diff !== null && diff.code === 0) {
        const counts = parseDiffStats(diff.stdout);
        diffAdded = counts.added;
        diffDeleted = counts.deleted;
      }
    }

    publishStatus({
      branch: parsed.branch,
      dirty: parsed.dirty,
      ahead: parsed.ahead,
      behind: parsed.behind,
      diffAdded,
      diffDeleted,
      fetchedAt: d.now(),
      loaded: true,
    });
    refreshPullRequestIfNeeded(parsed.branch, d.now());
  }

  function publishStatus(next: StatusState): void {
    const changed = !sameStatus(status, next);
    status = next;
    if (changed) options.onChange?.();
  }

  function currentStatus(): GitStatus | null {
    if (!status.loaded || status.branch === null) return null;
    return {
      branch: status.branch,
      dirty: status.dirty,
      ahead: status.ahead,
      behind: status.behind,
      diffAdded: status.diffAdded,
      diffDeleted: status.diffDeleted,
      pullRequest: pullRequest.branch === status.branch ? pullRequest.value : null,
    };
  }

  function execGit(args: readonly string[]): Promise<GitCommandResult | null> {
    if (git === undefined) return Promise.resolve(null);
    return runCommand(d, git, args, { timeout: SPAWN_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  }

  function refreshPullRequestIfNeeded(branchName: string, now: number): void {
    if (pullRequest.pendingBranch === branchName) return;
    const fetchedAt = pullRequest.branch === branchName ? pullRequest.fetchedAt : 0;
    if (now - fetchedAt < PULL_REQUEST_TTL_MS) return;

    const requestId = pullRequest.requestId + 1;
    pullRequest = {
      value: pullRequest.branch === branchName ? pullRequest.value : null,
      branch: branchName,
      fetchedAt,
      pendingBranch: branchName,
      requestId,
    };

    void readPullRequest(d, workDir).then((value) => {
      if (disposed || pullRequest.requestId !== requestId) return;

      const previous = pullRequest.branch === branchName ? pullRequest.value : null;
      const changed = !samePullRequest(previous, value);
      pullRequest = {
        value,
        branch: branchName,
        fetchedAt: d.now(),
        pendingBranch: null,
        requestId,
      };
      if (changed) options.onChange?.();
    });
  }
}

async function runCommand(
  d: GitStatusDeps,
  command: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult | null> {
  try {
    return await d.exec(command, args, options);
  } catch {
    return null;
  }
}

function parsePorcelain(stdout: string): {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
} | null {
  let header: string | null = null;
  let dirty = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('## ')) {
      header = line;
    } else if (line.trim().length > 0) {
      dirty = true;
    }
  }
  if (header === null) return null;
  const parsed = parsePorcelainHeader(header);
  if (parsed === null) return null;
  return { ...parsed, dirty: parsed.branch !== null && dirty };
}

function parsePorcelainHeader(
  line: string,
): { branch: string | null; ahead: number; behind: number } | null {
  if (!line.startsWith('## ')) return null;
  let body = line.slice(3);
  const aheadBehind = AHEAD_BEHIND_RE.exec(body);
  const ahead = Number.parseInt(aheadBehind?.[1] ?? '0', 10) || 0;
  const behind = Number.parseInt(aheadBehind?.[2] ?? '0', 10) || 0;
  const bracket = body.indexOf(' [');
  if (bracket >= 0) body = body.slice(0, bracket);
  if (body === PORCELAIN_DETACHED_HEAD) return { branch: null, ahead: 0, behind: 0 };
  for (const prefix of UNBORN_PREFIXES) {
    if (body.startsWith(prefix)) {
      body = body.slice(prefix.length);
      break;
    }
  }
  const upstream = body.indexOf('...');
  if (upstream >= 0) body = body.slice(0, upstream);
  const branch = body.trim();
  return { branch: branch.length > 0 ? branch : null, ahead, behind };
}

function parseDiffStats(stdout: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [addedText, deletedText] = line.split('\t');
    added += parseDiffNumstatCount(addedText);
    deleted += parseDiffNumstatCount(deletedText);
  }
  return { added, deleted };
}

function parseDiffNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sameStatus(a: StatusState, b: StatusState): boolean {
  return (
    a.loaded === b.loaded &&
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.diffAdded === b.diffAdded &&
    a.diffDeleted === b.diffDeleted
  );
}

async function readPullRequest(d: GitStatusDeps, workDir: string): Promise<PullRequestInfo | null> {
  // Resolve gh through PATH as well — this runs with cwd = workDir, where a
  // planted `gh.exe` would otherwise be picked up by cmd.exe on Windows.
  const gh = d.resolveCommand('gh', workDir);
  if (gh === undefined) return null;
  const result = await runCommand(d, gh, ['pr', 'view', '--json', 'number,url'], {
    cwd: workDir,
    env: {
      ...process.env,
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_PROMPT_DISABLED: '1',
    },
    timeout: PR_SPAWN_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });
  if (result === null || result.code !== 0) return null;
  return parsePullRequest(result.stdout);
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.url === b.url;
}

function parsePullRequest(stdout: string): PullRequestInfo | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const number = record['number'];
    const url = record['url'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
    if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
    return { number, url };
  } catch {
    return null;
  }
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface FormatGitBadgeOptions {
  readonly linkPullRequest?: boolean;
}

export function formatGitBadgeBase(status: GitStatus): string {
  const parts: string[] = [];
  const diff = formatDiffStats(status);
  if (diff) parts.push(diff);
  let sync = '';
  if (status.ahead > 0) sync += `↑${status.ahead}`;
  if (status.behind > 0) sync += `↓${status.behind}`;
  if (sync) parts.push(sync);
  return parts.length === 0 ? status.branch : `${status.branch} [${parts.join(' ')}]`;
}

export function formatPullRequestBadge(
  pullRequest: PullRequestInfo,
  options: FormatGitBadgeOptions = {},
): string {
  const prText = `[PR#${String(pullRequest.number)}]`;
  return options.linkPullRequest ? toTerminalHyperlink(prText, pullRequest.url) : prText;
}

export function formatGitBadge(status: GitStatus, options: FormatGitBadgeOptions = {}): string {
  const base = formatGitBadgeBase(status);
  if (status.pullRequest === null) return base;

  return `${base} ${formatPullRequestBadge(status.pullRequest, options)}`;
}

function formatDiffStats(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.diffAdded > 0) parts.push(`+${String(status.diffAdded)}`);
  if (status.diffDeleted > 0) parts.push(`-${String(status.diffDeleted)}`);
  if (parts.length > 0) return parts.join(' ');
  return status.dirty ? '±' : null;
}

function toTerminalHyperlink(text: string, url: string): string {
  if (!isSafeHttpUrl(url)) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
