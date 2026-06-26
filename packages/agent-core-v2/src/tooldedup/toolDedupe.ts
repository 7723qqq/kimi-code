/**
 * `toolDedup` domain (L4) — per-turn tool-call deduplication.
 *
 * Defines the public contract for same-step suppression and cross-step repeat
 * reminders. Agent-scoped — one instance per agent.
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ToolDedupOutput = string | ContentPart[];

export interface ToolDedupSuccessResult {
  readonly output: ToolDedupOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ToolDedupErrorResult {
  readonly output: ToolDedupOutput;
  readonly isError: true;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export type ToolDedupResult = ToolDedupSuccessResult | ToolDedupErrorResult;

export interface IToolDedupe {
  readonly _serviceBrand: undefined;
  readonly currentStreak: number;
  beginStep(): void;
  endStep(): void;
  checkSameStep(toolCallId: string, toolName: string, args: unknown): ToolDedupResult | null;
  finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ToolDedupResult,
  ): Promise<ToolDedupResult>;
}

export const IToolDedupe: ServiceIdentifier<IToolDedupe> =
  createDecorator<IToolDedupe>('toolDedupe');
