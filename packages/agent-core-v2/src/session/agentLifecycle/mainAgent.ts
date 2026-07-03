/**
 * `agentLifecycle` domain (L6) — main-agent bootstrap helper.
 *
 * The main agent is an ordinary agent whose only distinction is
 * `agentId === 'main'`; `IAgentLifecycleService` itself knows nothing about
 * it. What *is* main-specific is session bootstrap business: the plugin
 * session-start injector registers its turn-cadence injection on the main
 * agent only (matching v1's `pluginSessionStarts: type === 'main' ? … :
 * undefined`). `ensureMainAgent` concentrates that business in one place so
 * every bootstrapper (session resume, legacy session/message services, the
 * server edge) creates the main agent the same way.
 *
 * Not a Service: a pure composition helper over the session handle.
 */

import type { ISessionScopeHandle, IAgentScopeHandle } from '#/_base/di/scope';
import { IPluginSessionStartInjectorService } from '#/agent/contextInjector';
import type { BindAgentInput } from '#/agent/profile';

import { IAgentLifecycleService } from './agentLifecycle';

export const MAIN_AGENT_ID = 'main';

export interface EnsureMainAgentOptions {
  /** Profile + Model to bind at creation. Omit for an edge-bound main agent. */
  readonly binding?: BindAgentInput;
}

/**
 * Return the session's main agent, creating it (with its session-start
 * bootstrap wiring) when it does not exist yet.
 */
export async function ensureMainAgent(
  session: ISessionScopeHandle,
  opts?: EnsureMainAgentOptions,
): Promise<IAgentScopeHandle> {
  const agents = session.accessor.get(IAgentLifecycleService);
  const existing = agents.getHandle(MAIN_AGENT_ID);
  if (existing !== undefined) return existing;
  const main = await agents.create({ agentId: MAIN_AGENT_ID, binding: opts?.binding });
  // Force-instantiate the plugin session-start injector so it registers its
  // turn-cadence injection before the first turn. Main-agent-only business.
  main.accessor.get(IPluginSessionStartInjectorService);
  // Notify main-only capabilities (e.g. the cron tool registrar) that the main
  // agent is ready, so they bind to it without filtering every `onDidCreate`.
  agents.notifyMainCreated(main);
  return main;
}
