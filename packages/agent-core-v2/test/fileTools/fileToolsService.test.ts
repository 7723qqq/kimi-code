import { describe, expect, it, vi } from 'vitest';

import type { IAgentFileSystem, IFsService } from '#/agentFs';
import { FileToolsService } from '#/fileTools';
import type { IKaos } from '#/kaos';
import type { IDisposable } from '#/_base/di';
import type { IToolRegistry } from '#/toolRegistry';
import type { IWorkspaceContext } from '#/workspaceContext';

function fakeToolRegistry(): { registry: IToolRegistry; names: () => string[] } {
  const tools = new Map<string, unknown>();
  const registry: IToolRegistry = {
    _serviceBrand: undefined,
    register: vi.fn((tool: { name: string }): IDisposable => {
      tools.set(tool.name, tool);
      return { dispose: () => tools.delete(tool.name) };
    }),
    list: () => [...tools.values()] as never,
  } as unknown as IToolRegistry;
  return { registry, names: () => [...tools.keys()].sort() };
}

const fakeFs = { cwd: '/workspace' } as unknown as IAgentFileSystem;
const fakeFsService = {} as unknown as IFsService;
const fakeKaos = {
  cwd: '/workspace',
  pathClass: () => 'posix',
  gethome: () => '/home',
} as unknown as IKaos;
const fakeWorkspace = {
  workDir: '/workspace',
  additionalDirs: [],
} as unknown as IWorkspaceContext;

describe('FileToolsService', () => {
  it('registers Read/Write/Edit/Grep/Glob into the tool registry', () => {
    const { registry, names } = fakeToolRegistry();
    new FileToolsService(registry, fakeFs, fakeKaos, fakeWorkspace, fakeFsService);
    expect(names()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });
});
