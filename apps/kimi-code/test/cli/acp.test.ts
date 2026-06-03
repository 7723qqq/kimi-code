/**
 * `kimi acp`
 *
 * Verifies that the ACP sub-command is registered on the program and
 * that the action wires the harness into `@moonshot-ai/acp-adapter`'s
 * `runAcpServer` (the real server is stubbed so the test doesn't
 * actually take over stdio).
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/acp-adapter', () => ({
  runAcpServer: vi.fn(async () => undefined),
}));

import { runAcpServer } from '@moonshot-ai/acp-adapter';

import { registerAcpCommand } from '#/cli/sub/acp';

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runAcpServer).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerAcpCommand(program);

    const acp = program.commands.find((c) => c.name() === 'acp');
    expect(acp).toBeDefined();
    expect(acp?.description()).toMatch(/Agent Client Protocol/);
  });

  it('invokes runAcpServer with a constructed harness and exits 0 on success', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).toHaveBeenCalledTimes(1);
    const harnessArg = vi.mocked(runAcpServer).mock.calls[0]?.[0];
    expect(harnessArg).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
