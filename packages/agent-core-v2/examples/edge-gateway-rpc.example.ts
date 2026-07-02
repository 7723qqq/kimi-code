/**
 * Scenario: the **edge-gateway-rpc** slice — the edge-exposure layer where the
 * agent's `resource:action` RPC surface meets the REST/WS transport edge.
 *
 * Concept taught: the agent is not reached directly. `IAgentRPCService`
 * (Agent scope) is the typed `resource:action` RPC surface — one method per
 * action (`prompt`, `registerTool`, `getTools`, …) — that edge transports call
 * into. The `gateway` domain (App scope) is the transport edge itself:
 * `IRestGateway` drives request/response actions, while the WS side owns the
 * streaming connections. The WS fan-out is backed by a process-wide event
 * sink, `IEventService` (App scope) — a minimal type-tagged pub/sub bus that
 * the edge package subscribes to and republishes over sockets. So the data
 * path is: transport (gateway) → RPC action (agent) → domain fact → event
 * sink (`IEventService`) → WS connections.
 *
 * We keep this example read-only and deterministic: no sockets are opened and
 * no servers listen. We only resolve the real services and exercise safe,
 * synchronous-ish methods — `registerTool` / `getTools` on the RPC, a
 * session-status probe on the REST gateway, and a `publish` / `subscribe`
 * round-trip on the event sink.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator
 * (the tool registry, the session lifecycle the gateway resolves through, the
 * record log, …) so the slice runs for real with no hand-rolled stub list. We
 * spy on `IAgentRecordService.append` only to observe the
 * `tools.register_user_tool` record the RPC writes when an action is
 * registered.
 *
 * Note on the WS gateway: the App-scope `IWSGateway` binding in this package
 * still carries an Agent-scope `IAgentRecordService` dependency that the real
 * composition root does not satisfy at App scope, so it is intentionally not
 * instantiated here (WS sequencing / journaling / replay is completed in the
 * edge `server` package on top of `IEventService` + `IAgentRecordService`).
 * We therefore exercise the WS *backing* — the `IEventService` event sink —
 * directly, which is the part this package owns and wires for real.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/edge-gateway-rpc.example.ts
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentRecordService } from '#/agent/record';
import { IAgentRPCService } from '#/agent/rpc';
import { type DomainEvent, IEventService } from '#/app/event';
import { IRestGateway } from '#/app/gateway';

import { createSliceHost, type SliceHost } from './_harness';

describe('edge-gateway-rpc slice (resource:action RPC over the gateway/event edge)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function newHomeDir(): string {
    const root = process.env['KIMI_CODE_HOME'];
    if (root === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    // Per-test isolated home so this example never writes into the shared
    // run-wide home (which other examples share) — keeps the slice hermetic.
    const dir = join(root, randomUUID());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function setUp() {
    host = createSliceHost({ homeDir: newHomeDir() });
    return {
      rpc: host.agent.accessor.get(IAgentRPCService),
      rest: host.app.accessor.get(IRestGateway),
      events: host.app.accessor.get(IEventService),
    };
  }

  it('resolves the edge services and exposes the resource:action transport surface', async () => {
    const { rpc, rest, events } = setUp();

    // The agent RPC surface exposes typed `resource:action` methods the edge
    // calls into — tool actions here are the clearest example.
    expect(typeof rpc.registerTool).toBe('function');
    expect(typeof rpc.getTools).toBe('function');
    expect(typeof rpc.prompt).toBe('function');

    // The App-scope REST gateway is the request/response transport edge.
    expect(typeof rest.prompt).toBe('function');
    expect(typeof rest.getStatus).toBe('function');

    // The WS fan-out is backed by the App-scope event sink.
    expect(typeof events.publish).toBe('function');
    expect(typeof events.subscribe).toBe('function');
    expect(typeof events.onDidPublish).toBe('function');

    // The REST gateway resolves sessions through the session lifecycle; an
    // unknown session reports status `false` rather than throwing. This is a
    // safe, read-only probe — no socket, no session created.
    expect(await rest.getStatus('does-not-exist')).toBe(false);
  });

  it('registers an action (tool) through the RPC and lists it back', async () => {
    host = createSliceHost({ homeDir: newHomeDir() });

    // Instrument the real record service first; the RPC's user-tool registrar
    // is constructed against the same singleton and writes a
    // `tools.register_user_tool` record when an action is registered.
    const records = host.agent.accessor.get(IAgentRecordService);
    const appended: Array<{ type: string; name?: string }> = [];
    vi.spyOn(records, 'append').mockImplementation((r) => {
      appended.push(r as { type: string; name?: string });
    });

    const rpc = host.agent.accessor.get(IAgentRPCService);

    const before = await rpc.getTools({});
    expect(before.some((tool) => tool.name === 'echo-example')).toBe(false);

    rpc.registerTool({
      name: 'echo-example',
      description: 'Echoes its input — example edge action.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    });

    // The action is now part of the agent's RPC-listed tool set, sourced as a
    // user-registered tool and auto-activated by the profile.
    const after = await rpc.getTools({});
    const registered = after.find((tool) => tool.name === 'echo-example');
    expect(registered).toMatchObject({
      name: 'echo-example',
      description: 'Echoes its input — example edge action.',
      source: 'user',
      active: true,
    });

    // Registering the action is itself a recorded domain fact.
    expect(appended).toContainEqual(
      expect.objectContaining({ type: 'tools.register_user_tool', name: 'echo-example' }),
    );

    // Unregistering removes the action from the listed set (and records the
    // unregister fact), leaving the agent the way we found it.
    rpc.unregisterTool({ name: 'echo-example' });
    const final = await rpc.getTools({});
    expect(final.some((tool) => tool.name === 'echo-example')).toBe(false);
    expect(appended).toContainEqual(
      expect.objectContaining({ type: 'tools.unregister_user_tool', name: 'echo-example' }),
    );
  });

  it('streams a domain event over the event sink that backs the WS fan-out', () => {
    const { events } = setUp();

    const viaSubscribe: DomainEvent[] = [];
    const viaOnDidPublish: DomainEvent[] = [];
    const subA = events.subscribe((event) => viaSubscribe.push(event));
    const subB = events.onDidPublish((event) => viaOnDidPublish.push(event));

    const domainEvent: DomainEvent = {
      type: 'session.edgeExample',
      payload: { sessionId: 's1', kind: 'demo' },
    };
    events.publish(domainEvent);

    // Both subscription paths on the real bus receive the published fact —
    // this is the event the edge package would republish over the WS
    // connections tracked by the gateway.
    expect(viaSubscribe).toEqual([domainEvent]);
    expect(viaOnDidPublish).toEqual([domainEvent]);

    subA.dispose();
    subB.dispose();

    // After disposal the sink no longer delivers to the removed handlers.
    events.publish({ type: 'session.edgeExample.afterDispose', payload: null });
    expect(viaSubscribe).toHaveLength(1);
    expect(viaOnDidPublish).toHaveLength(1);
  });
});
