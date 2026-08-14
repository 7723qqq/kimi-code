import { describe, expect, it } from 'vitest';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CodexBackend } from '#/session/subagent/backend/codexBackend';
import type { IConfigService } from '#/app/config/config';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-codex-server.mjs', import.meta.url));

function spawnFakeServer(env: Record<string, string> = {}): IProcess {
  const child = spawn(process.execPath, [FAKE_SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid ?? 0,
    exitCode: null,
    wait: () => new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
    kill: (signal) => {
      child.kill(signal);
      return Promise.resolve();
    },
    dispose: () => {
      child.kill();
      return Promise.resolve();
    },
  };
}

function makeRunner(env: Record<string, string> = {}): ISessionProcessRunner {
  return {
    _serviceBrand: undefined,
    exec: async (_args, options) => spawnFakeServer({ ...options?.env, ...env }),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => ({ codex: { command: process.execPath, args: [FAKE_SERVER], ...overrides } }),
  } as unknown as IConfigService;
}

describe('CodexBackend', () => {
  it('drives one turn and collects the assistant text', async () => {
    const backend = new CodexBackend(makeRunner(), makeConfig());
    const run = await backend.start({
      prompt: 'do the thing',
      cwd: '/ws',
      signal: new AbortController().signal,
    });
    const result = await run.result;
    expect(result).toEqual({ output: 'hello world', stopReason: 'completed' });
    await run.dispose();
  });

  it('settles as aborted when the request signal aborts', async () => {
    const backend = new CodexBackend(makeRunner({ FAKE_CODEX_SLOW_MS: '500' }), makeConfig());
    const controller = new AbortController();
    const run = await backend.start({ prompt: 'do the thing', cwd: '/ws', signal: controller.signal });
    controller.abort();
    const result = await run.result;
    expect(result.stopReason).toBe('aborted');
    await run.dispose();
  });

  it('rejects when the server process fails to spawn', async () => {
    const backend = new CodexBackend(
      {
        _serviceBrand: undefined,
        exec: async () => {
          throw new Error('spawn failed');
        },
      },
      makeConfig(),
    );
    await expect(
      backend.start({ prompt: 'x', cwd: '/ws', signal: new AbortController().signal }),
    ).rejects.toThrow('spawn failed');
  });
});
