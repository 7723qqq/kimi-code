import { describe, expect, it, vi } from 'vitest';

import { IAgentBackgroundService } from '#/agent/background';
import { TestInstantiationService } from '#/_base/di/test';
import type { IDisposable } from '#/_base/di';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { createExecContext, IExecContext } from '#/session/execContext';
import { ISessionProcessRunner } from '#/session/process';
import { IAgentProfileService } from '#/agent/profile';
import { AgentShellToolsService } from '#/agent/shellTools';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry';

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

const fakeRunner = {} as unknown as ISessionProcessRunner;
const fakeEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: '',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home',
  ready: Promise.resolve(),
};
const fakeCtx: IExecContext = createExecContext('/workspace');
const fakeBackground = {} as unknown as IAgentBackgroundService;
const fakeProfile = {
  isToolActive: () => true,
} as unknown as IAgentProfileService;

describe('AgentShellToolsService', () => {
  it('registers Bash into the tool registry', () => {
    const { registry, names } = fakeToolRegistry();
    const ix = new TestInstantiationService();
    ix.set(ISessionProcessRunner, fakeRunner);
    ix.set(IHostEnvironment, fakeEnv);
    ix.set(IExecContext, fakeCtx);
    ix.set(IAgentBackgroundService, fakeBackground);
    ix.set(IAgentProfileService, fakeProfile);
    new AgentShellToolsService(ix, registry);
    expect(names()).toEqual(['Bash']);
  });
});
