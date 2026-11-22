import { createDecorator } from '#/_base/di/instantiation';
import type { LegacyToolAgentContext, LegacyToolFields, LegacyToolPreparation, ToolExecutionHandler, ToolExecutor, ToolExecutorHook } from '#/tool/executor';
import type { AgentTaskFields } from '#/agent/task/handler';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type {
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import type { OrderedHookSlot } from '#/hooks';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ToolResult } from '#/tool/toolContract';
import type { ToolSource } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import type { ToolCall } from '#human/llm/message';

export interface ToolCallStartedPayload {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly display?: ToolInputDisplay;
}

export interface ToolExecutorExecuteOptions {
  readonly signal: AbortSignal;
  readonly steerSignal?: AbortSignal;
  readonly turnId: number;
  readonly trace?: LLMRequestTrace;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
}

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
  readonly durationMs: number;
}

export type MissingToolDescriber = (toolName: string) => string | undefined;
export type UnavailableToolDescriber = (toolName: string) => string | undefined;
export type ToolCallGuard = (tool: {
  readonly name: string;
  readonly source: ToolSource;
}) => string | undefined;

export type ToolCallDupType = 'same_step' | 'cross_step';


export interface AgentToolFields extends LegacyToolFields {
  readonly task?: AgentTaskFields;
}

export type AgentToolHook = ToolExecutorHook<LegacyToolAgentContext, LegacyToolPreparation>;
export type AgentToolExecutionHandler = ToolExecutionHandler<AgentToolFields, LegacyToolPreparation>;
export type AgentToolExecutor = ToolExecutor<LegacyToolAgentContext>;

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult>;

  readonly onBeforeExecuteTool: Event<BeforeToolExecuteEvent>;

  readonly onWillExecuteTool: Event<WillExecuteToolEvent>;

  readonly hooks: {
    readonly onExecuteTool: OrderedHookSlot<ResolvedToolExecutionHookContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;

  registerToolCallGuard(guard: ToolCallGuard): IDisposable;
  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable;
  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable;
  // ---- from upstream 2.7.0 ----
  readonly executor: AgentToolExecutor;
  registerHook(hook: AgentToolHook): IDisposable;
  registerLegacyStarting(listener: (event: BeforeToolExecuteEvent) => void | Promise<void>): IDisposable;
  handlers(): readonly AgentToolExecutionHandler[];
  handler(taskId: string): AgentToolExecutionHandler | undefined;
  handlerForCall(toolCallId: string): AgentToolExecutionHandler | undefined;
  release(taskId: string): void;

}

export const IAgentToolExecutorService = createDecorator<IAgentToolExecutorService>(
  'agentToolExecutorService',
);
