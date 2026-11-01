import { describe, expect, it } from 'bun:test';
import { Readable, Writable } from 'node:stream';

import {
  readGitHistory,
  readRepoHead,
  readRepoMap,
  readRepoTree,
} from '#/features/gitMemory/gitReader';
import type { IHostProcessService } from '#/os/interface/hostProcess';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface FakeReply {
  readonly out: string;
  readonly err: string;
  readonly code: number;
}

function fakeProcess(handler: (args: readonly string[]) => FakeReply): {
  readonly service: IHostProcessService;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const service = {
    _serviceBrand: undefined as undefined,
    spawn: async (_command: string, args?: readonly string[]) => {
      calls.push([...(args ?? [])]);
      const reply = handler(args ?? []);
      return {
        _serviceBrand: undefined as undefined,
        pid: 1,
        exitCode: reply.code,
        stdin: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stdout: Readable.from([reply.out]),
        stderr: Readable.from([reply.err]),
        wait: async () => reply.code,
        kill: async () => {},
        dispose: () => {},
      };
    },
  };
  return { service: service as unknown as IHostProcessService, calls };
}

function repoHandler(args: readonly string[]): FakeReply {
  if (args.includes('--name-only')) {
    return { out: `${SHA_A}\n\na.ts\nb.ts\n\n${SHA_B}\n\nc.ts\n\n`, err: '', code: 0 };
  }
  return {
    out:
      `${SHA_A}\t2026-01-02\tluozihao\tfix: one\0the body of one\0\n` +
      `${SHA_B}\t2026-01-01\tsomeone\tfeat: two\0\0\n`,
    err: '',
    code: 0,
  };
}

describe('git reader', () => {
  it('runs exactly two bounded commands', async () => {
    const { service, calls } = fakeProcess(repoHandler);
    const result = await readGitHistory(service, '/repo', 500, SHA_A);
    expect(result.kind).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-c',
      'core.quotePath=false',
      '-C',
      '/repo',
      'log',
      '-500',
      '--date=short',
      '--format=%H%x09%ad%x09%an%x09%s%x00%b%x00',
    ]);
    expect(calls[1]).toEqual([
      '-c',
      'core.quotePath=false',
      '-C',
      '/repo',
      'log',
      '-500',
      '--name-only',
      '--no-renames',
      '--format=%H',
    ]);
  });

  it('parses sha, date, author, subject, body and files per commit', async () => {
    const { service } = fakeProcess(repoHandler);
    const result = await readGitHistory(service, '/repo', 500, SHA_A);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.headSha).toBe(SHA_A);
    expect(result.commits).toEqual([
      {
        sha: SHA_A,
        date: '2026-01-02',
        author: 'luozihao',
        subject: 'fix: one',
        body: 'the body of one',
        files: ['a.ts', 'b.ts'],
      },
      {
        sha: SHA_B,
        date: '2026-01-01',
        author: 'someone',
        subject: 'feat: two',
        body: '',
        files: ['c.ts'],
      },
    ]);
  });

  it('keeps a body that contains tabs and blank lines', async () => {
    const body = 'first line\n\tindented\n\nlast line';
    const { service } = fakeProcess((args) =>
      args.includes('--name-only')
        ? { out: `${SHA_A}\n\na.ts\n\n`, err: '', code: 0 }
        : { out: `${SHA_A}\t2026-01-02\tluozihao\tfix: one\0${body}\0\n`, err: '', code: 0 },
    );
    const result = await readGitHistory(service, '/repo', 500, SHA_A);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.commits[0]?.body).toBe(body);
  });

  it('reports a non-repository as unavailable without throwing', async () => {
    const { service } = fakeProcess(() => ({
      out: '',
      err: 'fatal: not a git repository (or any of the parent directories): .git',
      code: 128,
    }));
    expect((await readGitHistory(service, '/repo', 500, SHA_A)).kind).toBe('unavailable');
  });

  it('reports a failed command as failed without throwing', async () => {
    const { service } = fakeProcess(() => ({ out: '', err: 'boom', code: 1 }));
    expect((await readGitHistory(service, '/repo', 500, SHA_A)).kind).toBe('failed');
  });

  it('reports a spawn failure as failed without throwing', async () => {
    const service = {
      _serviceBrand: undefined as undefined,
      spawn: () => Promise.reject(new Error('no git')),
    };
    const result = await readGitHistory(
      service as unknown as IHostProcessService,
      '/repo',
      500,
      SHA_A,
    );
    expect(result.kind).toBe('failed');
  });
});

describe('repo tree', () => {
  it('reads the directories of HEAD with one command', async () => {
    const { service, calls } = fakeProcess(() => ({
      out: 'apps\npackages/agent-core-v2\npackages/agent-core-v2/src\n',
      err: '',
      code: 0,
    }));
    const dirs = await readRepoTree(service, '/repo');
    expect(dirs).toEqual(['apps', 'packages/agent-core-v2', 'packages/agent-core-v2/src']);
    expect(calls[0]).toEqual([
      '-c',
      'core.quotePath=false',
      '-C',
      '/repo',
      'ls-tree',
      '-d',
      '-r',
      '--name-only',
      'HEAD',
    ]);
  });

  it('returns undefined when the tree cannot be read', async () => {
    const { service } = fakeProcess(() => ({ out: '', err: 'boom', code: 1 }));
    expect(await readRepoTree(service, '/repo')).toBeUndefined();
  });
});

describe('repo map', () => {
  it('lists the whole repository when no path is given', async () => {
    const { service, calls } = fakeProcess(() => ({
      out: 'apps\napps/kimi-code\npackages\n',
      err: '',
      code: 0,
    }));
    const entries = await readRepoMap(service, '/repo', undefined);
    expect(entries).toEqual(['apps', 'apps/kimi-code', 'packages']);
    expect(calls[0]).not.toContain('--');
  });

  it('narrows the listing to a path prefix', async () => {
    const { service, calls } = fakeProcess(() => ({
      out: 'packages\npackages/agent-core-v2\n',
      err: '',
      code: 0,
    }));
    const entries = await readRepoMap(service, '/repo', 'packages');
    expect(entries).toEqual(['packages', 'packages/agent-core-v2']);
    expect(calls[0]).toContain('--');
    expect(calls[0]).toContain('packages');
  });
});

describe('repo head', () => {
  it('reads the repository root, the working prefix and the head sha in one command', async () => {
    const { service, calls } = fakeProcess(() => ({
      out: 'D:/repo\npackages/core/\nsha\n',
      err: '',
      code: 0,
    }));
    const head = await readRepoHead(service, '/repo');
    expect(head?.repoRoot).toBe('D:/repo');
    expect(head?.prefix).toBe('packages/core/');
    expect(head?.headSha).toBe('sha');
    expect(calls[0]).toEqual([
      '-C',
      '/repo',
      'rev-parse',
      '--show-toplevel',
      '--show-prefix',
      'HEAD',
    ]);
  });

  it('returns undefined when there is no repository', async () => {
    const { service } = fakeProcess(() => ({ out: '', err: 'fatal', code: 128 }));
    expect(await readRepoHead(service, '/repo')).toBeUndefined();
  });
});
