/**
 * `tool` domain (L3) — foundational tool model contract.
 *
 * Owns the tool model shared by every tool domain: the static metadata
 * (`ToolSource` / `ToolDefinition` / `ToolInfo`), the `ExecutableTool`
 * contract every tool implements (`resolveExecution` → `ToolExecution` →
 * `execute(ctx)`), the `ExecutableToolContext` it runs against, the raw and
 * finalized results (`ExecutableToolResult` / `ToolResult`), the streaming
 * `ToolUpdate`, and the `BuiltinTool` alias. The `stopTurn` /
 * `stopBatchAfterThis` fields are internal loop-control hints stripped before
 * persistence. Pure contract (types only); resource-access declarations live
 * in `tool-access`, execution hook contexts in `toolHooks`. No scoped service.
 */

import type { ContentPart, Tool } from '#/app/llmProtocol';
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
  readonly turnId: number;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
  readonly onForegroundTaskStart?: ((taskId: string) => void) | undefined;
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

export type ToolSource = 'builtin' | 'user' | 'mcp';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly source?: ToolSource;
  readonly info?: Record<string, unknown>;
}

export interface ToolInfo extends ToolDefinition {
  readonly source: ToolSource;
}

export type BuiltinTool<Input = unknown> = ExecutableTool<Input>;

export interface ToolResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: boolean;
  readonly message?: string;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
  readonly approvalRule?: string;
  readonly stopTurn?: boolean;
  readonly stopBatchAfterThis?: boolean;
}
