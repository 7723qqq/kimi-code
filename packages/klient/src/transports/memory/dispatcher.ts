/**
 * In-process dispatcher — resolves a wire triple `(service, method, args)`
 * against a live engine scope and mirrors kap-server's dispatcher semantics
 * (reflection call, non-function members are property reads, `main` agent
 * auto-materialized via `ensureMainAgent`). Scope routing walks
 * `IWorkspaceLifecycleService` / `IAgentLifecycleService` exactly like the
 * server's `resolveScope`. Every argument, result, and event payload passes
 * through `wireClone` (a JSON round-trip), so consumers observe
 * byte-identical data no matter whether the call crossed a socket or stayed
 * in-process — and non-serializable leaks fail early.
 *
 * Shared by the memory transport and the IPC host, which guarantees ipc and
 * memory behave identically by construction. The IPC host opts out of the
 * clone (`clone: false`): its `encodeFrame` already JSON-serializes every
 * frame, so the extra round-trip per chunk would be pure waste — the wire
 * guarantees the clone provides are already enforced at the codec boundary.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { IWorkspaceLifecycleService } from '@moonshot-ai/agent-core-v2/app/workspaceLifecycle/workspaceLifecycle';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/workspaceLifecycle/sessionLookup';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/mainAgent';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { IEventService, serviceTokens } from './serviceRegistry.js';

/** Structural minimum of an engine `Scope` / `IScopeHandle`. */
export interface ScopeLike {
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
}

/** JSON round-trip so in-process data matches wire data exactly. */
export function wireClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface MemoryDispatcherOptions {
  /**
   * When `false`, skip the JSON round-trip (`wireClone`) on every value.
   * The IPC host uses this — its codec already serializes each frame, so the
   * clone would only double the per-chunk cost of large streaming payloads.
   * Defaults to `true` (memory transport keeps the isolation semantics).
   */
  readonly clone?: boolean;
}

export interface MemoryDispatcher {
  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown>;
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable;
}

const REQUEST_INVALID = 40001;
const NOT_FOUND = 40404;

type ScopeKind = 'core' | 'workspace' | 'session' | 'agent';

interface ResolvedScope {
  readonly kind: ScopeKind;
  readonly like: ScopeLike;
}

export function createMemoryDispatcher(
  root: ScopeLike,
  options?: MemoryDispatcherOptions,
): MemoryDispatcher {
  const clone = <T>(value: T): T => (options?.clone === false ? value : wireClone(value));
  /** Mirrors kap-server's `resolveScope`, incl. main-agent materialization. */
  async function resolveScope(scope: ScopeRef): Promise<ResolvedScope> {
    if (scope.workspaceId !== undefined) {
      const handler = await root.accessor
        .get(IWorkspaceLifecycleService)
        .handlerFor({ workspaceId: scope.workspaceId });
      return { kind: 'workspace', like: handler };
    }
    if (scope.sessionId === undefined) return { kind: 'core', like: root };
    const session = getLiveSessionById(root.accessor, scope.sessionId);
    if (session === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
    }
    if (scope.agentId === undefined) return { kind: 'session', like: session };
    if (scope.agentId === 'main') {
      return { kind: 'agent', like: await ensureMainAgent(session) };
    }
    const agent = session.accessor.get(IAgentLifecycleService).get(scope.agentId);
    if (agent === undefined) {
      throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
    }
    return { kind: 'agent', like: agent };
  }

  function resolveService(resolved: ResolvedScope, service: string): Record<string, unknown> {
    const token = serviceTokens[service];
    if (token === undefined) {
      throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
    }
    return resolved.like.accessor.get(token) as Record<string, unknown>;
  }

  /** Mirrors kap-server's WS `eventMap` per scope kind. */
  function subscribeStream(
    resolved: ResolvedScope,
    name: string,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (resolved.kind === 'core' && name === 'events') {
      const bus = resolved.like.accessor.get(IEventService);
      return bus.subscribe((event) => {
        handler(clone(event));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions') {
      const interaction = resolved.like.accessor.get(ISessionInteractionService);
      return interaction.onDidChangePending(() => {
        handler(clone(interaction.listPending()));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions:resolved') {
      const interaction = resolved.like.accessor.get(ISessionInteractionService);
      return interaction.onDidResolve((resolution) => {
        handler(clone(resolution));
      });
    }
    if (resolved.kind === 'agent' && name === 'events') {
      const bus = resolved.like.accessor.get(IEventBus);
      return bus.subscribe((event) => {
        handler(clone(event));
      });
    }
    throw new RPCError(REQUEST_INVALID, `unknown event stream: ${name} (${resolved.kind})`);
  }

  function subscribeSource(
    resolved: ResolvedScope,
    source: EventSourceRef,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (source.kind === 'stream') {
      return subscribeStream(resolved, source.name, handler);
    }
    if (!/^on[A-Z]/.test(source.event)) {
      throw new RPCError(REQUEST_INVALID, `not an event property: ${source.event}`);
    }
    const instance = resolveService(resolved, source.service);
    const emitter = instance[source.event];
    if (typeof emitter !== 'function') {
      throw new RPCError(REQUEST_INVALID, `event not found: ${source.service}.${source.event}`);
    }
    return (emitter as (listener: (data: unknown) => void) => IDisposable).call(
      instance,
      (data) => {
        handler(clone(data));
      },
    );
  }

  return {
    async call(scope, service, method, args) {
      const resolved = await resolveScope(scope);
      const instance = resolveService(resolved, service);
      const member = instance[method];
      if (member === undefined) {
        throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
      }
      if (typeof member !== 'function') {
        return clone(member);
      }
      const clonedArgs = args.map(clone);
      const result = await (member as (...a: unknown[]) => unknown).apply(instance, clonedArgs);
      return clone(result);
    },

    stream(scope, service, method, args): AsyncIterable<unknown> {
      // Special case: modelResolver.generate routes to
      // getRequester(modelId).request(input, signal, params) because the
      // catalog has no `generate` method — the facade synthesises the call.
      if (service === 'modelResolver' && method === 'generate') {
        return {
          [Symbol.asyncIterator]() {
            let source: AsyncIterator<unknown> | undefined;
            let started: Promise<void> | undefined;
            const controller = new AbortController();

            const ensureStarted = (): Promise<void> => {
              started ??= (async () => {
                const resolved = await resolveScope(scope);
                const catalog = resolveService(resolved, 'modelResolver');
                const [modelId, input, params] = args;
                const requester = (catalog as { getRequester(id: string): { request(...a: unknown[]): AsyncIterable<unknown> } })
                  .getRequester(modelId as string);
                const iterable = requester.request(
                  clone(input),
                  controller.signal,
                  clone(params),
                );
                source = iterable[Symbol.asyncIterator]();
              })();
              return started;
            };

            return {
              async next() {
                await ensureStarted();
                const result = await source!.next();
                if (result.done) return { done: true, value: undefined };
                return { done: false, value: clone(result.value) };
              },
              async return(value?: unknown) {
                controller.abort();
                await source?.return?.(value);
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      }

      // The underlying service method returns an AsyncIterable; we wire-clone
      // each yielded chunk so in-process consumers observe the same data as
      // networked ones.
      return {
        [Symbol.asyncIterator]() {
          let source: AsyncIterator<unknown> | undefined;
          let started: Promise<void> | undefined;

          const ensureStarted = (): Promise<void> => {
            started ??= (async () => {
              const resolved = await resolveScope(scope);
              const instance = resolveService(resolved, service);
              const member = instance[method];
              if (member === undefined) {
                throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
              }
              if (typeof member !== 'function') {
                throw new RPCError(REQUEST_INVALID, `not a streaming method: ${service}.${method}`);
              }
              const clonedArgs = args.map(clone);
              const iterable = (member as (...a: unknown[]) => unknown).apply(
                instance,
                clonedArgs,
              ) as AsyncIterable<unknown>;
              source = iterable[Symbol.asyncIterator]();
            })();
            return started;
          };

          return {
            async next() {
              await ensureStarted();
              const result = await source!.next();
              if (result.done) return { done: true, value: undefined };
              return { done: false, value: clone(result.value) };
            },
            async return(value?: unknown) {
              await source?.return?.(value);
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },

    listen(scope, source, handler, onError) {
      // Scope resolution can be async (main-agent materialization); the
      // subscription attaches once settled. Disposing early cancels it.
      let inner: IDisposable | undefined;
      let disposed = false;
      void resolveScope(scope).then(
        (resolved) => {
          if (disposed) return;
          try {
            inner = subscribeSource(resolved, source, handler);
          } catch (error) {
            onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        },
        (error: unknown) => {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        },
      );
      return {
        dispose: () => {
          disposed = true;
          inner?.dispose();
        },
      };
    },
  };
}
