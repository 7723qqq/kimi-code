/**
 * Scenario: the **tool framework** slice — `IAgentToolRegistryService` as a
 * runtime registry.
 *
 * Concept taught: the tools an agent can run are not hard-coded into the agent.
 * They are *registered at runtime* into an Agent-scope `IAgentToolRegistryService`
 * and then discovered through `list()` / `resolve(name)`. The registry is the
 * single source of truth for "which tools exist in this agent", and it is
 * **one-per-Agent-scope**: two sibling agents get independent registries, while
 * repeated lookups inside one agent return the same instance. Registrations are
 * reversible — `register()` hands back an `IDisposable` that unregisters the
 * tool — and observable, through the `onRegistered` / `onUnregistered` hooks.
 *
 * `AgentToolRegistryService` is unusually self-contained for a service: its
 * constructor carries **no** `@IX` dependencies, so the slice needs no
 * `stubPair(...)` collaborators at all. We register a tiny in-file fake tool to
 * prove registration + lookup without pulling in real tool classes.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/tool-framework.example.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';

import {
  AgentToolRegistryService,
  IAgentToolRegistryService,
} from '#/agent/toolRegistry';
import type { ExecutableTool } from '#/agent/tool';

/** Minimal `ExecutableTool` — just enough metadata for the registry to store. */
function fakeTool(name: string): ExecutableTool {
  return {
    name,
    description: `fake ${name} tool`,
    parameters: { type: 'object', properties: {} },
    resolveExecution: () => ({
      approvalRule: 'allow',
      execute: async () => ({ output: `ok:${name}` }),
    }),
  };
}

describe('tool-framework slice (IAgentToolRegistryService runtime registry)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    // The only real service in this slice. It has no constructor dependencies,
    // so no collaborators need to be seeded on the App / Session scopes.
    registerScopedService(
      LifecycleScope.Agent,
      IAgentToolRegistryService,
      AgentToolRegistryService,
    );
  });

  it('lists a registered tool and resolves it by name', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    const registry = agent.accessor.get(IAgentToolRegistryService);
    const echo = fakeTool('Echo');
    const fetch = fakeTool('Fetch');

    registry.register(echo); // source defaults to 'builtin'
    registry.register(fetch, { source: 'mcp' });

    // list() is sorted by name and carries the registration source.
    expect(registry.list()).toEqual([
      {
        name: 'Echo',
        description: 'fake Echo tool',
        parameters: { type: 'object', properties: {} },
        source: 'builtin',
      },
      {
        name: 'Fetch',
        description: 'fake Fetch tool',
        parameters: { type: 'object', properties: {} },
        source: 'mcp',
      },
    ]);

    // resolve() returns the exact registered instance; unknown names miss.
    expect(registry.resolve('Echo')).toBe(echo);
    expect(registry.resolve('Missing')).toBeUndefined();

    host.dispose();
  });

  it('is one-per-Agent-scope: isolated between siblings, singleton within one agent', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agentA = host.childOf(session, LifecycleScope.Agent, 'a');
    const agentB = host.childOf(session, LifecycleScope.Agent, 'b');

    const registryA = agentA.accessor.get(IAgentToolRegistryService);
    registryA.register(fakeTool('Echo'));

    // Same instance on repeated access inside one agent (singleton per scope).
    expect(agentA.accessor.get(IAgentToolRegistryService)).toBe(registryA);

    // A sibling agent gets its own independent registry.
    expect(registryA.list().map((t) => t.name)).toEqual(['Echo']);
    expect(agentB.accessor.get(IAgentToolRegistryService).list()).toEqual([]);

    host.dispose();
  });

  it('unregisters a tool when the registration disposable is disposed', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    const registry = agent.accessor.get(IAgentToolRegistryService);
    const registration = registry.register(fakeTool('Echo'));

    expect(registry.resolve('Echo')).toBeDefined();

    // Disposing the handle returned by register() removes the tool.
    registration.dispose();

    expect(registry.resolve('Echo')).toBeUndefined();
    expect(registry.list()).toEqual([]);

    host.dispose();
  });

  it('fires the onRegistered hook when a tool is registered', async () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    const registry = agent.accessor.get(IAgentToolRegistryService);
    const seen: string[] = [];
    registry.hooks.onRegistered.register('capture', (ctx) => {
      seen.push(ctx.tool.name);
    });

    registry.register(fakeTool('Echo'));
    // register() runs the hook fire-and-forget; flush a microtask to observe it.
    await Promise.resolve();

    expect(seen).toEqual(['Echo']);

    host.dispose();
  });
});
