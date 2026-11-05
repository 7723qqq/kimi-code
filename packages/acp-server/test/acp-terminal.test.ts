import { describe, expect, it } from 'bun:test';

import type {
  HostProcessOptions,
  IHostEnvironment,
  IHostProcess,
  IHostProcessService,
  Environment,
  EnvironmentProviderHost,
} from '@moonshot-ai/agent-core-v2';

import type { IAcpConnection, IAcpTerminalHandle } from '../src/acp-fs/acpConnection';
import { AcpHostFileSystem } from '../src/acp-fs/acpFsService';
import { AcpEnvironmentProviderFactory } from '../src/acp-terminal/acpTerminalRunner';

function makeConnection(
  options: { terminalEnabled?: boolean; createTerminal?: () => IAcpTerminalHandle } = {},
): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: true,
    fsWriteTextFile: true,
    terminalEnabled: options.terminalEnabled ?? true,
    bind: () => {},
    get: () => ({ createTerminal: async () => options.createTerminal?.() }) as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
}

interface LocalSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: HostProcessOptions | undefined;
}

function makeLocalProcessService(): { local: IHostProcessService; calls: LocalSpawnCall[] } {
  const calls: LocalSpawnCall[] = [];
  const local: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args = [], options) => {
      calls.push({ command, args, options });
      return {} as IHostProcess;
    },
  };
  return { local, calls };
}

function makeEnvironment(overrides: Partial<IHostEnvironment> = {}): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '24.0.0',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/Users/test',
    ready: Promise.resolve(),
    ...overrides,
  } as IHostEnvironment;
}

async function bindEnvironment(
  environment: IHostEnvironment,
  options: { connection?: IAcpConnection; local?: IHostProcessService } = {},
): Promise<Environment> {
  const environments: Environment[] = [];
  const host = {
    registerEnvironment: (environment: Environment) => {
      environments.push(environment);
      return { remove: async () => {} };
    },
  } as unknown as EnvironmentProviderHost;
  const factory = new AcpEnvironmentProviderFactory(
    options.connection ?? makeConnection(),
    environment,
    options.local ?? makeLocalProcessService().local,
    options.timers,
  );
  await factory.attach(host);
  factory.bindSession('s1', '/repo');
  const backend = environments[0];
  if (backend === undefined) throw new Error('environment was not registered');
  return backend;
}

describe('AcpSessionEnvironment', () => {
  it('mirrors the probed host environment and exposes fs + process capabilities', async () => {
    const environment = await bindEnvironment(makeEnvironment());

    expect([...environment.capabilities].toSorted()).toEqual(['fs', 'process']);
    expect(environment.host).toMatchObject({
      osKind: 'macOS',
      osArch: 'arm64',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/Users/test',
    });
    expect(environment.fs).toBeInstanceOf(AcpHostFileSystem);
    const { path } = environment;
    if (path === undefined) throw new Error('ready environment must expose path');
    expect(path.isAbsolute('/repo')).toBe(true);
  });

  it('adapts path semantics and shell to a win32 host environment', async () => {
    const environment = await bindEnvironment(
      makeEnvironment({
        osKind: 'Windows',
        osArch: 'x64',
        shellName: 'bash',
        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        pathClass: 'win32',
        homeDir: 'C:\\Users\\test',
      }),
    );

    expect(environment.host).toMatchObject({
      osKind: 'Windows',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      pathClass: 'win32',
      homeDir: 'C:\\Users\\test',
    });
    const { path } = environment;
    if (path === undefined) throw new Error('ready environment must expose path');
    expect(path.separator).toBe('\\');
    expect(path.isAbsolute('C:\\repo')).toBe(true);
    expect(path.isAbsolute('repo')).toBe(false);
    expect(path.resolve('C:\\repo', 'src')).toBe('C:\\repo\\src');
  });
});

describe('AcpProcessService local fallback', () => {
  const bashEnv = { NO_COLOR: '1', TERM: 'dumb' };

  function makeTerminalHandle(): IAcpTerminalHandle {
    return {
      id: 'term-1',
      currentOutput: async () => ({ output: '', truncated: false }),
      waitForExit: async () => ({ exitCode: 0 }),
      kill: async () => ({}),
      release: async () => ({}),
    };
  }

  it('runs Bash-shaped spawns in the client terminal when the capability is advertised', async () => {
    let created = 0;
    const connection = makeConnection({
      terminalEnabled: true,
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    });
    const { local, calls } = makeLocalProcessService();
    const environment = await bindEnvironment(makeEnvironment(), { connection, local });

    await environment.process!.spawn('/bin/bash', ['-c', 'echo hi'], { env: { ...bashEnv } });

    expect(created).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('falls back to local execution for Bash-shaped spawns without the terminal capability', async () => {
    const connection = makeConnection({ terminalEnabled: false });
    const { local, calls } = makeLocalProcessService();
    const environment = await bindEnvironment(makeEnvironment(), { connection, local });

    await environment.process!.spawn('/bin/bash', ['-c', 'echo hi'], { env: { ...bashEnv } });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/bin/bash',
      args: ['-c', 'echo hi'],
      options: { env: bashEnv, cwd: '/repo' },
    });
  });

  it('falls back to local execution for non-Bash spawns even with the terminal capability', async () => {
    let created = 0;
    const connection = makeConnection({
      terminalEnabled: true,
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    });
    const { local, calls } = makeLocalProcessService();
    const environment = await bindEnvironment(makeEnvironment(), { connection, local });

    await environment.process!.spawn('rg', ['--files', '--hidden']);

    expect(created).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'rg',
      args: ['--files', '--hidden'],
      options: { cwd: '/repo' },
    });
  });
});

describe('AcpTerminalProcess truncated output', () => {
  const FOUR_MIB = 4 * 1024 * 1024;
  const NOTICE = '\n[terminal] output truncated at 4 MiB; earlier bytes are not recoverable\n';
  const bashEnv = { NO_COLOR: '1', TERM: 'dumb' };

  /** A handle replaying one frame per `currentOutput()` call (last frame repeats). */
  function makeSequenceHandle(
    frames: ReadonlyArray<{ output: string; truncated: boolean }>,
  ): IAcpTerminalHandle {
    let index = 0;
    return {
      id: 'term-rolling',
      currentOutput: async () => frames[Math.min(index++, frames.length - 1)]!,
      waitForExit: () => new Promise<never>(() => {}),
      kill: async () => ({}),
      release: async () => ({}),
    };
  }

  it('marks a truncated window once and rebases the delta instead of re-emitting it', async () => {
    const { timers, advance } = createFakeTimers();
    const head = 'start-';
    const tail = 'TAIL-after-truncation-31-bytes!';
    expect(tail).toHaveLength(31);
    // Frame 1: a normal prefix. Frame 2: the client's buffer hit its own
    // 4 MiB limit and flagged it. Frame 3: the buffer rolled in place —
    // same length, entirely different (shifted) content. Frame 4: growth
    // resumes on the rolled-over window.
    const handle = makeSequenceHandle([
      { output: head, truncated: false },
      { output: 'a'.repeat(FOUR_MIB), truncated: true },
      { output: 'b'.repeat(FOUR_MIB), truncated: false },
      { output: `${'b'.repeat(FOUR_MIB)}${tail}`, truncated: false },
    ]);
    const connection = makeConnection({ terminalEnabled: true, createTerminal: () => handle });
    const runtime = await bindRuntime(makeEnvironment(), { connection, timers });

    const proc = await runtime.process!.spawn('/bin/bash', ['-c', 'echo hi'], {
      env: bashEnv,
    });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    // One pump per poll tick.
    for (let tick = 0; tick < 5; tick += 1) await advance(250);

    const stdout = Buffer.concat(chunks).toString('utf8');
    // The rolled-over 4 MiB window is never re-emitted wholesale (under the
    // old length-only comparison it arrived in full, shifted by the prefix
    // already written).
    expect(stdout).not.toContain('a'.repeat(1024));
    // Exactly one marker, and the post-rebase delta follows it.
    expect(stdout.split(NOTICE)).toHaveLength(2);
    expect(stdout).toBe(`${head}${NOTICE}${tail}`);
  });
});
