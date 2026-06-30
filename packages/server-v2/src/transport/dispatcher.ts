/**
 * `/api/v2` dispatcher — resolves the scope + Service + method from a request
 * and calls it. No facade: Services are reached directly through the scope
 * tree, and the `actionMap` is the only thing binding a public action to an
 * internal Service.
 */

import {
  ErrorCodes,
  IAgentLifecycleService,
  ISessionLifecycleService,
  KimiError,
  type IScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { resolveAction } from './actionMap';
import type { ActionTarget, ScopeKind, ServiceAction } from './channel';
import { assertSerializable } from './errors';
import { MAIN_AGENT_ID, ensureMainAgent } from './mainAgent';

/**
 * Resolve the scope a request targets. Returns `undefined` when the referenced
 * session / agent does not exist (caller maps to `40401`).
 */
export async function resolveScope(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
): Promise<Scope | IScopeHandle | undefined> {
  switch (scopeKind) {
    case 'core':
      return core;
    case 'session': {
      const sessionId = params['session_id'] ?? '';
      return core.accessor.get(ISessionLifecycleService).get(sessionId);
    }
    case 'agent': {
      const sessionId = params['session_id'] ?? '';
      const agentId = params['agent_id'] ?? '';
      const session = core.accessor.get(ISessionLifecycleService).get(sessionId);
      if (session === undefined) return undefined;
      if (agentId === MAIN_AGENT_ID) return ensureMainAgent(session);
      return session.accessor.get(IAgentLifecycleService).getHandle(agentId);
    }
  }
}

/**
 * Dispatch one call. Throws `KimiError` for expected failures (unknown action,
 * scope not found, service not in scope, method missing); the route maps them
 * to the envelope. Unexpected errors propagate and become `50001`.
 */
export async function dispatch(
  core: Scope,
  scopeKind: ScopeKind,
  params: Record<string, string>,
  sa: ServiceAction,
  arg: unknown,
): Promise<unknown> {
  const scope = await resolveScope(core, scopeKind, params);
  if (scope === undefined) {
    throw new KimiError(
      ErrorCodes.SESSION_NOT_FOUND,
      `session ${params['session_id'] ?? ''} not found`,
    );
  }

  const target: ActionTarget | undefined = resolveAction(scopeKind, sa);
  if (target === undefined) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, `unknown action: ${sa.resource}:${sa.action}`);
  }

  let service: unknown;
  try {
    service = scope.accessor.get(target.service);
  } catch {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `service not available in ${scopeKind} scope: ${sa.resource}`,
    );
  }

  const member = (service as Record<string, unknown>)[target.method];
  if (member === undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `method not found: ${sa.resource}:${sa.action}`,
    );
  }

  // Property read (e.g. `mode`, `rules`, `isActive`) — return as-is.
  if (typeof member !== 'function') {
    return assertSerializable(member);
  }

  const args = Array.isArray(arg) ? arg : arg === undefined ? [] : [arg];
  const result = await (member as (...a: unknown[]) => unknown).apply(service, args);
  return assertSerializable(result);
}
