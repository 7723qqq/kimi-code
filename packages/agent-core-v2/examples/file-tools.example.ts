/**
 * Example 13 — the `fileTools` slice across all three scope tiers.
 *
 * Concept taught: a real feature is a *vertical slice*. Each built-in tool is
 * a DI class (constructor injects its dependencies with `@IX`) that
 * self-registers via `registerTool(ReadTool)` at module load. The Agent-scope
 * `IAgentToolRegistryService` consumes every module-level contribution when it
 * is constructed and stores the resulting tool instances in the per-agent
 * runtime table. The tool ctors themselves inject Session-scope peers
 * (`ISessionAgentFileSystem`, `ISessionFsService`,
 * `ISessionWorkspaceContext`) and App-scope peers (`IHostEnvironment`,
 * `ITelemetryService`) — the same "short-lived injects long-lived" rule made
 * concrete.
 *
 * We stub the leaf dependencies with minimal fakes instead of constructing
 * their real implementations, so the example needs no kaos and stays focused
 * on the wiring.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/file-tools.example.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

// Side-effect import: each tool file calls `registerTool(SomeTool)` at module
// load; the barrel re-exports them so this one import is enough to add
// Read/Write/Edit/Grep/Glob to the contribution list.
import '#/agent/fileTools';
import {
  IAgentBuiltinToolsRegistrar,
  IAgentToolRegistryService,
} from '#/agent/toolRegistry';

import { IHostEnvironment } from '#/app/hostEnvironment';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry';
import {
  ISessionAgentFileSystem,
  ISessionFsService,
} from '#/session/agentFs';
import { ISessionProcessRunner } from '#/session/process';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

// Minimal leaf fakes. The real tool constructors only read these surfaces
// during construction.
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
const fakeFs = { cwd: '/workspace' } as unknown as ISessionAgentFileSystem;
const fakeFsService = {} as unknown as ISessionFsService;
const fakeRunner = {
  _serviceBrand: undefined,
  exec: vi.fn(),
} as unknown as ISessionProcessRunner;
const fakeWorkspace = {
  workDir: '/workspace',
  additionalDirs: [],
} as unknown as ISessionWorkspaceContext;

describe('example 13 — file-tools slice (App + Session + Agent)', () => {
  it('registers the five built-in file tools through the scope tree', () => {
    const host = createScopedTestHost([
      stubPair(IHostEnvironment, fakeEnv),
      stubPair(ITelemetryService, noopTelemetryService),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionAgentFileSystem, fakeFs),
      stubPair(ISessionFsService, fakeFsService),
      stubPair(ISessionProcessRunner, fakeRunner),
      stubPair(ISessionWorkspaceContext, fakeWorkspace),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    // Force-instantiate the Eager builtin-tools registrar: its constructor
    // consumes every registered tool contribution and builds each tool
    // instance against this Agent scope.
    agent.accessor.get(IAgentBuiltinToolsRegistrar);
    const tools = agent.accessor.get(IAgentToolRegistryService).list();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Edit', 'Glob', 'Grep', 'Read', 'Write']));

    host.dispose();
  });

  it('resolves the same Agent-scope registry on repeated access (singleton per scope)', () => {
    const host = createScopedTestHost([
      stubPair(IHostEnvironment, fakeEnv),
      stubPair(ITelemetryService, noopTelemetryService),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionAgentFileSystem, fakeFs),
      stubPair(ISessionFsService, fakeFsService),
      stubPair(ISessionProcessRunner, fakeRunner),
      stubPair(ISessionWorkspaceContext, fakeWorkspace),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    const a = agent.accessor.get(IAgentToolRegistryService);
    const b = agent.accessor.get(IAgentToolRegistryService);
    expect(a).toBe(b);

    host.dispose();
  });
});
