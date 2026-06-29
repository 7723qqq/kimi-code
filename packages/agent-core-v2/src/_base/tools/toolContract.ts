/**
 * `_base/tools` support module — foundational `ExecutableTool` contract.
 *
 * Defines the `resolveExecution` → `ToolExecution` → `execute(ctx)` contract
 * every tool implements, the `ExecutableToolContext` it runs against, the
 * `ExecutableToolResult` it returns, and the streaming `ToolUpdate`. The
 * `stopTurn` / `stopBatchAfterThis` fields are internal loop-control hints
 * stripped before persistence. Resource-access declarations live in
 * `tool-access`.
 */

import type { ContentPart, Tool } from '@moonshot-ai/kosong';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import type { ToolAccesses } from './tool-access';

export type ExecutableToolOutput = string | ContentPart[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  readonly message?: string | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly truncated?: boolean | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  customKind?: string | undefined;
  customData?: unknown;
}

export interface ExecutableToolContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  readonly stopBatchAfterThis?: boolean | undefined;
  readonly approvalRule: string;
  readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool<Input = unknown> extends Tool {
  resolveExecution(input: Input): ToolExecution | Promise<ToolExecution>;
}
