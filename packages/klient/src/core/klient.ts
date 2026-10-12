/**
 * The transport-agnostic klient factory. Every transport entry point
 * (`@moonshot-ai/klient/ipc|memory`) builds a `KlientChannel` and hands
 * it here; the returned `Klient` is identical in shape and behavior no matter
 * which transport carried the bytes.
 */

import { agentEvents, type AgentEventPayloads } from '#/contract/agent/events';
import { globalEvents, type KlientEventPayloads } from '#/contract/global/events';
import { globalContract, isStreamingContract } from '#/contract/index';
import { sessionEvents, type SessionEventPayloads } from '#/contract/session/events';
import type { EventRegistration, StreamingProcedureContract } from '#/contract/types';

import type { KlientChannel, ScopeRef } from './channel.js';
import { EventHub, type KlientEvents } from './events/hub.js';
import { createAgentFacade, type AgentFacade } from './facade/agent.js';
import {
  createGlobalFacade,
  type GlobalFacade,
  type ScopedCaller,
  type ScopedStreamCaller,
} from './facade/global.js';
import { createSessionFacade, type SessionFacade } from './facade/session.js';
import { parseChunk, parseInput, parseOutput } from './validation.js';

export interface KlientOptions {
  /**
   * Validate wire inputs/outputs and event payloads against the contract.
   * Default `true`. Disable only on measured hot paths — validation is cheap
   * (sub-µs for typical payloads) and is the drift tripwire.
   */
  readonly validate?: boolean;
}

export interface SessionHandle extends SessionFacade {
  readonly events: KlientEvents<SessionEventPayloads>;
  agent(agentId: string): AgentHandle;
}

export interface AgentHandle extends AgentFacade {
  readonly events: KlientEvents<AgentEventPayloads>;
}

export interface Klient {
  readonly global: GlobalFacade;
  readonly events: KlientEvents;
  session(sessionId: string): SessionHandle;
  close(): Promise<void>;
  /**
   * Test-only probe: how many event hubs this klient currently tracks. The
   * global hub always counts, and a session/agent hub is added on first
   * subscription — a handle used for calls alone must not move the number.
   */
  __hubCountForTest?(): number;
}

export function createKlientFromChannel(
  channel: KlientChannel,
  options: KlientOptions = {},
): Klient {
  const validate = options.validate ?? true;

  const call: ScopedCaller = async (scope, service, method, args, options) => {
    const procedure = globalContract[service]?.[method];
    if (procedure === undefined) {
      // A facade method without a contract entry is a klient bug, not a wire error.
      throw new Error(`no contract registered for ${service}.${method}`);
    }
    if (isStreamingContract(procedure)) {
      throw new Error(`${service}.${method} is a streaming procedure — use callStream instead`);
    }
    const name = `${service}.${method}`;
    const wireArgs = validate ? parseInput(name, procedure, args) : args;
    const data = await channel.call(scope, service, method, wireArgs, options);
    return validate ? parseOutput(name, procedure, data) : data;
  };

  const callStream: ScopedStreamCaller = (scope, service, method, args, options) => {
    const procedure = globalContract[service]?.[method];
    if (procedure === undefined) {
      throw new Error(`no contract registered for ${service}.${method}`);
    }
    if (!isStreamingContract(procedure)) {
      throw new Error(`${service}.${method} is not a streaming procedure — use call instead`);
    }
    const name = `${service}.${method}`;
    const wireArgs = validate ? parseInput(name, procedure, args) : args;
    // `options.timeoutMs` bounds the iteration when the transport honors it;
    // undefined keeps waiting, as before.
    const source = channel.stream(scope, service, method, wireArgs, options);
    if (!validate) return source;

    // Wrap the iterable to validate each chunk.
    const contract = procedure as StreamingProcedureContract;
    return {
      [Symbol.asyncIterator]() {
        const iter = source[Symbol.asyncIterator]();
        return {
          async next() {
            const result = await iter.next();
            if (result.done) return { done: true as const, value: undefined };
            return { done: false, value: parseChunk(name, contract, result.value) };
          },
          async return(value?: unknown) {
            await iter.return?.(value);
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  };

  const hubs = new Set<{ close(): void }>();
  const makeHub = <TPayloadMap extends object>(
    scope: ScopeRef,
    registrations: Record<string, EventRegistration>,
  ): KlientEvents<TPayloadMap> => {
    const hub = new EventHub<TPayloadMap>(
      channel,
      validate,
      scope,
      registrations,
      () => {
        // A discarded handle's hub has no listeners left — stop pinning it in
        // the Set so the whole EventHub (and any captured scope) can be GC'd.
        // `close` is idempotent and `close()` on an already-idle hub is a no-op,
        // so this cannot interfere with `klient.close()`.
        hubs.delete(hub);
      },
      () => {
        // The caller re-attached listeners to a previously-idle hub — re-track
        // it so a later `klient.close()` still tears down its subscriptions.
        hubs.add(hub);
      },
    );
    hubs.add(hub);
    return hub;
  };
  /**
   * The session/agent hubs are memoized behind the handle's `events` getter,
   * not allocated eagerly: a handle used only for calls (`get()`, `update()`,
   * `setTitle()`) never creates an `EventHub`, so it cannot leak one. Tracking
   * starts on the first subscription, when the hub has a caller-visible
   * lifetime; `close()` on never-subscribed hubs is then unnecessary.
   */
  const lazyHub = <TPayloadMap extends object>(
    scope: ScopeRef,
    registrations: Record<string, EventRegistration>,
  ): (() => KlientEvents<TPayloadMap>) => {
    let hub: KlientEvents<TPayloadMap> | undefined;
    return () => (hub ??= makeHub<TPayloadMap>(scope, registrations));
  };

  return {
    global: createGlobalFacade(call, callStream),
    events: makeHub<KlientEventPayloads>({}, globalEvents),
    session(sessionId: string): SessionHandle {
      const scope: ScopeRef = { sessionId };
      const sessionHub = lazyHub<SessionEventPayloads>(scope, sessionEvents);
      return {
        ...createSessionFacade(call, sessionId),
        get events(): KlientEvents<SessionEventPayloads> {
          return sessionHub();
        },
        agent(agentId: string): AgentHandle {
          const agentScope: ScopeRef = { sessionId, agentId };
          const agentHub = lazyHub<AgentEventPayloads>(agentScope, agentEvents);
          return {
            ...createAgentFacade(call, agentScope),
            get events(): KlientEvents<AgentEventPayloads> {
              return agentHub();
            },
          };
        },
      };
    },
    __hubCountForTest: () => hubs.size,
    close: () => {
      for (const hub of hubs) {
        hub.close();
      }
      hubs.clear();
      return channel.close();
    },
  };
}
