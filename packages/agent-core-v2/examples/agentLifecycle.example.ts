/**
 * Scenario: the **agentLifecycle** slice — creating Agent scopes under a
 * Session and the parent/child agent relationship the session tracks.
 *
 * Concept taught: a Session owns a set of Agents. `IAgentLifecycleService`
 * (Session scope) is the factory — every `create(...)` builds a new child
 * **Agent** scope beneath the session, seeds its identity
 * (`IAgentScopeContext.agentId`) plus per-agent services (wire record, blob
 * store, MCP), and registers it in the session's agent set. The session then
 * tracks its agents through `list` / `getHandle` and broadcasts `onDidCreate` /
 * `onDidDispose` as the set changes. Because each Agent scope is a *child* of
 * the Session scope, an agent resolves its own Agent-scope seeds and also
 * inherits Session/App ancestors upward through the scope tree.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator
 * (`ISessionMetadata`, `IAgentMcpService` and its peers, …), so the slice runs
 * for real with no hand-rolled stub list. We spy on `ISessionMetadata` only to
 * observe the `registerAgent` call.
 *
 * Prerequisites: example 01 (container & scope tree), example 13 (file-tools slice).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/agentLifecycle.example.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentScopeContext } from '#/agent/scopeContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import {
  IAgentLifecycleService,
} from '#/session/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

import { createSliceHost, type SliceHost } from './_harness';

describe('agentLifecycle slice (Agent scopes under a Session)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  async function setUp() {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    // The host environment probes the OS asynchronously; the real composition
    // root awaits this before opening a Session scope, so Agent-scope services
    // (which read `osKind`/`pathClass` at construction) see a ready snapshot.
    await host.app.accessor.get(IHostEnvironment).ready;
    return host.session.accessor.get(IAgentLifecycleService);
  }

  it('creates an agent under the session and tracks it in list/getHandle', async () => {
    const lifecycle = await setUp();

    const agent = await lifecycle.create({ agentId: 'main' });

    expect(agent.id).toBe('main');
    expect(lifecycle.getHandle('main')).toBe(agent);
    expect(lifecycle.list().map((h) => h.id)).toEqual(['main']);
  });

  it('tracks multiple agents and assigns distinct ids', async () => {
    const lifecycle = await setUp();

    const a = await lifecycle.create({});
    const b = await lifecycle.create({});

    expect(a.id).not.toBe(b.id);
    expect(lifecycle.list().map((h) => h.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('persists each created agent into the session metadata registry', async () => {
    const lifecycle = await setUp();
    const metadata = host.session.accessor.get(ISessionMetadata);
    const registerAgent = vi.spyOn(metadata, 'registerAgent').mockResolvedValue();

    await lifecycle.create({ agentId: 'child', forkedFrom: 'main', swarmItem: 'swarm-1' });

    expect(registerAgent).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ forkedFrom: 'main', swarmItem: 'swarm-1' }),
    );
  });

  it('fires onDidCreate on create and onDidDispose on remove', async () => {
    const lifecycle = await setUp();

    const created: string[] = [];
    const disposed: string[] = [];
    const subCreate = lifecycle.onDidCreate((h) => created.push(h.id));
    const subDispose = lifecycle.onDidDispose((id) => disposed.push(id));

    const agent = await lifecycle.create({});
    expect(created).toEqual([agent.id]);

    await lifecycle.remove(agent.id);
    expect(disposed).toEqual([agent.id]);
    expect(lifecycle.getHandle(agent.id)).toBeUndefined();

    subCreate.dispose();
    subDispose.dispose();
  });

  it('builds each agent as a child scope that inherits Session ancestors', async () => {
    const lifecycle = await setUp();

    const agent = await lifecycle.create({ agentId: 'main' });

    // Own Agent-scope seed: the identity the lifecycle stamped on creation.
    expect(agent.accessor.get(IAgentScopeContext).agentId).toBe('main');
    // Upward resolution to the Session parent: a Session-scope service the agent
    // never registered itself is still visible through the scope tree.
    expect(agent.accessor.get(ISessionWorkspaceContext).workDir).toBe(process.env['KIMI_CODE_HOME']);
  });
});
