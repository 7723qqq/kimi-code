import type { ContentPart } from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from '../../../di';
import type {
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../loop/types';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '../../../tools/args-validator';
import type { Tool, ToolCall, ToolResult } from '../types';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { IToolExecutor, type ToolExecutorOptions } from './toolExecutor';

const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const validators = new WeakMap<Tool, ToolArgsValidator>();
const NEVER_ABORTS = new AbortController().signal;

export class ToolExecutorService implements IToolExecutor {
  constructor(@IToolRegistry private readonly tools: IToolRegistry) {}

  async execute(call: ToolCall, options: ToolExecutorOptions = {}): Promise<ToolResult> {
    const tool = this.tools.resolve(call.name);
    if (tool === undefined) {
      return {
        output: `Tool "${call.name}" not found`,
        isError: true,
      };
    }

    const args = canonicalizeToolArgs(call);
    if (!args.success) {
      return {
        output: `Invalid args for tool "${call.name}": ${args.error}`,
        isError: true,
      };
    }

    const validationError = validateServiceToolArgs(tool, args.data);
    if (validationError !== null) {
      return {
        output: `Invalid args for tool "${call.name}": ${validationError}`,
        isError: true,
      };
    }

    if (isAborted(options.signal)) {
      return abortedToolResult(call.name);
    }

    try {
      if (tool.resolveExecution !== undefined) {
        return await this.executeResolvedTool(tool, call, args.data, options);
      }
      if (tool.execute !== undefined) {
        const result = await tool.execute(call, {
          call,
          args: args.data,
          turnId: options.turnId ?? '',
          toolCallId: call.id,
          metadata: options.metadata,
          signal: options.signal ?? NEVER_ABORTS,
          onUpdate: options.onUpdate,
        });
        return normalizeToolResult(coerceToolResult(result, call.name));
      }
      return {
        output: `Tool "${call.name}" has no executor.`,
        isError: true,
      };
    } catch (error) {
      if (isAborted(options.signal)) {
        return abortedToolResult(call.name);
      }
      return {
        output: `Tool "${call.name}" failed: ${errorMessage(error)}`,
        isError: true,
      };
    }
  }

  private async executeResolvedTool(
    tool: Tool,
    call: ToolCall,
    args: unknown,
    options: ToolExecutorOptions,
  ): Promise<ToolResult> {
    let execution: ToolExecution;
    try {
      execution = await tool.resolveExecution!(args);
    } catch (error) {
      return {
        output: `Tool "${call.name}" failed to resolve execution: ${errorMessage(error)}`,
        isError: true,
      };
    }

    if (execution.isError === true) {
      return normalizeToolResult(coerceToolResult(execution, call.name));
    }

    const runnable = execution as RunnableToolExecution;
    const result = await runnable.execute({
      turnId: options.turnId ?? '',
      toolCallId: call.id,
      metadata: options.metadata,
      signal: options.signal ?? NEVER_ABORTS,
      onUpdate: options.onUpdate,
    });
    const normalized = normalizeToolResult(coerceToolResult(result, call.name));
    return {
      ...normalized,
      description: runnable.description ?? normalized.description,
      display: runnable.display ?? normalized.display,
      approvalRule: runnable.approvalRule,
      stopBatchAfterThis:
        runnable.stopBatchAfterThis ?? normalized.stopBatchAfterThis,
    };
  }
}

function canonicalizeToolArgs(
  call: ToolCall,
):
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string } {
  const raw = call.raw?.arguments ?? call.arguments;
  if (raw === null || raw === undefined || raw === '') {
    return { success: true, data: {} };
  }
  if (typeof raw !== 'string') {
    return { success: true, data: raw };
  }
  try {
    return { success: true, data: JSON.parse(raw) as unknown };
  } catch (error) {
    return { success: false, error: `malformed JSON in arguments: ${errorMessage(error)}` };
  }
}

function validateServiceToolArgs(tool: Tool, args: unknown): string | null {
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters ?? EMPTY_TOOL_PARAMETERS);
      validators.set(tool, validator);
    } catch (error) {
      return errorMessage(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

function coerceToolResult(value: unknown, toolName: string): ToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  const result = value as ToolResult | ExecutableToolResult;
  return { ...result, output: result.output };
}

function normalizeToolResult(result: ToolResult): ToolResult {
  let output: ToolResult['output'];
  if (typeof result.output === 'string') {
    output = result.output.length > 0 ? result.output : TOOL_OUTPUT_EMPTY;
  } else if (result.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = result.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = result.output.some(
        (part) => part.type === 'text' && part.text.length > 0,
      );
      output = hasNonEmptyText
        ? result.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...result.output];
    } else {
      const textJoined = result.output
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  if (result.isError === true) {
    return { ...result, output, isError: true };
  }
  const { isError: _isError, ...success } = result;
  return { ...success, output };
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function abortedToolResult(toolName: string): ToolResult {
  return {
    output: `Tool "${toolName}" was aborted`,
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

registerSingleton(IToolExecutor, new SyncDescriptor(ToolExecutorService, [], true));
