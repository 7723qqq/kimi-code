import { createDecorator, type IDisposable } from "#/_base/di";
import type { ExecutableTool, ExecutableToolContext } from '#/tool';
import type {
  ContentPart,
  ToolCall as KosongToolCall
} from '@moonshot-ai/kosong';

import type { Hooks } from '../hooks';
import type { ToolInputDisplay } from "@moonshot-ai/protocol";

export type BuiltinTool<Input = unknown> = ExecutableTool<Input>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly source?: ToolSource;
  readonly info?: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly raw?: KosongToolCall;
}

export type ToolOutput = string | ContentPart[];

export interface ToolResult {
  readonly output: ToolOutput;
  readonly isError?: boolean;
  readonly message?: string;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
  readonly approvalRule?: string;
  readonly stopTurn?: boolean;
  readonly stopBatchAfterThis?: boolean;
}

export interface ToolExecutionContext extends ExecutableToolContext {
  readonly call: ToolCall;
  readonly args: unknown;
}

export interface ToolInfo extends ToolDefinition {
  readonly source: ToolSource;
}


export type ToolSource = 'builtin' | 'user' | 'mcp';


export interface ToolRegistrationOptions {
  readonly source?: ToolSource;
}

export interface IToolRegistry {
  register(tool: ExecutableTool, options?: ToolRegistrationOptions): IDisposable;
  list(): readonly ToolInfo[];
  resolve(name: string): ExecutableTool | undefined;

  readonly hooks: Hooks<{
    onRegistered: { tool: ExecutableTool };
    onUnregistered: { tool: ExecutableTool };
  }>;
}

export const IToolRegistry = createDecorator<IToolRegistry>('agentToolRegistryService');
