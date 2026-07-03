/**
 * Public contracts for the stateless agent loop.
 *
 * This file defines the narrow surfaces that connect a Kosong conversation to
 * tool execution, phase hooks, and turn results. Host-layer metadata, policy,
 * archival limits, and UI concerns stay outside these contracts.
 */

import type { TurnEndReason } from '@moonshot-ai/protocol';
import type { Message } from '#/app/llmProtocol';

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export interface TurnResult {
  readonly reason: TurnEndReason;
  readonly error?: unknown;
  readonly steps?: number;
}
