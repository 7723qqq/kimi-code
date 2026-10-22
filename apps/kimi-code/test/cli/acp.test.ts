/**
 * `kimi acp`
 *
 * Verifies that the ACP sub-command is registered on the program and that
 * the action wires `@moonshot-ai/acp-server`'s `runAcpServer` (the real server
 * is stubbed so the test doesn't actually take over stdio). The module is
 * loaded via a lazy dynamic import in the action, so the mock intercepts that
 * import.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { restoreEnvs } from '#test/helpers/stubs';

import * as sdkModule from '@moonshot-ai/kimi-code-sdk';

void mock.module('@moonshot-ai/acp-server', () => ({
  runAcpServer: mock(async () => undefined),
}));

import { runAcpServer } from '@moonshot-ai/acp-server';

import { registerAcpCommand } from '#/cli/sub/acp';
import { getDataDir } from '#/utils/paths';

// `mock.module` swaps the implementation at runtime, but the imported binding
// keeps its real signature, so the assertions below need the mock surface.
const runAcpServerMock = runAcpServer as unknown as Mock<typeof runAcpServer>;

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    runAcpServerMock.mockClear();
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    restoreEnvs();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerAcpCommand(program);

    const acp = program.commands.find((c) => c.name() === 'acp');
    expect(acp).toBeDefined();
    expect(acp?.description()).toMatch(/Agent Client Protocol/);
  });

  it('invokes runAcpServer with the host options and exits 0 on success', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServerMock).toHaveBeenCalledTimes(1);
    const optsArg = runAcpServerMock.mock.calls[0]?.[0];
    expect(optsArg).toEqual(
      expect.objectContaining({
        homeDir: getDataDir(),
        agentInfo: { name: 'Kimi Code CLI', version: expect.any(String) },
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('forwards KIMI_CODE_HOME to terminalAuthEnv and homeDir when set', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-debug';
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = runAcpServerMock.mock.calls[0]?.[0];
      expect(optsArg).toEqual(
        expect.objectContaining({
          homeDir: '/tmp/kimi-debug',
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('omits terminalAuthEnv when KIMI_CODE_HOME is unset', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    delete process.env['KIMI_CODE_HOME'];
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = runAcpServerMock.mock.calls[0]?.[0] as {
        terminalAuthEnv?: unknown;
      };
      expect(optsArg.terminalAuthEnv).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('advertises process.execPath on a native install and argv[1] on a script install', async () => {
    const detectSpy = spyOn(
      await import('#/cli/update/source'),
      'detectNativeInstall',
    );

    detectSpy.mockReturnValue({ native: true, kind: 'bun' });
    const nativeProgram = new Command('kimi').exitOverride();
    registerAcpCommand(nativeProgram);
    await expect(nativeProgram.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);
    const nativeOpts = runAcpServerMock.mock.calls[0]?.[0] as {
      terminalAuthLegacyCommand?: string;
    };
    // A single-file build's argv[1] is a /$bunfs virtual path that no client
    // can spawn; execPath is the real binary.
    expect(nativeOpts.terminalAuthLegacyCommand).toBe(process.execPath);

    runAcpServerMock.mockClear();
    detectSpy.mockReturnValue({ native: false });
    const scriptProgram = new Command('kimi').exitOverride();
    registerAcpCommand(scriptProgram);
    await expect(scriptProgram.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);
    const scriptOpts = runAcpServerMock.mock.calls[0]?.[0] as {
      terminalAuthLegacyCommand?: string;
    };
    // A global script install's bin IS the script, so pointing at execPath
    // would advertise node/bun itself.
    expect(scriptOpts.terminalAuthLegacyCommand).toBe(process.argv[1]);
    detectSpy.mockRestore();
  });

  it('exits without starting the ACP server when --login is passed', async () => {
    // Stub the SDK harness so runLoginFlow doesn't hit a real OAuth endpoint:
    // harness.auth.login resolves immediately and triggers exit 0.
    const loginStub = mock(async () => ({ providerName: 'kimi-code' }));
    void mock.module('@moonshot-ai/kimi-code-sdk', () => ({
      ...sdkModule,
      // The login flow boots the v2-backed SDK harness (`createKimiHarness`).
      createKimiHarness: () =>
        ({
          auth: { login: loginStub },
        }) as unknown as ReturnType<typeof sdkModule.createKimiHarness>,
    }));
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp', '--login'])).rejects.toThrow(
        ExitCalled,
      );

      expect(loginStub).toHaveBeenCalledTimes(1);
      expect(runAcpServerMock).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      mock.restore();
    }
  });
});
