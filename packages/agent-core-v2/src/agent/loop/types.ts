/**
 * Public contracts for the stateless agent loop.
 *
 * This file defines the narrow surfaces that connect a Kosong conversation to
 * tool execution, phase hooks, and turn results. Host-layer metadata, policy,
 * archival limits, and UI concerns stay outside these contracts.
 */

import type { FinishReason, Message } from '#/app/llmProtocol';

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

/**
 * Stop reasons that can be returned in a normal `TurnResult`.
 *
 * Step stop reasons reuse the provider-normalized `FinishReason` vocabulary
 * directly. `tool_calls` is intentionally absent here because it is a
 * loop-control signal (execute tools, run another step) and cannot be the
 * final result of a completed turn. Errors and max-step exhaustion are
 * represented by thrown errors, not by this union.
 */
export type LoopTurnStopReason = Exclude<FinishReason, 'tool_calls'> | 'aborted';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
}
