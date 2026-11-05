import { Readable, type Writable } from 'node:stream';

import { jest } from 'bun:test';

import type { IHostProcess } from '#/os/interface/hostProcess';

export function stubHostProcess(stdout: string, exitCode: number, stderr = ''): IHostProcess {
  const stdoutStream = Readable.from([Buffer.from(stdout)]);
  const stderrStream = Readable.from([Buffer.from(stderr)]);
  return {
    _serviceBrand: undefined,
    stdin: { end: jest.fn(), write: jest.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 1,
    exitCode,
    wait: jest.fn().mockResolvedValue(exitCode),
    kill: jest.fn(async () => {}),
    dispose: jest.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

export function stubRgProbe(resolveExitCode: (args: readonly string[]) => number): {
  readonly exec: ReturnType<
    typeof jest.fn<(args: readonly string[]) => Promise<{ readonly exitCode: number }>>
  >;
} {
  return {
    exec: jest.fn(async (args: readonly string[]) => ({ exitCode: resolveExitCode(args) })),
  };
}
