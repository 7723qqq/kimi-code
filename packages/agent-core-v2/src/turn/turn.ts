import { createDecorator } from "#/_base/di";
import type { ContextMessage, PromptOrigin } from '#/contextMemory';
import type { Hooks } from '#/hooks';
import type { ExecutableToolResult } from '#/_base/tools';
import type {
  AuthorizeToolExecutionResult,
  ToolExecutionHookContext,
  ResolvedToolExecutionHookContext,
} from '#/loop';

export interface TurnResult {
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'filtered';
  readonly error?: unknown;
}

export interface Turn {
  readonly id: number;
  readonly abortController: AbortController;
  readonly ready: Promise<void>;
  readonly result: Promise<TurnResult>;
}

export interface TurnStepContext {
  readonly turn: Turn;
  continueTurn: boolean;
}

export interface TurnContextOverflowContext {
  readonly turn: Turn;
  readonly error: unknown;
  handled: boolean;
}

export interface TurnRunContext {
  readonly turn: Turn;
  readonly origin: PromptOrigin;
  readonly promptMessage?: ContextMessage;
  result?: TurnResult;
}

export interface TurnEndedContext {
  readonly turn: Turn;
  readonly result: TurnResult;
}

/**
 * Context for `onWillExecuteTool` — the tool-execution gate that runs after a
 * tool's execution has been resolved but before it starts. Handlers participate
 * in order; any handler may veto by writing `decision` and skipping `next()`.
 */
export interface ToolWillExecuteContext extends ResolvedToolExecutionHookContext {
  decision?: AuthorizeToolExecutionResult;
}

/**
 * Context for `onDidExecuteTool` — runs after a tool finishes. Handlers may
 * rewrite `result` (e.g. append reminders) and may set `stopTurn` to request
 * that the turn stop after this batch.
 */
export interface ToolDidExecuteContext extends ToolExecutionHookContext {
  result: ExecutableToolResult;
  stopTurn?: boolean;
}

export interface ITurnService {
  readonly _serviceBrand: undefined;
  launch(origin: PromptOrigin): Turn;
  getActiveTurn(): Turn | undefined;

  readonly hooks: Hooks<{
    onLaunched: { turn: Turn };
    onEnded: TurnEndedContext;
    beforeStep: TurnStepContext;
    afterStep: TurnStepContext;
    onContextOverflow: TurnContextOverflowContext;
  }>;
}

export const ITurnService = createDecorator<ITurnService>('turnService');
