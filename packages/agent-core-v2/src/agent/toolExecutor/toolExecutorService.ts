import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { ContentPart } from '#/app/llmProtocol';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/_base/tools/args-validator';
import { PathSecurityError } from '#/_base/tools/policies/path-access';
import { isUserCancellation } from "#/_base/utils/abort";
import { isAbortError } from '#/agent/loop/errors';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type RunnableToolExecution,
  type ToolDidExecuteContext,
  type ToolExecution,
  type ToolResult,
  type ToolWillExecuteContext,
} from '#/agent/tool';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { ToolCall } from '#/app/llmProtocol';
import { ILogService } from '#/app/log';
import { OrderedHookSlot } from '#/hooks';
import {
  IAgentToolExecutorService,
  type ToolExecutorExecuteOptions,
} from './toolExecutor';
import { ToolScheduler } from './toolScheduler';

const GRACE_TIMEOUT_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

export interface ToolExecutionTask {
  readonly accesses: ToolAccesses;
  readonly execute: (signal: AbortSignal) => Promise<ToolResult>;
}

export class AgentToolExecutorService implements IAgentToolExecutorService {
  declare readonly _serviceBrand: undefined;
  readonly hooks = {
    onWillExecuteTool: new OrderedHookSlot<ToolWillExecuteContext>(),
    onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
  };

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @ILogService private readonly log?: ILogService,
  ) {}

  async execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolResult[]> {
    if (calls.length === 0) return [];

    const preflighted = calls.map((call) => preflightToolCall(this.toolRegistry, call, this.log));
    const preparedTasks: Array<{
      task: ToolExecutionTask;
      call: PreflightedToolCall;
      stopBatchAfterThis?: boolean;
    }> = [];

    let stopBatch = false;
    for (const call of preflighted) {
      if (stopBatch) {
        preparedTasks.push({ task: this.prepareSkippedToolCall(call, options), call });
        continue;
      }

      const prepared = await this.prepareToolCall(call, calls, options);
      preparedTasks.push({
        task: prepared.task,
        call,
        stopBatchAfterThis: prepared.stopBatchAfterThis,
      });
      if (prepared.stopBatchAfterThis === true) {
        stopBatch = true;
      }
    }

    const rawResults = await this.executeBatch(
      preparedTasks.map(({ task }) => task),
      options.signal,
    );

    const results: ToolResult[] = [];
    for (let index = 0; index < preparedTasks.length; index += 1) {
      const { call } = preparedTasks[index]!;
      const rawResult = rawResults[index]!;
      const finalized = await this.finalizeToolResult(call, rawResult, options);
      results.push(finalized);

      await dispatchToolResult(call, finalized, options);
    }

    return results;
  }

  private async prepareToolCall(
    call: PreflightedToolCall,
    allCalls: readonly ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): Promise<{ task: ToolExecutionTask; stopBatchAfterThis?: boolean }> {
    const settleError = (
      args: unknown,
      output: string,
      displayFields?: ToolCallDisplayFields,
    ): { task: ToolExecutionTask } => {
      dispatchToolCall(call, args, options, displayFields);
      return { task: makeResolvedTask(makeErrorToolResult(call, args, output)) };
    };

    const settleSynthetic = (
      args: unknown,
      result: ExecutableToolResult,
      displayFields?: ToolCallDisplayFields,
    ): { task: ToolExecutionTask; stopBatchAfterThis?: boolean } => {
      const toolResult = this.normalizeAndMergeResult(result, call.toolName, undefined);
      dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask({
          toolCall: call.toolCall,
          toolName: call.toolName,
          args,
          result: toolResult,
          stopTurn: toolResult.stopTurn === true,
        }),
        stopBatchAfterThis: toolResult.stopBatchAfterThis ?? toolResult.stopTurn,
      };
    };

    if (call.kind === 'rejected') {
      return settleError(call.args, call.output);
    }

    let execution: ToolExecution;
    try {
      execution = await call.tool.resolveExecution(call.args);
    } catch (error) {
      const output =
        error instanceof PathSecurityError
          ? error.message
          : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
      return settleError(call.args, output);
    }

    const displayFields = toolCallDisplayFieldsFromExecution(execution);

    if (options.signal.aborted) {
      return settleError(
        call.args,
        abortedToolOutput(call.toolName, options.signal),
        displayFields,
      );
    }

    if (execution.isError === true) {
      return settleSynthetic(call.args, execution, displayFields);
    }

    const willCtx = buildWillExecuteContext(call, execution, allCalls, options);
    await this.hooks.onWillExecuteTool.run(willCtx);

    const decision = willCtx.decision;
    if (decision?.block === true) {
      return settleError(
        call.args,
        decision.reason ?? `Tool call "${call.toolName}" was blocked`,
        displayFields,
      );
    }
    if (decision?.syntheticResult !== undefined) {
      return settleSynthetic(call.args, decision.syntheticResult, displayFields);
    }

    const executionMetadata = decision?.executionMetadata;

    dispatchToolCall(call, call.args, options, displayFields);

    return {
      task: {
        accesses: execution.accesses ?? ToolAccesses.all(),
        execute: async (taskSignal) =>
          this.runSingleExecution(call, execution, executionMetadata, options, taskSignal),
      },
      stopBatchAfterThis: execution.stopBatchAfterThis,
    };
  }

  private prepareSkippedToolCall(
    call: PreflightedToolCall,
    options: ToolExecutorExecuteOptions,
  ): ToolExecutionTask {
    const output = 'Tool skipped because a previous tool call stopped the turn.';
    dispatchToolCall(call, call.args, options);
    return makeResolvedTask(makeErrorToolResult(call, call.args, output));
  }

  private async executeBatch(
    tasks: ToolExecutionTask[],
    signal: AbortSignal,
  ): Promise<ToolResult[]> {
    const scheduler = new ToolScheduler<ToolResult>();
    const pendingResults = tasks.map((task) =>
      scheduler.add({
        accesses: task.accesses,
        start: async () => ({ result: task.execute(signal) }),
      }),
    );

    try {
      return await Promise.all(pendingResults);
    } finally {
      await Promise.allSettled(pendingResults);
    }
  }

  private async runSingleExecution(
    call: RunnableToolCall,
    execution: RunnableToolExecution,
    metadata: unknown,
    options: ToolExecutorExecuteOptions,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return makeErrorToolResult(
        call,
        call.args,
        abortedToolOutput(call.toolName, signal),
      ).result;
    }

    let rawResult: ExecutableToolResult;
    try {
      const executePromise = execution.execute({
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        metadata,
        signal,
        onUpdate: (update) => {
          if (signal.aborted) return;
          options.onProgress?.(call.toolCall.id, update);
        },
      });
      rawResult = await raceWithGraceTimeout(executePromise, signal, call.toolName);
    } catch (error) {
      const aborted = isAbortError(error) || signal.aborted;
      const output = aborted
        ? abortedToolOutput(call.toolName, signal)
        : `Tool "${call.toolName}" failed: ${errorMessage(error)}`;
      return makeErrorToolResult(call, call.args, output).result;
    }

    return this.normalizeAndMergeResult(rawResult, call.toolName, execution);
  }

  private normalizeAndMergeResult(
    rawResult: unknown,
    toolName: string,
    execution: RunnableToolExecution | undefined,
  ): ToolResult {
    const coerced = coerceToolResult(rawResult, toolName);
    const normalized = normalizeToolResult(coerced);
    return {
      ...normalized,
      description: execution?.description ?? normalized.description,
      display: execution?.display ?? normalized.display,
      approvalRule: execution?.approvalRule,
      stopBatchAfterThis: normalized.stopBatchAfterThis ?? execution?.stopBatchAfterThis,
    };
  }

  private async finalizeToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolResult> {
    if (call.kind === 'rejected') {
      return result;
    }

    const didCtx: ToolDidExecuteContext = {
      turnId: options.turnId,
      signal: options.signal,
      toolCall: call.toolCall,
      toolCalls: [call.toolCall],
      tool: call.tool,
      args: call.args,
      result: result as ExecutableToolResult,
    };

    try {
      await this.hooks.onDidExecuteTool.run(didCtx);
    } catch (error) {
      const aborted = isAbortError(error) || options.signal.aborted;
      const output = aborted
        ? `Tool "${call.toolName}" aborted during onDidExecuteTool hook.`
        : `onDidExecuteTool hook failed for "${call.toolName}": ${errorMessage(error)}`;
      return {
        output,
        isError: true,
        description: result.description,
        display: result.display,
        approvalRule: result.approvalRule,
      };
    }

    const effectiveResult = coerceToolResult(didCtx.result, call.toolName);
    return {
      ...result,
      stopTurn:
        result.stopTurn === true ||
        didCtx.stopTurn === true ||
        effectiveResult.stopTurn === true,
      stopBatchAfterThis: result.stopBatchAfterThis,
    };
  }
}

interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface PreparedToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ToolResult;
  readonly stopTurn?: boolean;
}

type ToolCallDisplayFields = { description?: string | undefined; display?: ToolInputDisplay | undefined };

function buildWillExecuteContext(
  call: RunnableToolCall,
  execution: RunnableToolExecution,
  allCalls: readonly ToolCall[],
  options: ToolExecutorExecuteOptions,
): ToolWillExecuteContext {
  return {
    turnId: options.turnId,
    signal: options.signal,
    toolCall: call.toolCall,
    toolCalls: allCalls,
    tool: call.tool,
    args: call.args,
    execution,
  };
}

function preflightToolCall(
  toolRegistry: IAgentToolRegistryService,
  toolCall: ToolCall,
  log?: ILogService,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed) {
    log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: typeof toolCall.arguments === 'string' ? toolCall.arguments.length : 0,
      error: parsedArgs.error,
    });
  }
  const tool = toolRegistry.resolve(toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Tool "${toolName}" not found`,
    };
  }
  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

export function parseToolCallArguments(raw: unknown): {
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
} {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.length === 0)) {
    return { data: {}, parseFailed: false };
  }
  if (typeof raw !== 'string') {
    return { data: raw, parseFailed: false };
  }
  try {
    return { data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    return { data: {}, parseFailed: true, error: errorMessage(error) };
  }
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters);
      validators.set(tool, validator);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

function dispatchToolCall(
  call: PreflightedToolCall,
  args: unknown,
  options: ToolExecutorExecuteOptions,
  displayFields?: ToolCallDisplayFields,
): void {
  options.dispatchProtocolEvent?.({
    type: 'tool.call.started',
    turnId: options.turnId,
    toolCallId: call.toolCall.id,
    name: call.toolName,
    args,
    description: displayFields?.description,
    display: displayFields?.display,
  });
}

async function dispatchToolResult(
  call: PreflightedToolCall,
  result: ToolResult,
  options: ToolExecutorExecuteOptions,
): Promise<void> {
  await options.onToolResult?.(call.toolCall.id, result);
  options.dispatchProtocolEvent?.({
    type: 'tool.result',
    turnId: options.turnId,
    toolCallId: call.toolCall.id,
    output: result.output,
    isError: result.isError,
  });
}

function makeResolvedTask(result: PreparedToolResult): ToolExecutionTask {
  return {
    accesses: ToolAccesses.none(),
    execute: async () => result.result,
  };
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PreparedToolResult {
  return makeToolResult(call, args, { output, isError: true });
}

function makeToolResult(
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
): PreparedToolResult {
  const toolResult: ToolResult = {
    output: result.output,
    isError: result.isError,
    stopTurn: result.stopTurn,
  };
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result: toolResult,
    stopTurn: result.stopTurn === true,
  };
}

function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
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
  return value as ExecutableToolResult;
}

function normalizeToolResult(result: ExecutableToolResult): ToolResult {
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
    return { output, isError: true, stopTurn: result.stopTurn };
  }
  return { output, stopTurn: result.stopTurn };
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

async function raceWithGraceTimeout<Result>(
  executePromise: Promise<Result>,
  signal: AbortSignal,
  toolName: string,
): Promise<Result> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<Result> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
        } as unknown as Result);
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Some AbortSignal polyfills do not implement removeEventListener.
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolExecutorService,
  AgentToolExecutorService,
  InstantiationType.Delayed,
  'toolExecutor',
);
