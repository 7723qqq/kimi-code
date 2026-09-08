/**
 * `kimi acp`
 *
 * Verifies that the ACP sub-command is registered on the program and that
 * the action invokes the native Rust engine binary with `--acp`.
 */

import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRustAgentBinary: vi.fn<() => string | undefined>(() => '/mock/bin/kimi-agent-cli'),
  spawn: vi.fn(),
}));

vi.mock('#/cli/sub/web/rust-server-runner', () => ({
  findRustAgentBinary: mocks.findRustAgentBinary,
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

import { registerAcpCommand } from '#/cli/sub/acp';
import { registerNativeAcpCommand } from '#/cli/sub/acp-native';
import { getDataDir } from '#/utils/paths';

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp (native)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.findRustAgentBinary.mockReturnValue('/mock/bin/kimi-agent-cli');
    mocks.spawn.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerNativeAcpCommand(program);

    const acpV2 = program.commands.find((c) => c.name() === 'acp');
    expect(acpV2).toBeDefined();
    expect(acpV2?.description()).toMatch(/Agent Client Protocol/);
  });

  it('spawns the native Rust binary with --acp and forwards the exit code', async () => {
    const child = new EventEmitter() as EventEmitter & { on: (event: string, cb: (...args: unknown[]) => void) => void };
    mocks.spawn.mockReturnValue(child);

    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    const parsePromise = program.parseAsync(['node', 'kimi', 'acp']);
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/mock/bin/kimi-agent-cli',
      ['--acp', '--data-dir', getDataDir()],
      expect.objectContaining({ stdio: 'inherit' }),
    );

    expect(() => child.emit('exit', 0)).toThrow(ExitCalled);
    await parsePromise;
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits with code 1 when the native Rust binary is not found', async () => {
    mocks.findRustAgentBinary.mockReturnValue(undefined);

    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('acp server: native rust binary (kimi-agent-cli) not found'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits without starting the ACP server when --login is passed', async () => {
    const loginStub = vi.fn(async () => ({ providerName: 'kimi-code' }));
    vi.doMock(import('@moonshot-ai/kimi-code-sdk'), async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createKimiHarnessNative: () =>
          ({
            auth: { login: loginStub },
          }) as unknown as ReturnType<typeof actual.createKimiHarnessNative>,
      };
    });
    vi.resetModules();
    const { registerNativeAcpCommand: freshRegister } = await import('#/cli/sub/acp-native');
    try {
      const program = new Command('kimi').exitOverride();
      freshRegister(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp', '--login'])).rejects.toThrow(
        ExitCalled,
      );

      expect(loginStub).toHaveBeenCalledTimes(1);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.doUnmock('@moonshot-ai/kimi-code-sdk');
      vi.resetModules();
    }
  });
});
