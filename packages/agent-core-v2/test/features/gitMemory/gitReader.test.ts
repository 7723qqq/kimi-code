import { describe, expect, it } from 'bun:test';
import { Readable, Writable } from 'node:stream';

import { readGitHistory, readRepoHead } from '#/features/gitMemory/gitReader';
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
  if (args.includes('rev-parse')) return { out: `${SHA_A}\n`, err: '', code: 0 };
  if (args.includes('--name-only')) {
    return {
      out: `${SHA_A}\n\na.ts\nb.ts\n\n${SHA_B}\n\nc.ts\n\n`,
      err: '',
      code: 0,
    };
  }
  return {
    out: `${SHA_A}\t2026-01-02\tfix: one\n${SHA_B}\t2026-01-01\tfeat: two\n`,
    err: '',
    code: 0,
  };
}

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

describe('git reader', () => {
  it('runs exactly three bounded commands', async () => {
    const { service, calls } = fakeProcess(repoHandler);
    const result = await readGitHistory(service, '/repo', 500);
    expect(result.kind).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(['-C', '/repo', 'rev-parse', 'HEAD']);
    expect(calls[1]).toEqual([
      '-C',
      '/repo',
      'log',
      '-500',
      '--date=short',
      '--format=%H%x09%ad%x09%s',
    ]);
    expect(calls[2]).toEqual([
      '-C',
      '/repo',
      'log',
      '-500',
      '--name-only',
      '--no-renames',
      '--format=%H',
    ]);
  });

  it('parses sha, date, subject and files per commit', async () => {
    const { service } = fakeProcess(repoHandler);
    const result = await readGitHistory(service, '/repo', 500);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.headSha).toBe(SHA_A);
    expect(result.commits).toEqual([
      {
        sha: SHA_A,
        date: '2026-01-02',
        subject: 'fix: one',
        files: ['a.ts', 'b.ts'],
      },
      { sha: SHA_B, date: '2026-01-01', subject: 'feat: two', files: ['c.ts'] },
    ]);
  });

  it('reports a non-repository as unavailable without throwing', async () => {
    const { service } = fakeProcess(() => ({
      out: '',
      err: 'fatal: not a git repository (or any of the parent directories): .git',
      code: 128,
    }));
    const result = await readGitHistory(service, '/repo', 500);
    expect(result.kind).toBe('unavailable');
  });

  it('reports a failed command as failed without throwing', async () => {
    const { service } = fakeProcess(() => ({ out: '', err: 'boom', code: 1 }));
    const result = await readGitHistory(service, '/repo', 500);
    expect(result.kind).toBe('failed');
  });

  it('reports a spawn failure as failed without throwing', async () => {
    const service = {
      _serviceBrand: undefined as undefined,
      spawn: async () => {
        throw new Error('no git');
      },
    };
    const result = await readGitHistory(service as unknown as IHostProcessService, '/repo', 500);
    expect(result.kind).toBe('failed');
  });
});
