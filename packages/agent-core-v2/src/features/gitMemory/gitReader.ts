import type { Readable } from 'node:stream';

import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { IHostTimerHandle, IHostTimers } from '#/os/interface/hostTimers';

import type { CommitRecord } from './types';

const GIT_TIMEOUT_MS = 5_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const SYSTEM_HOST_TIMERS: IHostTimers = {
  _serviceBrand: undefined,
  setClampedTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export interface RepoHead {
  readonly repoRoot: string;
  readonly prefix: string;
  readonly headSha: string;
}

export type GitReadResult =
  | {
      readonly kind: 'ok';
      readonly headSha: string;
      readonly commits: readonly CommitRecord[];
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly reason: string };

interface CommandOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function runGit(
  process: IHostProcessService,
  cwd: string,
  args: readonly string[],
  timers: IHostTimers | undefined,
): Promise<CommandOutcome> {
  const hostTimers = timers ?? SYSTEM_HOST_TIMERS;
  let child;
  try {
    child = await process.spawn('git', args, { cwd });
  } catch {
    return { ok: false, stdout: '', stderr: 'spawn failed' };
  }
  try {
    child.stdin.end();
  } catch {}

  const work = Promise.all([collect(child.stdout), collect(child.stderr), child.wait()]);
  work.catch(() => {});

  let handle: IHostTimerHandle | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      handle = hostTimers.setTimeout(() => {
        timedOut = true;
        reject(new Error('git command timed out'));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    return { ok: exitCode === 0, stdout, stderr };
  } catch {
    try {
      await child.kill('SIGKILL');
    } catch {}
    await work.catch(() => {});
    return { ok: false, stdout: '', stderr: timedOut ? 'timeout' : 'command failed' };
  } finally {
    if (handle !== undefined) hostTimers.clearTimeout(handle);
    try {
      await child.dispose();
    } catch {}
  }
}

interface CommitMeta {
  readonly date: string;
  readonly author: string;
  readonly subject: string;
}

function parseMeta(stdout: string): Map<string, CommitMeta> {
  const meta = new Map<string, CommitMeta>();
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const sha = parts[0]?.trim() ?? '';
    if (sha.length === 0) continue;
    meta.set(sha, {
      date: parts[1]?.trim() ?? '',
      author: parts[2]?.trim() ?? '',
      subject: parts.slice(3).join('\t').trim(),
    });
  }
  return meta;
}

function parseCommits(
  stdout: string,
  meta: Map<string, CommitMeta>,
): CommitRecord[] {
  const commits: CommitRecord[] = [];
  let sha: string | undefined;
  let files: string[] = [];

  const flush = (): void => {
    if (sha === undefined) return;
    if (files.length > 0) {
      const info = meta.get(sha);
      commits.push({
        sha,
        date: info?.date ?? '',
        author: info?.author ?? '',
        subject: info?.subject ?? '',
        files,
      });
    }
    sha = undefined;
    files = [];
  };

  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (SHA_PATTERN.test(text)) {
      flush();
      sha = text;
      continue;
    }
    if (sha !== undefined) files.push(text);
  }
  flush();
  return commits;
}

export async function readRepoHead(
  process: IHostProcessService,
  cwd: string,
  timers?: IHostTimers,
): Promise<RepoHead | undefined> {
  const head = await runGit(
    process,
    cwd,
    ['-C', cwd, 'rev-parse', '--show-toplevel', '--show-prefix', 'HEAD'],
    timers,
  );
  if (!head.ok) return undefined;
  const lines = head.stdout.split('\n');
  const repoRoot = (lines[0] ?? '').trim();
  const prefix = (lines[1] ?? '').trim();
  const headSha = (lines[2] ?? '').trim();
  if (repoRoot.length === 0 || headSha.length === 0) return undefined;
  return { repoRoot, prefix, headSha };
}

export async function readGitHistory(
  process: IHostProcessService,
  cwd: string,
  window: number,
  timers?: IHostTimers,
): Promise<GitReadResult> {
  const head = await runGit(
    process,
    cwd,
    ['-C', cwd, 'rev-parse', 'HEAD'],
    timers,
  );
  if (!head.ok) {
    if (head.stderr.includes('not a git repository')) return { kind: 'unavailable' };
    return { kind: 'failed', reason: head.stderr };
  }

  const meta = await runGit(
    process,
    cwd,
    [
      '-c',
      'core.quotePath=false',
      '-C',
      cwd,
      'log',
      `-${window}`,
      '--date=short',
      '--format=%H%x09%ad%x09%an%x09%s',
    ],
    timers,
  );
  if (!meta.ok) {
    if (meta.stderr.includes('not a git repository')) return { kind: 'unavailable' };
    return { kind: 'failed', reason: meta.stderr };
  }

  const files = await runGit(
    process,
    cwd,
    [
      '-c',
      'core.quotePath=false',
      '-C',
      cwd,
      'log',
      `-${window}`,
      '--name-only',
      '--no-renames',
      '--format=%H',
    ],
    timers,
  );
  if (!files.ok) {
    if (files.stderr.includes('not a git repository')) return { kind: 'unavailable' };
    return { kind: 'failed', reason: files.stderr };
  }

  const headSha = head.stdout.trim();
  if (headSha.length === 0) return { kind: 'failed', reason: 'empty HEAD' };

  return {
    kind: 'ok',
    headSha,
    commits: parseCommits(files.stdout, parseMeta(meta.stdout)),
  };
}
