import { createDecorator } from '#/_base/di/instantiation';
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
  readonly signal: AbortSignal;
  readonly error: unknown;
  /**
   * Set to true only after a handler has changed state enough for the loop to
   * retry. Handlers that do not recognize the error must call next().
   */
  retry: boolean;
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

export interface StepEnqueueOptions {
  /** `tail` (default) preserves order for normal work; `head` jumps the queue (used to retry a failed step). */
  readonly at?: 'head' | 'tail';
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  /**
   * Drain the step queue for one turn: each queued `StepRequest` drives (or
   * merges into) one step, and the turn completes once the queue empties.
   * Callers seed the queue via `enqueue` before launching the turn.
   */
  run(options: LoopRunOptions): Promise<LoopRunResult>;

  /**
   * Enqueue a step request. Requests enqueued while no run is active are
   * drained by the next run; turn-scoped requests enqueued during a run are
   * aborted if the turn ends before they are popped.
   */
  enqueue(request: StepRequest, options?: StepEnqueueOptions): void;

  /** True while any non-aborted step request is queued. */
  hasPendingRequests(): boolean;

  readonly hooks: Hooks<{
    beforeStep: BeforeStepContext;
    afterStep: AfterStepContext;
    onError: LoopErrorContext;
  }>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
