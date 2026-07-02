import { describe, expect, it, vi } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { ISessionAgentFileSystem, ISessionFsService } from '#/session/agentFs';
import { AgentFileToolsService } from '#/agent/fileTools';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ISessionProcessRunner } from '#/session/process';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry';
import type { IDisposable } from '#/_base/di';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

function fakeToolRegistry(): { registry: IAgentToolRegistryService; names: () => string[] } {
  const tools = new Map<string, unknown>();
  const registry: IAgentToolRegistryService = {
    _serviceBrand: undefined,
    register: vi.fn((tool: { name: string }): IDisposable => {
      tools.set(tool.name, tool);
      return { dispose: () => tools.delete(tool.name) };
    }),
    list: () => [...tools.values()] as never,
  } as unknown as IAgentToolRegistryService;
  return { registry, names: () => [...tools.keys()].sort() };
}

const fakeFs = { cwd: '/workspace' } as unknown as ISessionAgentFileSystem;
const fakeFsService = {} as unknown as ISessionFsService;
const fakeEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home',
  ready: Promise.resolve(),
};
const fakeRunner = { _serviceBrand: undefined, exec: vi.fn() } as unknown as ISessionProcessRunner;
const fakeWorkspace = {
  workDir: '/workspace',
  additionalDirs: [],
} as unknown as ISessionWorkspaceContext;

describe('AgentFileToolsService', () => {
  it('registers Read/Write/Edit/Grep/Glob into the tool registry', () => {
    const { registry, names } = fakeToolRegistry();
    const ix = new TestInstantiationService();
    ix.set(ISessionAgentFileSystem, fakeFs);
    ix.set(ISessionFsService, fakeFsService);
    ix.set(IHostEnvironment, fakeEnv);
    ix.set(ISessionProcessRunner, fakeRunner);
    ix.set(ITelemetryService, noopTelemetryService);
    ix.set(ISessionWorkspaceContext, fakeWorkspace);
    new AgentFileToolsService(ix, registry);
    expect(names()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });
});
