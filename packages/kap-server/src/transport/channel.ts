/**
 * `/api/v2` channel transport — shared primitives.
 *
 * The transport exposes `agent-core-v2` Services directly (no facade): a URL
 * carries the scope path + a `resource:action` segment, the dispatcher resolves
 * the scope + Service + method, and the result is wrapped in the project
 * envelope. This file holds the small, transport-agnostic pieces shared by the
 * server dispatcher and the client.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2';

/** Which scope a route resolves before dispatching. */
export type ScopeKind = 'core' | 'session' | 'agent';

/**
 * One entry in the action map: the Service to resolve and the method to call.
 * `method` is a string so the map can point at any method without a typed
 * reference; the dispatcher checks it is a function before calling.
 */
export interface ActionTarget {
  readonly service: ServiceIdentifier<unknown>;
  readonly method: string;
  /** Read-only methods are exposed on `GET` as well as `POST`. */
  readonly readonly?: boolean;
}

/** The client-facing channel contract (request/response + future events). */
export interface IChannel {
  call<T>(command: string, arg?: unknown): Promise<T>;
  listen(event: string, arg?: unknown): unknown;
}

/**
 * Parsed `resource:action` segment. `resource` is the public resource name,
 * `action` the method name. Service names never contain a colon, so splitting
 * at the last colon is unambiguous.
 */
export interface ServiceAction {
  readonly resource: string;
  readonly action: string;
}

/**
 * Parse a `resource:action` segment. Returns `undefined` when the segment has
 * no colon, an empty resource, or an empty action.
 */
export function parseServiceAction(sa: string): ServiceAction | undefined {
  const idx = sa.lastIndexOf(':');
  if (idx <= 0 || idx === sa.length - 1) return undefined;
  return { resource: sa.slice(0, idx), action: sa.slice(idx + 1) };
}

/** Build a `resource:action` segment (inverse of {@link parseServiceAction}). */
export function formatServiceAction(resource: string, action: string): string {
  return `${resource}:${action}`;
}
