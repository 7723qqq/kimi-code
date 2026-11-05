import { mock } from 'bun:test';
import { Readable, type Writable } from 'node:stream';

import { vi } from 'vitest';

import type { IHostProcess } from '#/os/interface/hostProcess';

export function stubHostProcess(stdout: string, exitCode: number, stderr = ''): IHostProcess {
  const stdoutStream = Readable.from([Buffer.from(stdout)]);
  const stderrStream = Readable.from([Buffer.from(stderr)]);
  return {
    _serviceBrand: undefined,
    stdin: { end: mock(), write: mock() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 1,
    exitCode,
    wait: mock().mockResolvedValue(exitCode),
    kill: mock(async () => {}),
    dispose: mock(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

export function stubRgProbe(resolveExitCode: (args: readonly string[]) => number): {
  readonly exec: ReturnType<
    typeof vi.fn<(args: readonly string[]) => Promise<{ readonly exitCode: number }>>
  >;
} {
  return {
    exec: mock(async (args: readonly string[]) => ({ exitCode: resolveExitCode(args) })),
  };
}
