import { describe, expect, it } from 'vitest';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LspInstance } from '#/features/lsp/lspInstance';
import { LspStdioProvider } from '#/features/lsp/lspStdioProvider';
import { LspTransportClosedError } from '#/features/lsp/lspConnection';
import type { LspProviderQuery } from '#/features/lsp/lsp';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url));

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

const runner: ISessionProcessRunner = {
  _serviceBrand: undefined,
  exec: async (args, options) => spawnFakeServer(options?.env),
};

const hostFs = {
  readText: async () => 'const x = 1;',
} as unknown as IHostFileSystem;

const SERVER_CONFIG = {
  command: 'node',
  args: [FAKE_SERVER],
  extensionToLanguage: { ts: 'typescript' },
};

const QUERY: LspProviderQuery = {
  operation: 'goToDefinition',
  filePath: '/ws/a.ts',
  position: { line: 0, character: 0 },
  workspaceRoot: '/ws',
  languageId: 'typescript',
};

describe('LspInstance', () => {
  it('handshakes and answers a definition query', async () => {
    const instance = await LspInstance.create(SERVER_CONFIG, runner, hostFs, '/ws');
    const result = await instance.query(QUERY);
    expect(result).toEqual({
      kind: 'locations',
      locations: [
        { uri: 'file:///def.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    await instance.dispose();
  });

  it('answers references, implementation and hover queries', async () => {
    const instance = await LspInstance.create(SERVER_CONFIG, runner, hostFs, '/ws');
    const references = await instance.query({ ...QUERY, operation: 'findReferences' });
    expect(references).toEqual({
      kind: 'locations',
      locations: [
        { uri: 'file:///ref1.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
      ],
    });
    const implementation = await instance.query({ ...QUERY, operation: 'goToImplementation' });
    expect(implementation).toEqual({
      kind: 'locations',
      locations: [
        { uri: 'file:///impl.ts', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
      ],
    });
    const hover = await instance.query({ ...QUERY, operation: 'hover' });
    expect(hover).toEqual({ kind: 'hover', hover: { contents: { kind: 'plaintext', value: 'hover text' } } });
    await instance.dispose();
  });

  it('serializes concurrent queries', async () => {
    const instance = await LspInstance.create(SERVER_CONFIG, runner, hostFs, '/ws');
    const [a, b] = await Promise.all([
      instance.query({ ...QUERY, operation: 'hover' }),
      instance.query({ ...QUERY, operation: 'hover' }),
    ]);
    expect(a).toEqual({ kind: 'hover', hover: { contents: { kind: 'plaintext', value: 'hover text' } } });
    expect(b).toEqual(a);
    await instance.dispose();
  });

  it('dispose terminates the server process', async () => {
    const instance = await LspInstance.create(SERVER_CONFIG, runner, hostFs, '/ws');
    await instance.dispose();
    expect(instance.isClosed).toBe(true);
  });
});

describe('LspStdioProvider', () => {
  it('pools one instance per workspace root', async () => {
    const provider = new LspStdioProvider('typescript', SERVER_CONFIG, runner, hostFs);
    const first = await provider.query(QUERY);
    const second = await provider.query({ ...QUERY, operation: 'hover' });
    expect(first.kind).toBe('locations');
    expect(second.kind).toBe('hover');
    await provider.dispose();
  });

  it('recovers from a crashed server by respawning once', async () => {
    let spawnCount = 0;
    const provider = new LspStdioProvider(
      'typescript',
      { ...SERVER_CONFIG, args: [FAKE_SERVER] },
      {
        _serviceBrand: undefined,
        exec: async (_args, options) => {
          spawnCount += 1;
          return spawnFakeServer(
            spawnCount === 1 ? { ...options?.env, FAKE_LSP_CRASH_AFTER: '1' } : options?.env,
          );
        },
      },
      hostFs,
    );
    const result = await provider.query(QUERY);
    expect(result).toEqual({
      kind: 'locations',
      locations: [
        { uri: 'file:///def.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    expect(spawnCount).toBe(2);
    await provider.dispose();
  });

  it('propagates non-transport errors without retrying', async () => {
    const provider = new LspStdioProvider(
      'typescript',
      SERVER_CONFIG,
      {
        _serviceBrand: undefined,
        exec: async () => {
          throw new Error('spawn failed');
        },
      },
      hostFs,
    );
    await expect(provider.query(QUERY)).rejects.toThrow('spawn failed');
  });

  it('rejects queries after dispose', async () => {
    const provider = new LspStdioProvider('typescript', SERVER_CONFIG, runner, hostFs);
    await provider.dispose();
    await expect(provider.query(QUERY)).rejects.toThrow('disposed');
  });
});
