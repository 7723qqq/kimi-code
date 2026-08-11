/**
 * `subagent` domain — persistent-subagent host contract: an agent that stays
 * alive across multiple prompt turns.
 *
 * Mirrors the v1 `SessionSubagentHost` persistent surface — `spawnPersistent`
 * creates a child agent bound to a profile (no prompt run), `runDiscussionTurn`
 * injects one prompt per turn without destroying the child between turns (so
 * its context accumulates the full discussion history), `getPersistentUsage`
 * reads the child's cumulative token usage, and `destroyPersistent` tears the
 * child down. The Session-scoped `IPersistentSubagentService` owns the
 * session's persistent children; `bind(callerAgentId)` returns a
 * `PersistentSubagentHost` view scoped to one caller, keeping the ownership
 * facts of the flat lifecycle registry inside this domain.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface PersistentSubagentSpawnOptions {
  /** Agent profile name, e.g. 'coder' or 'explore'. */
  readonly profileName: string;
  /** Initial prompt — unused by discussion; prompts are injected per turn. */
  readonly prompt: string;
  /** Human-readable description of the subagent's role. */
  readonly description: string;
  /** Tool-call id of the caller's launching tool. */
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
}

/**
 * The per-caller view of the persistent-subagent lifecycle: the v1
 * `SessionSubagentHost` persistent surface, re-expressed for v2.
 */
export interface PersistentSubagentHost {
  spawnPersistent(options: PersistentSubagentSpawnOptions): Promise<string>;
  runDiscussionTurn(agentId: string, prompt: string, signal: AbortSignal): Promise<string>;
  getPersistentUsage(agentId: string): TokenUsage | undefined;
  destroyPersistent(agentId: string): Promise<void>;
}

export interface IPersistentSubagentService {
  readonly _serviceBrand: undefined;

  /** Bind a persistent-subagent host scoped to the given caller agent. */
  bind(callerAgentId: string): PersistentSubagentHost;
}

export const IPersistentSubagentService: ServiceIdentifier<IPersistentSubagentService> =
  createDecorator<IPersistentSubagentService>('persistentSubagentService');
