/**
 * `LegacyStatus` — kap-server-layer derived model that re-derives the v1-style
 * combined `agent.status.updated` payload from the agent's native v2 services.
 *
 * v1 emits a single `agent.status.updated` carrying usage + contextTokens +
 * maxContextTokens + model together. v2 splits those into independent Models /
 * Ops (`usage.record`, `context_size.measured`, `config.update` …), so the
 * partial events reach clients separately and a usage-only event can overwrite
 * a previously-known contextTokens with a stale zero. This derived model
 * watches the status-affecting Ops and, on each, re-reads the authoritative
 * services and emits a fresh combined event so the edge always has a real,
 * consistent context-window value to forward.
 *
 * Temporary bridge while the v2 wire contract still exposes the slices
 * separately — defined at the kap-server edge rather than in agent-core-v2 so
 * the core engine stays free of v1 wire-compatibility concerns.
 */

import {
  IAgentProfileService,
  IAgentUsageService,
  IAgentWireService,
  defineDerivedModel,
  type IAgentScopeHandle,
  type UsageStatus,
} from '@moonshot-ai/agent-core-v2';
import { ContextSizeModel } from '@moonshot-ai/agent-core-v2';

interface LegacyStatusState {
  /** Monotonic change counter — only used to fan change notifications out. */
  readonly version: number;
}

/**
 * Reacts to the Ops that can change the status line. The state itself carries
 * no business data; the handler re-reads the authoritative services on every
 * bump so the emitted snapshot is always consistent with the live Models.
 */
export const LegacyStatusModel = defineDerivedModel<LegacyStatusState>(
  'legacyStatus',
  () => ({ version: 0 }),
  {
    'usage.record': (s) => ({ version: s.version + 1 }),
    'context_size.measured': (s) => ({ version: s.version + 1 }),
    'config.update': (s) => ({ version: s.version + 1 }),
  },
);

export interface LegacyStatusSnapshot {
  readonly usage?: UsageStatus;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly model: string;
}

/** Read the current combined status from the agent's authoritative services. */
export function readLegacyStatus(agent: IAgentScopeHandle): LegacyStatusSnapshot {
  const profile = agent.accessor.get(IAgentProfileService);
  const usage = agent.accessor.get(IAgentUsageService).status();
  const contextTokens = agent.accessor.get(IAgentWireService).getModel(ContextSizeModel).tokens;
  const maxContextTokens = profile.getModelCapabilities().max_context_tokens;
  const model = profile.getModel();
  return { usage, contextTokens, maxContextTokens, model };
}
