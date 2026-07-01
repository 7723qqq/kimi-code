import type { ISessionAgentFileSystem } from '#/session/agentFs';
import type { ISessionProcessRunner } from '#/session/process';

function notImplemented(name: string): never {
  throw new Error(`${name} not implemented - override it in the test`);
}

export function createFakeProcessRunner(
  overrides: Partial<ISessionProcessRunner> = {},
): ISessionProcessRunner {
  return {
    _serviceBrand: undefined,
    exec: () => notImplemented('FakeProcessRunner.exec'),
    ...overrides,
  };
}

export function createFakeAgentFs(
  overrides: Partial<ISessionAgentFileSystem> = {},
): ISessionAgentFileSystem {
  const cwd = overrides.cwd ?? '/workspace';
  const fs: ISessionAgentFileSystem = {
    _serviceBrand: undefined,
    cwd,
    readText: () => notImplemented('FakeAgentFs.readText'),
    writeText: () => notImplemented('FakeAgentFs.writeText'),
    readBytes: () => notImplemented('FakeAgentFs.readBytes'),
    readLines: () => notImplemented('FakeAgentFs.readLines'),
    writeBytes: () => notImplemented('FakeAgentFs.writeBytes'),
    stat: () => notImplemented('FakeAgentFs.stat'),
    readdir: () => notImplemented('FakeAgentFs.readdir'),
    glob: () => notImplemented('FakeAgentFs.glob'),
    mkdir: () => notImplemented('FakeAgentFs.mkdir'),
    withCwd: (nextCwd) => createFakeAgentFs({ ...overrides, cwd: nextCwd }),
  };
  return { ...fs, ...overrides };
}
