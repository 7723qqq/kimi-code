/**
 * Public contracts for the stateless agent loop.
 *
 * This file defines the narrow surfaces that connect a Kosong conversation to
 * tool execution, phase hooks, and turn results. Host-layer metadata, policy,
 * archival limits, and UI concerns stay outside these contracts.
 *
 * Field naming is camelCase unless a reused Kosong type says otherwise.
 * Optional fields use `?: T | undefined` intentionally under
 * `exactOptionalPropertyTypes: true`.
 */

import type { Message, TokenUsage } from '@moonshot-ai/kosong';

import type { LLM } from './llm';

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

/**
 * Stop reason for one completed model step.
 *
 * `tool_use` is a loop-control signal: the loop executes the requested tools and
 * continues with another step. The other values are terminal for the current
 * turn unless a host hook explicitly asks the loop to continue.
 */
export type LoopStepStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'filtered'
  | 'paused'
  | 'unknown';

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, 'tool_use'>;

/**
 * Stop reasons that can be returned in a normal `TurnResult`.
 *
 * `tool_use` is intentionally absent because it cannot be the final result of a
 * completed turn. Errors and max-step exhaustion are represented by thrown
 * errors, not by this union. Compaction is a host-level retry concern rather
 * than a stop reason.
 */
export type LoopTurnStopReason = LoopTerminalStepStopReason | 'aborted';

/**
 * @deprecated Legacy umbrella union. Use `LoopStepStopReason` for per-step
 * model responses and `LoopTurnStopReason` for `TurnResult`.
 */
export type StopReason = LoopStepStopReason | 'aborted';

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
  usage: TokenUsage;
}

/**
 * Step hooks are aligned to recorded phase boundaries: `beforeStep` runs before
 * `step.begin`, while `afterStep` runs after `step.end`.
 */

export interface LoopStepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly llm: LLM;
}

export interface LoopAfterStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}

export interface LoopStoppedStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopTerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface AfterStepResult {
  readonly stopTurn?: boolean | undefined;
}

export interface RecordStepUsageResult {
  /**
   * Internal loop-control hint. Hosts can return this after recording usage
   * when the completed model step has reached a hard runtime limit.
   */
  readonly stopTurn?: boolean | undefined;
}

export interface RecordStepUsageContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly stepUuid: string;
  readonly toolCallCount: number;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

export type BeforeStepHook = (ctx: LoopStepHookContext) => Promise<BeforeStepResult | undefined>;

export type AfterStepHook = (ctx: LoopAfterStepContext) => Promise<AfterStepResult | void>;

export type ShouldContinueAfterStopHook = (
  ctx: LoopStoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;

/**
 * Groups every awaited phase hook forwarded from the turn layer.
 *
 * Tool-execution gates (`onWillExecuteTool` / `onDidExecuteTool`) are owned by
 * `IAgentToolExecutorService` and run by it at the right transcript points.
 * `shouldContinueAfterStop` is loop-local convergence control.
 */
export interface LoopHooks {
  beforeStep?: BeforeStepHook | undefined;
  afterStep?: AfterStepHook | undefined;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook | undefined;
}
