import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { KimiError, isKimiError, type KimiErrorOptions } from '#/_base/errors/errors';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { Hooks } from '#/hooks';
import { LoopErrors } from './errors';
import type { StepRequest } from './stepRequest';

export type LoopErrorCode = (typeof LoopErrors.codes)[keyof typeof LoopErrors.codes];

export class LoopError extends KimiError {
  constructor(code: LoopErrorCode, message: string, options?: KimiErrorOptions) {
    super(code, message, options);
    this.name = 'LoopError';
  }
}

export function createMaxStepsExceededError(maxSteps: number, message?: string): LoopError {
  return new LoopError(
    LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED,
    message ??
      `Turn exceeded maxSteps=${maxSteps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run "/update-config" to update it, then "/reload".`,
    { details: { maxSteps } },
  );
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return isKimiError(error) && error.code === LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED;
}

export interface BeforeStepContext {
  readonly turnId: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface AfterStepContext extends BeforeStepContext {
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
  /**
   * Set to true to end the turn at this step boundary. Takes precedence in
   * the run loop over both requested tool calls and any queued step
   * requests, so a hard stop (e.g. a reached goal budget) cannot be
   * overridden by another hook's continuation.
   */
  stopTurn: boolean;
}

export interface LoopErrorContext {
  readonly turnId: number;
  /** The currently executing step, or undefined for turn-level failures. */
  readonly step?: number;
  /** The failed step's wire uuid, when the failure happened inside a step. */
  readonly stepId?: string;
  readonly signal: AbortSignal;
  readonly error: unknown;
  /**
   * The driver whose step failed; already popped from the queue. Handlers
   * re-run it by returning it in the recovery's `requests`.
   */
  readonly failedDriver?: StepRequest;
}

export interface LoopErrorRecovery {
  /** Head-inserted as a sequence: `requests[0]` drives the next step. */
  readonly requests: readonly StepRequest[];
  /**
   * Reuse the failed step's number for the next step (loop-level retry): it
   * neither increments the step counter nor trips the maxSteps budget check.
   */
  readonly resumeStep?: boolean;
}

export interface LoopErrorHandler {
  readonly id: string;
  /** Claim the error: the first matching handler in registration order handles it. */
  match(context: LoopErrorContext): boolean;
  /**
   * Recover from a claimed error. Awaiting inside the handler (backoff sleeps,
   * compaction) suspends the loop in its catch path — aborting `context.signal`
   * still cancels the turn. Return the requests that continue the turn, or
   * undefined to fail the turn with the original error; throwing fails the
   * turn with the handler's error.
   */
  handle(context: LoopErrorContext): Promise<LoopErrorRecovery | undefined>;
}

export interface LoopErrorHandlerRegistrationOptions {
  readonly before?: string;
  readonly after?: string;
}

export interface LoopRunOptions {
  readonly turnId: number;
  readonly signal?: AbortSignal;
  /** Fires on the first model response event for a step, or at step completion. */
  readonly onStarted?: (step: number) => void;
}

export type LoopRunResult =
  | {
      readonly type: 'completed';
      readonly steps: number;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'failed';
      readonly steps: number;
      readonly error: unknown;
    }
  | {
      readonly type: 'cancelled';
      readonly steps: number;
      readonly reason: unknown;
    };

export type TurnResult = LoopRunResult;

export interface Turn {
  readonly id: number;
  /**
   * Cancellation signal owned by the `activity` kernel's turn lease. Abort it
   * through `IAgentLoopService.cancel(...)` rather than holding a controller;
   * the kernel is the single authority for turn cancellation.
   */
  readonly signal: AbortSignal;
  /**
   * Resolves on the first model response event for the first loop step, or at
   * step completion; rejects if the turn ends earlier.
   */
  readonly ready: Promise<void>;
  readonly result: Promise<LoopRunResult>;
}

/**
 * What `enqueue` hands back for one queued request: the turn it belongs to
 * plus a retract handle. `turn` is the newly started turn for a `nextTurn`
 * request, the joined turn for a `tryInTurn` request enqueued mid-turn, and
 * `undefined` for a `tryInTurn` request queued with no active turn — it rides
 * the next turn. `abort` retracts a still-pending request and reports false
 * once it has materialized (a `nextTurn` driver's first step materializes
 * before `enqueue` returns, so its `abort` always reports false).
 */
export interface EnqueueReceipt {
  readonly turn: Turn | undefined;
  abort(): boolean;
}

export interface StepEnqueueOptions {
  /** `tail` (default) preserves order for normal work; `head` jumps the queue (used to retry a failed step). */
  readonly at?: 'head' | 'tail';
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  /**
   * Enqueue a step request. Turn membership comes from the request's
   * `priority`: a `nextTurn` request starts a fresh turn synchronously —
   * admission through the `activity` kernel throws its coded error when
   * another turn is active, and the request never enters the queue in that
   * case — while a `tryInTurn` request joins the active turn or waits in the
   * queue for the next one. Turn-scoped requests enqueued during a run are
   * aborted if the turn ends before they are popped.
   */
  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt;

  /** The running turn's handle, or `undefined` between turns. */
  getActiveTurn(): Turn | undefined;

  /**
   * Cancel the active turn (optionally only when its id matches `turnId`),
   * recording `turn.cancel` on the wire. The `activity` kernel owns the actual
   * abort; returns false when no (matching) turn is active.
   */
  cancel(turnId?: number, reason?: unknown): boolean;

  /** True while any non-aborted step request is queued. */
  hasPendingRequests(): boolean;

  /**
   * Register a recovery handler for step failures. Handlers dispatch in
   * registration order, first match wins — the loop itself knows nothing
   * about concrete error types: retry policies (`stepRetry`) and overflow
   * recovery (`fullCompaction`) plug in here.
   */
  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options?: LoopErrorHandlerRegistrationOptions,
  ): IDisposable;

  readonly hooks: Hooks<{
    beforeStep: BeforeStepContext;
    afterStep: AfterStepContext;
  }>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
