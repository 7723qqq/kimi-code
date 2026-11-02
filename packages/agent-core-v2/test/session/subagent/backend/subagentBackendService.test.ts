import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { setLocale } from '@moonshot-ai/kimi-i18n';

import type { IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { transformTomlData } from '#/app/config/toml';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import { acpStopReason } from '#/session/subagent/backend/acpBackend';
import { backendIncompatibility } from '#/session/subagent/backend/backendCompat';
import {
  SUBAGENT_BACKEND_SECTION,
  stripSubagentBackendParameter,
} from '#/session/subagent/backend/configSection';
import type { SubagentBackendName } from '#/session/subagent/backend/subagentBackend';
import { SubagentBackendService } from '#/session/subagent/backend/subagentBackendService';
import { SANDBOX_SECTION } from '#/workspace/sandbox/sandbox';

import { StubConfigService } from '#test/stubs';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-codex-server.mjs', import.meta.url));

function spawnFakeServer(): IProcess {
  const child = spawn(process.execPath, [FAKE_SERVER], {
    env: { ...process.env },
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

function runnerSpawningFakeServer(exec = mock(async () => spawnFakeServer())): {
  readonly runner: ISessionProcessRunner;
  readonly exec: typeof exec;
} {
  return {
    runner: { _serviceBrand: undefined, exec } as unknown as ISessionProcessRunner,
    exec,
  };
}

function configWith(sections: Record<string, unknown>): IConfigService {
  return new StubConfigService(sections);
}

describe('acpStopReason', () => {
  it('maps ACP stop reasons to backend stop reasons', () => {
    expect(acpStopReason('end_turn')).toBe('completed');
    expect(acpStopReason('max_tokens')).toBe('max-tokens');
    expect(acpStopReason('refusal')).toBe('refusal');
    expect(acpStopReason('cancelled')).toBe('aborted');
    expect(acpStopReason('max_turn_requests')).toBe('error');
  });
});

describe('SubagentBackendService', () => {
  it('registers the three external backends and serves lookups by name', () => {
    const service = new SubagentBackendService(
      {} as ISessionProcessRunner,
      { get: () => undefined } as unknown as IConfigService,
    );
    expect(
      service
        .list()
        .map((backend) => backend.name)
        .toSorted(),
    ).toEqual(['acp', 'claude-code', 'codex']);
    expect(service.getBackend('codex')?.name).toBe('codex');
    expect(service.getBackend('claude-code')?.name).toBe('claude-code');
    expect(service.getBackend('acp')?.name).toBe('acp');
  });
});

describe('SubagentBackendService.start', () => {
  beforeAll(() => {
    setLocale('en');
  });

  it('dispatches to the named backend when no sandbox mode is configured', async () => {
    const { runner } = runnerSpawningFakeServer();
    const service = new SubagentBackendService(
      runner,
      configWith({
        [SUBAGENT_BACKEND_SECTION]: { codex: { command: process.execPath, args: [FAKE_SERVER] } },
      }),
    );

    const run = await service.start('codex', {
      prompt: 'do the thing',
      cwd: '/ws',
      signal: new AbortController().signal,
    });

    expect(await run.result).toEqual({ output: 'hello world', stopReason: 'completed' });
    await run.dispose();
  });

  it('rejects an unknown backend name before touching any backend', async () => {
    const { runner, exec } = runnerSpawningFakeServer();
    const service = new SubagentBackendService(runner, configWith({}));

    await expect(
      service.start('mystery' as SubagentBackendName, {
        prompt: 'x',
        cwd: '/ws',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      'Unknown subagent backend "mystery". Available backends: claude-code, codex, acp.',
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['read-only', 'workspace-write'] as const)(
    'refuses to dispatch an external backend while sandbox mode is %s',
    async (mode) => {
      const { runner, exec } = runnerSpawningFakeServer();
      const service = new SubagentBackendService(
        runner,
        configWith({
          [SANDBOX_SECTION]: { mode },
          [SUBAGENT_BACKEND_SECTION]: { codex: { command: process.execPath } },
        }),
      );

      await expect(
        service.start('codex', {
          prompt: 'x',
          cwd: '/ws',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(`Sandbox mode "${mode}" blocks external subagent backends`);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

describe('subagentBackend config section', () => {
  it('registers the subagentBackend section with an empty default', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(SUBAGENT_BACKEND_SECTION);
    expect(section).toBeDefined();
    expect(section?.defaultValue).toEqual({});
  });

  it('validates backend entries and rejects malformed values', () => {
    const registry = new ConfigRegistry();

    const valid = {
      claudeCode: { command: 'claude', model: 'sonnet' },
      codex: { command: 'codex' },
      acp: { command: 'acp-server', args: ['--stdio'], env: { ACP_KEY: 'x' } },
    };
    expect(registry.validate(SUBAGENT_BACKEND_SECTION, valid)).toEqual(valid);
    expect(registry.validate(SUBAGENT_BACKEND_SECTION, {})).toEqual({});
    expect(() => registry.validate(SUBAGENT_BACKEND_SECTION, { acp: {} })).toThrow();
    expect(() =>
      registry.validate(SUBAGENT_BACKEND_SECTION, { claudeCode: { command: 7 } }),
    ).toThrow();
  });

  it('round-trips [subagent_backend] from TOML with snake_case keys', () => {
    const registry = new ConfigRegistry();
    const transformed = transformTomlData(
      { subagent_backend: { claude_code: { command: 'claude' } } },
      registry,
    );

    expect(transformed[SUBAGENT_BACKEND_SECTION]).toEqual({ claudeCode: { command: 'claude' } });
  });
});

describe('backendIncompatibility', () => {
  it('accepts a plain backend request', () => {
    expect(backendIncompatibility({ backend: 'codex' })).toBeUndefined();
  });

  it('ignores requests without a backend', () => {
    expect(backendIncompatibility({})).toBeUndefined();
    expect(backendIncompatibility({ backend: '', resume: 'agent-1' })).toBeUndefined();
  });

  it('rejects each in-process-only parameter', () => {
    expect(backendIncompatibility({ backend: 'codex', resume: 'agent-1' })).toContain(
      'Cannot use backend with resume',
    );
    expect(backendIncompatibility({ backend: 'codex', subagent_type: 'explore' })).toContain(
      'Cannot use backend with subagent_type',
    );
    expect(backendIncompatibility({ backend: 'codex', model: 'provider/fast' })).toContain(
      'Cannot use backend with model',
    );
    expect(backendIncompatibility({ backend: 'codex', fork: true })).toContain(
      'Cannot use backend with fork',
    );
  });

  it('rejects run_in_background with a backend', () => {
    expect(backendIncompatibility({ backend: 'codex', run_in_background: true })).toContain(
      'Cannot use backend with run_in_background',
    );
  });
});

describe('stripSubagentBackendParameter', () => {
  it('removes the backend property and required entry while keeping the rest', () => {
    const parameters = {
      type: 'object',
      properties: { prompt: { type: 'string' }, backend: { type: 'string' } },
      required: ['prompt', 'backend'],
    };

    const stripped = stripSubagentBackendParameter(parameters);

    expect(stripped['properties']).toEqual({ prompt: { type: 'string' } });
    expect(stripped['required']).toEqual(['prompt']);
    expect(parameters['properties']).toHaveProperty('backend');
  });

  it('returns the parameters untouched when backend is absent', () => {
    const parameters = { type: 'object', properties: { prompt: { type: 'string' } } };

    expect(stripSubagentBackendParameter(parameters)).toBe(parameters);
  });
});
