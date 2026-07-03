/**
 * `agentLifecycle` domain (L6) — creates and tracks agents within a session.
 *
 * Defines the public contract of agent lifecycle: the `CreateAgentOptions` and
 * the `IAgentLifecycleService` used to create agents (`create` / `createMain`),
 * clone an existing agent (`clone`), look them up (`getHandle` / `list`), and
 * remove them. Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { TokenUsage } from '#/app/llmProtocol';

export interface CreateAgentOptions {
  readonly agentId?: string;
  /** Agent this one is cloned / derived from (provenance only; not used by business logic). */
  readonly forkedFrom?: string;
  readonly cwd?: string;
  readonly swarmItem?: string;
}

export interface SpawnAgentOptions {
  readonly agentId?: string;
  /** Override the child's cwd. Defaults to the parent's cwd. */
  readonly cwd?: string;
  readonly swarmItem?: string;
}

export interface AgentListFilter {
  readonly prefix?: string;
}

// ── Subagent orchestration types ────────────────────────────────────

export interface SubagentRecordMetadata {
  readonly parentToolCallId?: string;
  readonly description?: string;
  readonly runInBackground?: boolean;
  readonly swarmIndex?: number;
}

export interface RunSubagentOptions {
  readonly callerAgentId: string;
  readonly profileName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly metadata?: SubagentRecordMetadata;
  readonly suppressRateLimitFailureEvent?: boolean;
  readonly onReady?: () => void;
}

export interface ResumeSubagentOptions {
  readonly callerAgentId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly metadata?: SubagentRecordMetadata;
}

export interface SubagentRunHandle {
  readonly agentId: string;
  readonly profileName: string;
  readonly completion: Promise<{ readonly result: string; readonly usage?: TokenUsage }>;
}

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;
  /** Fires after an agent is created and registered, with its scope handle. */
  readonly onDidCreate: Event<IAgentScopeHandle>;
  /** Fires after an agent is removed, with its agent id. */
  readonly onDidDispose: Event<string>;
  create(opts: CreateAgentOptions): Promise<IAgentScopeHandle>;
  createMain(): Promise<IAgentScopeHandle>;
  /** Clone an agent: copy its profile and context history into a new agent. */
  clone(sourceAgentId: string): Promise<IAgentScopeHandle>;
  /**
   * Create a child agent from a parent, copying the parent's profile fields
   * (`cwd` / `modelAlias` / `thinkingLevel` / `systemPrompt` / `activeToolNames`)
   * and recording `forkedFrom = parentAgentId`. Does **not** copy the parent's
   * context memory — the child starts with an empty context. Throws when the
   * parent does not exist.
   *
   * Applying a named profile (system-prompt overlay, tool overrides, prompt
   * prefix, summary policy) is a caller concern: use `applyProfileToAgent(...)`
   * from `session/agentLifecycle` after `spawn` returns.
   */
  spawn(parentAgentId: string, opts?: SpawnAgentOptions): Promise<IAgentScopeHandle>;
  getHandle(agentId: string): IAgentScopeHandle | undefined;
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  remove(agentId: string): Promise<void>;
  /**
   * Spawn a new child agent under a named profile, observe its turn, and
   * return a handle to the running completion. Composes `spawn` →
   * `applyProfileToAgent` → prompt-prefix → record signaling → telemetry →
   * `observeChildAgentTurn`.
   */
  runSubagent(opts: RunSubagentOptions): Promise<SubagentRunHandle>;
  /**
   * Resume an existing child agent with a new prompt, observe its turn, and
   * return a handle to the running completion. Validates the target agent
   * exists, resolves its profile, and delegates to `observeChildAgentTurn`.
   */
  resumeSubagent(opts: ResumeSubagentOptions): Promise<SubagentRunHandle>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');
