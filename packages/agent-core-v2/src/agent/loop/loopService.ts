import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createControlledPromise } from '@antfu/utils';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { type FinishReason } from '#/kosong/contract/provider';
import { mergeInPlace, type ContentPart, type StreamedMessagePart } from '#/kosong/contract/message';
import { type TokenUsage } from '#/kosong/contract/usage';
import { BugIndicatingError, ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
  type ParsedCronExpression,
} from '#/features/cron/internal/cron-expr';
import { formatLocalIsoWithOffset } from '#/features/cron/internal/format';
import type { CronTask } from '#/features/cron/cronTask';
import { MAX_CRON_JOBS_PER_SESSION, MAX_PROMPT_BYTES } from '#/features/cron/tools/cron-create/cron-create';
import { AgentGoal } from '#/features/goal/goalAgentRuntime';
import type { GoalBudgetLimits } from '#/features/goal/types';
import { IAgentPlanService } from '#/features/plan/plan';
import { AgentTodo } from '#/features/todo/todoAgentRuntime';
import { readTodoItems } from '#/features/todo/todoItem';
import { OrderedHookSlot } from '#/hooks';
import {
  ISessionQuestionService,
  type QuestionAnswers,
  type QuestionResponse,
  type QuestionResult,
} from '#/session/question/question';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import type {
  EngineTurnEvent,
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type AfterStepContext,
  type AgentLoopStatus,
  type EnqueueReceipt,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopRunOptions,
  type LoopRunResult,
  type Step,
  type StepEnqueueOptions,
  type StepResult,
  type Turn,
  type TurnResult,
} from './loop';
import {
  type StepRequest,
  type TurnSeed,
} from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';
import {
  AssistantDelta,
  isDisplayablePromptOrigin,
  ThinkingDelta,
  ToolCallDelta,
  turnPromptAttachments,
  turnPromptText,
  TurnStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepStarted,
  type TurnInterruptReason,
} from './turnEvents';
import { TurnCancel, TurnEnded, turnKey, TurnPrompt } from './turnOps';
import {
  IEngineOverrideService,
  type EngineOverrideProvider,
  type TurnEngine,
  type TurnEngineGoalContext,
  type TurnEngineInput,
} from './engineOverride';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export const loopNextReservedTurnIdKey = defineState<number | undefined>(
  'loop.nextReservedTurnId',
  () => undefined as number | undefined,
);
export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  'loop.lastRequestTraceId',
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

const MAX_STEP_SIGNAL_LISTENERS = 64;

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
  };

  private readonly standaloneStepQueue = new StepRequestQueue();
  private readonly pendingAssignments = new Map<StepRequest, ReturnType<typeof createControlledPromise<import('./loop').StepAssignment>>>();
  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly engineGoalProviders: Array<() => TurnEngineGoalContext | undefined> = [];
  private readonly pendingTurns: TurnJob[] = [];
  private readonly heldAdmissions: HeldAdmission[] = [];
  private activeTurnJob: TurnJob | undefined;
  private readonly settleWaiters: Array<() => void> = [];
  private quiescenceDepth = 0;
  private activeRequestTrace: LLMRequestTrace | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEngineOverrideService private readonly engineOverride: EngineOverrideProvider,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @ISessionQuestionService private readonly question: ISessionQuestionService,
  ) {
    super();
    this.states.contributeState(turnKey);
    this.states.contributeState(loopNextReservedTurnIdKey);
    this.states.contributeState(loopLastRequestTraceIdKey);
    this.states.contributeState(loopDisposingKey);
  }

  private get nextReservedTurnId(): number | undefined {
    return this.states.get(loopNextReservedTurnIdKey);
  }

  private set nextReservedTurnId(value: number | undefined) {
    this.states.set(loopNextReservedTurnIdKey, value);
  }

  private get lastRequestTraceId(): string | undefined {
    return this.states.get(loopLastRequestTraceIdKey);
  }

  private set lastRequestTraceId(value: string | undefined) {
    this.states.set(loopLastRequestTraceIdKey, value);
  }

  private get disposing(): boolean {
    return this.states.get(loopDisposingKey);
  }

  private set disposing(value: boolean) {
    this.states.set(loopDisposingKey, value);
  }

  override dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const reason = abortError('Agent loop disposed');
    for (const job of this.pendingTurns.slice()) this.cancel(job.turn.id, reason);
    this.activeTurnJob?.turn.cancel(reason);
    for (const request of this.standaloneStepQueue.drain()) {
      request.abort();
      this.rejectAssignment(request, reason);
    }
    for (const { request } of this.heldAdmissions.splice(0)) {
      request.abort();
      this.rejectAssignment(request, reason);
    }
    this.maybeSettle();
    super.dispose();
  }

  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt {
    if (this.disposing) throw abortError('Agent loop disposed');
    const assignment = createControlledPromise<import('./loop').StepAssignment>();
    void assignment.catch(() => undefined);
    this.pendingAssignments.set(request, assignment);

    if (this.quiescenceDepth > 0) {
      this.heldAdmissions.push({ request, options });
    } else {
      this.admit(request, options);
    }
    return {
      assigned: assignment,
      abort: (reason) => this.abortRequest(request, reason),
    };
  }

  private admit(request: StepRequest, options?: StepEnqueueOptions): void {
    const active = this.activeTurnJob;
    switch (request.admission) {
      case 'newTurn':
        this.createAndQueueTurn(request);
        break;
      case 'activeOrNewTurn':
        if (active === undefined) this.createAndQueueTurn(request);
        else this.assignStep(active, request, options);
        break;
      case 'activeOrNextTurn':
        if (active === undefined) this.standaloneStepQueue.enqueue(request, options?.at ?? 'tail');
        else this.assignStep(active, request, options);
        break;
      case 'activeTurnOnly':
        if (active === undefined) {
          const error = new BugIndicatingError(`Step request "${request.kind}" requires an active turn`);
          this.rejectAssignment(request, error);
          throw error;
        }
        this.assignStep(active, request, options);
        break;
    }
  }

  private createAndQueueTurn(request: StepRequest): void {
    const seed = request.turnSeed;
    if (seed === undefined) {
      const error = new BugIndicatingError(`Step request "${request.kind}" cannot start a turn without turnSeed`);
      this.rejectAssignment(request, error);
      throw error;
    }
    const job = this.createPendingTurn(request, seed);
    this.pendingTurns.push(job);
    this.pumpTurns();
  }

  status(): AgentLoopStatus {
    return {
      state: this.activeTurnJob === undefined ? 'idle' : 'running',
      activeTurnId: this.activeTurnJob?.turn.id,
      pendingTurnIds: this.pendingTurns.map((job) => job.turn.id),
      hasPendingRequests: this.hasPendingRequests(),
      activeTraceId: this.activeRequestTrace?.traceId,
    };
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    const cancellation = reason ?? userCancellationReason();
    return (
      this.cancelActiveTurn(turnId, cancellation) ||
      (turnId !== undefined && this.cancelQueuedTurn(turnId, cancellation))
    );
  }

  cancelFromUser(turnId?: number): void {
    const status = this.status();
    if (status.state === 'running') {
      this.telemetry.track2('cancel', {
        from: 'streaming',
        trace_id: status.activeTraceId,
      });
    }
    this.cancel(turnId);
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (
      this.quiescenceDepth > 0 ||
      this.activeTurnJob !== undefined ||
      this.hasPendingRequests()
    ) {
      return undefined;
    }
    this.quiescenceDepth += 1;
    return toDisposable(() => this.releaseQuiescence());
  }

  private releaseQuiescence(): void {
    if (this.quiescenceDepth === 0) return;
    this.quiescenceDepth -= 1;
    if (this.quiescenceDepth > 0 || this.disposing) return;
    this.pumpTurns();
    for (const admission of this.heldAdmissions.splice(0)) {
      if (admission.request.aborted) continue;
      try {
        this.admit(admission.request, admission.options);
      } catch (error) {
        admission.request.abort();
        this.rejectAssignment(admission.request, error);
      }
    }
    this.pumpTurns();
  }

  private cancelActiveTurn(turnId: number | undefined, cancellation: unknown): boolean {
    const job = this.activeTurnJob;
    if (job === undefined || (turnId !== undefined && job.turn.id !== turnId)) return false;
    if (job.controller.signal.aborted) return true;
    void this.dispatcher.dispatch(
      new TurnCancel({
        agentId: this.scopeContext.agentId,
        turnId: job.turn.id,
        target: 'active',
        reason: cancelReasonFor(cancellation),
      }),
    );
    job.controller.abort(cancellation);
    return true;
  }

  private cancelQueuedTurn(turnId: number, cancellation: unknown): boolean {
    const index = this.pendingTurns.findIndex((job) => job.turn.id === turnId);
    if (index < 0) return false;
    const [job] = this.pendingTurns.splice(index, 1);
    if (job === undefined || job.turn.state !== 'queued') return false;
    void this.dispatcher.dispatch(
      new TurnCancel({
        agentId: this.scopeContext.agentId,
        turnId,
        target: 'queued',
        reason: cancelReasonFor(cancellation),
      }),
    );
    for (const step of job.steps.values()) step.cancel(cancellation);
    job.controller.abort(cancellation);
    job.turn.state = 'cancelled';
    job.ready.reject(cancellation instanceof Error ? cancellation : abortError('Turn cancelled'));
    job.result.resolve({ type: 'cancelled', steps: 0, reason: cancellation });
    this.maybeSettle();
    return true;
  }

  hasPendingRequests(): boolean {
    return (
      this.activeTurnJob?.queue.hasPendingRequests() === true ||
      this.standaloneStepQueue.hasPendingRequests() ||
      this.pendingTurns.length > 0 ||
      this.heldAdmissions.some(({ request }) => !request.aborted)
    );
  }

  settled(): Promise<void> {
    if (
      this.activeTurnJob === undefined &&
      this.pendingTurns.length === 0 &&
      this.heldAdmissions.length === 0
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  private maybeSettle(): void {
    if (
      this.activeTurnJob !== undefined ||
      this.pendingTurns.length > 0 ||
      this.heldAdmissions.length > 0
    ) return;
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private createPendingTurn(request: StepRequest, seed: TurnSeed): TurnJob {
    const id = this.reserveTurnId();
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    const queue = new StepRequestQueue();
    const steps = new Map<string, MutableStep>();
    void ready.catch(() => undefined);
    const turn: MutableTurn = {
      id,
      state: 'queued',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => this.cancel(id, reason),
    };
    const job = { request, seed, controller, ready, result, queue, steps, turn };
    this.assignStep(job, request);
    this.moveStandaloneStepsTo(job);
    return job;
  }

  private reserveTurnId(): number {
    const modelNextId = this.states.get(turnKey).nextTurnId;
    const id = Math.max(modelNextId, this.nextReservedTurnId ?? modelNextId);
    this.nextReservedTurnId = id + 1;
    return id;
  }

  private moveStandaloneStepsTo(job: TurnJob): void {
    for (const pending of this.standaloneStepQueue.drain()) {
      if (!pending.aborted) this.assignStep(job, pending);
    }
  }

  private assignStep(job: TurnJob, request: StepRequest, options?: StepEnqueueOptions): Step {
    const step = this.enqueueStep(job, request, options);
    const assignment = this.pendingAssignments.get(request);
    assignment?.resolve({ turn: job.turn, step });
    this.pendingAssignments.delete(request);
    return step;
  }

  private rejectAssignment(request: StepRequest, reason: unknown): void {
    const assignment = this.pendingAssignments.get(request);
    assignment?.reject(reason instanceof Error ? reason : abortError('Step request aborted'));
    this.pendingAssignments.delete(request);
  }

  private abortRequest(request: StepRequest, reason?: unknown): boolean {
    const heldIndex = this.heldAdmissions.findIndex((entry) => entry.request === request);
    if (heldIndex >= 0) {
      this.heldAdmissions.splice(heldIndex, 1);
      if (!request.abort()) return false;
      this.rejectAssignment(request, reason ?? userCancellationReason());
      this.maybeSettle();
      return true;
    }
    for (const job of [this.activeTurnJob, ...this.pendingTurns]) {
      if (job === undefined) continue;
      if (job.turn.state === 'queued' && job.request === request) {
        return this.cancel(job.turn.id, reason);
      }
      const step = job.steps.get(request.id);
      if (step !== undefined) return step.cancel(reason);
    }
    if (!request.abort()) return false;
    this.rejectAssignment(request, reason ?? userCancellationReason());
    return true;
  }

  private enqueueStep(job: TurnJob, request: StepRequest, options?: StepEnqueueOptions): Step {
    const existing = job.steps.get(request.id);
    if (existing !== undefined && existing.state !== 'cancelled') {
      job.queue.enqueue(request, options?.at ?? 'tail');
      existing.state = 'queued';
      return existing;
    }
    const controller = new AbortController();
    const result = createControlledPromise<StepResult>();
    const step: MutableStep = {
      id: request.id,
      turnId: job.turn.id,
      state: 'queued',
      signal: controller.signal,
      result,
      controller,
      resultControl: result,
      cancel: (reason) => this.cancelStep(job, step, request, reason),
    };
    job.steps.set(step.id, step);
    job.queue.enqueue(request, options?.at ?? 'tail');
    return step;
  }

  private cancelStep(job: TurnJob, step: MutableStep, request: StepRequest, reason?: unknown): boolean {
    if (step.state === 'completed' || step.state === 'failed' || step.state === 'cancelled') return false;
    const cancellation = reason ?? userCancellationReason();
    step.state = 'cancelled';
    request.abort();
    step.controller?.abort(cancellation);
    step.resultControl?.resolve({ type: 'cancelled', reason: cancellation });
    return true;
  }

  private pumpTurns(): void {
    if (this.disposing || this.quiescenceDepth > 0 || this.activeTurnJob !== undefined) return;
    const job = this.pendingTurns.shift();
    if (job === undefined) {
      this.maybeSettle();
      return;
    }
    this.startTurn(job);
  }

  private startTurn(job: TurnJob): void {
    const origin = job.seed.origin;
    void this.dispatcher.dispatch(
      new TurnPrompt({ agentId: this.scopeContext.agentId, input: job.seed.input, origin }),
    );
    job.turn.state = 'running';
    this.activeTurnJob = job;
    void this.dispatcher.dispatch(
      new TurnStarted({
        agentId: this.scopeContext.agentId,
        turnId: job.turn.id,
        origin,
        prompt: isDisplayablePromptOrigin(origin) ? turnPromptText(job.seed.input, origin) : undefined,
        promptAttachments: turnPromptAttachments(job.seed.input, origin),
      }),
    );
    void this.runTurn(job.turn, job.ready).then(job.result.resolve, job.result.reject);
  }

  private async runTurn(
    turn: Turn,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    this.telemetryContext.set({ turn_id: turn.id });
    const telemetryContext = this.telemetryContext.get();
    const turnTelemetry = this.telemetry.withContext(telemetryContext);
    const { mode, provider_type, protocol } = telemetryContext;
    let thinkingEffort: string | undefined;
    let result: TurnResult | undefined;
    try {
      thinkingEffort = this.llmRequester.prepareTurnConfig(turn.id)?.thinkingEffort;
      const started: TurnStartedTelemetryEvent = {
        turn_id: turn.id,
        mode,
        provider_type,
        protocol,
        thinking_effort: thinkingEffort,
      };
      turnTelemetry.track2('turn_started', started);
      result = await this.run({
        turnId: turn.id,
        signal: turn.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      result = this.resultFromTurnError(turn, error);
      return result;
    } finally {
      this.settleTurnReady(ready, result);
      this.releaseActiveTurn(turn, result);
      const traceId =
        result?.type === 'completed'
          ? this.lastRequestTraceId
          : this.activeRequestTrace?.traceId;
      if (result !== undefined) {
        const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
        const interruptReason =
          result.type === 'completed' ? undefined : interruptReasonFor(result);
        const durationMs = Date.now() - startedAt;
        void this.dispatcher.dispatch(
          new TurnEnded({
            agentId: this.scopeContext.agentId,
            turnId: turn.id,
            reason: result.type,
            error,
            durationMs,
            interruptReason,
          }),
        );
        if (error !== undefined) {
          void this.dispatcher.dispatch(
            new AgentErrorEvent({ ...error, agentId: this.scopeContext.agentId }),
          );
        }
        if (interruptReason !== undefined) {
          const interrupted: TurnInterruptedEvent = {
            turn_id: turn.id,
            at_step: result.steps,
            mode,
            interrupt_reason: interruptReason,
            provider_type,
            protocol,
            thinking_effort: thinkingEffort,
            trace_id: traceId,
          };
          turnTelemetry.track2('turn_interrupted', interrupted);
        }
      }
      const ended: TurnEndedTelemetryEvent = {
        turn_id: turn.id,
        reason: result?.type ?? 'failed',
        duration_ms: Date.now() - startedAt,
        mode,
        provider_type,
        protocol,
        thinking_effort: thinkingEffort,
        trace_id: traceId,
      };
      turnTelemetry.track2('turn_ended', ended);
      this.activeRequestTrace = undefined;
      this.lastRequestTraceId = undefined;
      this.pumpTurns();
    }
  }

  private resultFromTurnError(turn: Turn, error: unknown): TurnResult {
    const signal = turn.signal;
    if (!signal?.aborted) return { type: 'failed', error, steps: 0 };
    return { type: 'cancelled', steps: 0, reason: signal.reason ?? error };
  }

  private settleTurnReady(
    ready: ReturnType<typeof createControlledPromise<void>>,
    result: TurnResult | undefined,
  ): void {
    if (result?.type === 'failed') {
      ready.reject(result.error);
    } else if (result?.type === 'cancelled') {
      ready.reject(result.reason instanceof Error ? result.reason : abortError('Turn cancelled'));
    } else {
      ready.reject(new Error2(ErrorCodes.INTERNAL, 'Turn ended before first step'));
    }
  }

  private releaseActiveTurn(turn: Turn, result: TurnResult | undefined): void {
    (turn as MutableTurn).state = result?.type ?? 'failed';
    const job = this.activeTurnJob?.turn === turn ? this.activeTurnJob : undefined;
    if (job === undefined) return;
    const reason = result?.type === 'cancelled' ? result.reason : abortError('Turn ended');
    for (const step of job.steps.values()) {
      if (step.state === 'queued' || step.state === 'running') step.cancel(reason);
    }
    this.activeTurnJob = undefined;
    this.maybeSettle();
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new BugIndicatingError('Loop error handler registration cannot specify both before and after');
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) {
        throw new BugIndicatingError(`Loop error handler target "${target}" is not registered`);
      }
      const insertAt = options.before !== undefined ? targetIndex : targetIndex + 1;
      this.errorHandlers.splice(insertAt, 0, handler);
    }
    return toDisposable(() => {
      this.deleteErrorHandler(handler.id);
    });
  }

  private deleteErrorHandler(id: string): boolean {
    const index = this.errorHandlers.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.errorHandlers.splice(index, 1);
    return true;
  }

  registerEngineGoalProvider(
    provider: () => TurnEngineGoalContext | undefined,
  ): IDisposable {
    this.engineGoalProviders.push(provider);
    return toDisposable(() => {
      const index = this.engineGoalProviders.indexOf(provider);
      if (index >= 0) this.engineGoalProviders.splice(index, 1);
    });
  }

  private getEngineGoal(): TurnEngineGoalContext | undefined {
    for (const provider of this.engineGoalProviders) {
      const snapshot = provider();
      if (snapshot !== undefined) return snapshot;
    }
    return undefined;
  }

  async run(options: LoopRunOptions): Promise<LoopRunResult> {
    const runtime = this.createLoopRuntime(options);
    try {
      while (true) {
        try {
          const begun = this.beginLoopStep(runtime);
          if ('result' in begun) return begun.result;
          runtime.current = begun.step;
          // An external engine (e.g. the Rust kimi-agent engine) drives the
          // whole turn in place of the JS loop. The override runs once per
          // turn on the first step; the engine consumes the turn to
          // completion and reports events back through the engine input.
          const engine = this.engineOverride.getEngine();
          if (engine !== undefined && runtime.steps === 1) {
            const stepResult = await this.executeTurnViaEngine(runtime, engine, begun.step, options.onStarted);
            const completed = this.completeLoopStep(runtime, stepResult);
            if (completed !== undefined) return completed;
            return {
              type: 'completed',
              steps: runtime.steps,
              truncated: stepResult.stopReason === 'truncated',
            };
          }
          const result = await this.executeLoopStep(
            runtime.turnId,
            begun.step.signal,
            runtime.turnSignal,
            begun.step.number,
            runtime.job !== undefined && begun.step.number === 1,
            begun.step.uuid,
            options.onStarted,
          );
          const completed = this.completeLoopStep(runtime, result);
          if (completed !== undefined) return completed;
        } catch (error) {
          const disposition = await this.handleLoopStepError(runtime, error);
          if (disposition.type === 'return') return disposition.result;
        }
      }
    } finally {
      runtime.queue.abortTurnScoped();
    }
  }

  private createLoopRuntime(options: LoopRunOptions): LoopRuntime {
    const job = this.activeTurnJob?.turn.id === options.turnId ? this.activeTurnJob : undefined;
    return {
      turnId: options.turnId,
      turnSignal: options.signal ?? new AbortController().signal,
      job,
      queue: job?.queue ?? this.standaloneStepQueue,
      steps: 0,
      lastStopReason: undefined,
      current: undefined,
    };
  }

  private beginLoopStep(runtime: LoopRuntime): BeginStepResult {
    runtime.current = undefined;
    runtime.turnSignal.throwIfAborted();
    if (!runtime.queue.hasPendingRequests()) {
      return {
        result: {
          type: 'completed',
          steps: runtime.steps,
          truncated: runtime.lastStopReason === 'truncated',
        },
      };
    }
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (maxSteps !== undefined && maxSteps > 0 && runtime.steps >= maxSteps) {
      throw createMaxStepsExceededError(maxSteps);
    }
    const batch = runtime.queue.takeNextBatch()!;
    const mutableStep = runtime.job?.steps.get(batch.driver.id);
    if (mutableStep !== undefined) {
      mutableStep.state = 'running';
      mutableStep.controller = new AbortController();
      mutableStep.signal = mutableStep.controller.signal;
    }
    const step: StepRuntime = {
      number: ++runtime.steps,
      uuid: randomUUID(),
      batch,
      mutableStep,
      signal: mutableStep?.controller === undefined
        ? runtime.turnSignal
        : AbortSignal.any([runtime.turnSignal, mutableStep.controller.signal]),
    };
    EventEmitter.setMaxListeners(MAX_STEP_SIGNAL_LISTENERS, step.signal);
    this.materializeBatch(batch);
    return { step };
  }

  private completeLoopStep(
    runtime: LoopRuntime,
    result: StepExecutionResult,
  ): LoopRunResult | undefined {
    const current = runtime.current!;
    if (current.mutableStep !== undefined) {
      current.mutableStep.state = 'completed';
      current.mutableStep.resultControl?.resolve({ type: 'completed' });
    }
    runtime.current = undefined;
    runtime.lastStopReason = result.stopReason;
    if (result.stopReason === 'filtered') {
      throw new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.', {
        name: 'ProviderFilteredError',
        details: { finishReason: 'filtered' },
      });
    }
    if (!result.hookStopTurn) return undefined;
    return { type: 'completed', steps: runtime.steps, truncated: result.stopReason === 'truncated' };
  }

  private async handleLoopStepError(
    runtime: LoopRuntime,
    error: unknown,
  ): Promise<LoopErrorDisposition> {
    const cancellation = this.handleLoopCancellation(runtime, error);
    if (cancellation !== undefined) return cancellation;
    const recovery = await this.tryRecoverLoopError(runtime, error);
    return recovery ?? this.failLoopStep(runtime, error);
  }

  private handleLoopCancellation(
    runtime: LoopRuntime,
    error: unknown,
  ): LoopErrorDisposition | undefined {
    const step = runtime.current?.mutableStep;
    if (!isAbortError(error) && !runtime.turnSignal.aborted && step?.signal.aborted !== true) return undefined;
    const reason = runtime.turnSignal.reason ?? step?.signal.reason ?? error;
    this.emitStepInterrupted(
      runtime.turnId,
      runtime.current?.number,
      'aborted',
      isUserCancellation(reason) ? undefined : toErrorMessage(reason),
    );
    if (!runtime.turnSignal.aborted && step?.state === 'cancelled') {
      runtime.current = undefined;
      return { type: 'continue' };
    }
    return { type: 'return', result: { type: 'cancelled', reason, steps: runtime.steps } };
  }

  private async tryRecoverLoopError(
    runtime: LoopRuntime,
    error: unknown,
  ): Promise<LoopErrorDisposition | undefined> {
    const current = runtime.current;
    const context: LoopErrorContext = {
      currentStep: current?.mutableStep,
      turnId: runtime.turnId,
      step: current?.number,
      stepId: current?.uuid,
      signal: runtime.turnSignal,
      error,
      failedDriver: current?.batch.driver,
      retry: (request, options) => {
        if (runtime.job !== undefined) return this.enqueueStep(runtime.job, request, options);
        runtime.queue.enqueue(request, options?.at ?? 'tail');
        return current?.mutableStep ?? {
          id: request.id,
          turnId: runtime.turnId,
          state: 'queued',
          signal: runtime.turnSignal,
          result: Promise.resolve({ type: 'completed' }),
          cancel: () => request.abort(),
        };
      },
    };
    const handler = this.errorHandlers.find((entry) => entry.match(context));
    if (handler === undefined) return undefined;
    try {
      if (await handler.handle(context)) {
        runtime.current = undefined;
        return { type: 'continue' };
      }
      return undefined;
    } catch (handlerError) {
      return this.handleLoopCancellation(runtime, handlerError) ?? this.failLoopStep(runtime, handlerError);
    }
  }

  private failLoopStep(runtime: LoopRuntime, error: unknown): LoopErrorDisposition {
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    const interruptedError =
      isError2(error) && error.code === ErrorCodes.INTERNAL && error.cause !== undefined ? error.cause : error;
    this.emitStepInterrupted(runtime.turnId, runtime.current?.number, reason, toErrorMessage(interruptedError));
    return { type: 'return', result: { type: 'failed', error, steps: runtime.steps } };
  }

  private materializeBatch(batch: StepRequestBatch): void {
    this.materializeRequest(batch.driver);
    for (const request of batch.merged) {
      this.materializeRequest(request);
    }
  }

  private materializeRequest(request: StepRequest): void {
    if (request.state !== 'pending') return;
    request.onWillMaterialize();
    const messages = request.resolveContextMessages();
    if (messages.length > 0) {
      this.context.append(...messages);
    }
    request.markMaterialized();
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    turnSignal: AbortSignal,
    currentStep: number,
    firstStepOfTurn: boolean,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): Promise<StepExecutionResult> {
    this.activeRequestTrace = undefined;
    await this.hooks.onWillBeginStep.run({ turnId, step: currentStep, firstStepOfTurn, signal });
    const markStepStarted = this.beginStep(turnId, signal, currentStep, stepUuid, onStarted);
    let stepEndAppended = false;
    try {
      const streamParts = this.createStreamPartHandler(turnId, markStepStarted);
      const request = this.llmRequester.start(
        { source: { type: 'turn', turnId, step: currentStep } },
        streamParts.handle,
        signal,
      );
      this.activeRequestTrace = request.trace;
      let response: AgentLLMRequestFinish;
      try {
        response = await request.result;
      } catch (error) {
        this.appendInterruptedStreamContent(turnId, currentStep, stepUuid, streamParts);
        throw error;
      }
      this.lastRequestTraceId = request.trace.traceId;
      this.appendResponseContent(turnId, currentStep, stepUuid, response);
      const finishReason = await this.executeStepTools(
        turnId,
        signal,
        currentStep,
        stepUuid,
        response,
        request.trace,
      );
      this.finishStep(turnId, signal, currentStep, stepUuid, response, finishReason, markStepStarted);
      stepEndAppended = true;
      const hookStopTurn = await this.runAfterStep(
        turnId,
        signal,
        currentStep,
        firstStepOfTurn,
        response.usage,
        finishReason,
      );
      return { stopReason: finishReason, hookStopTurn };
    } catch (error) {
      if (!stepEndAppended) {
        this.context.appendLoopEvent({
          type: 'step.end',
          uuid: stepUuid,
          turnId: String(turnId),
          step: currentStep,
          finishReason:
            isAbortError(error) || signal.aborted || turnSignal.aborted ? 'interrupted' : 'error',
        });
      }
      throw error;
    }
  }

  /**
   * External-engine turn drive. The engine runs the whole turn and reports
   * transcript events back through `dispatchEvent`; this method only wraps
   * the call with the step lifecycle UI events (started/completed) that the
   * JS path would have produced in `beginStep`/`finishStep`. The engine is
   * responsible for dispatching its own `step.begin`/`step.end` into the
   * context, so `beginStep` is intentionally not called.
   */
  private async executeTurnViaEngine(
    runtime: LoopRuntime,
    engine: TurnEngine,
    step: StepRuntime,
    onStarted: ((step: number) => void) | undefined,
  ): Promise<StepExecutionResult> {
    const turnId = runtime.turnId;
    const signal = step.signal;
    signal.throwIfAborted();
    await this.hooks.onWillBeginStep.run({
      turnId,
      step: step.number,
      firstStepOfTurn: step.number === 1,
      signal,
    });
    void this.dispatcher.dispatch(
      new TurnStepStarted({
        agentId: this.scopeContext.agentId,
        turnId,
        step: step.number,
        stepId: step.uuid,
      }),
    );
    onStarted?.(step.number);
    const input = this.buildEngineInput(turnId, signal, step.number);
    const result = await engine(input);
    if (result.telemetry !== undefined) {
      const engineTurn: EngineTurnEvent = {
        turn_id: turnId,
        stop_reason: result.stopReason,
        steps: result.steps,
        events_emitted: result.telemetry.eventsEmitted,
        llm_retries: result.telemetry.llmRetries,
        llm_transport: result.telemetry.llmTransport,
        native_tool_call_count: result.telemetry.nativeToolCallCount,
      };
      this.telemetry.withContext(this.telemetryContext.get()).track2('engine_turn', engineTurn);
    }
    void this.dispatcher.dispatch(
      new TurnStepCompleted({
        agentId: this.scopeContext.agentId,
        turnId,
        step: step.number,
        stepId: step.uuid,
        usage: result.usage,
        finishReason: normalizeFinishReason(result.stopReason),
        providerFinishReason: result.stopReason,
      }),
    );
    return { stopReason: result.stopReason, hookStopTurn: false };
  }

  private buildEngineInput(
    turnId: number,
    signal: AbortSignal,
    step: number,
  ): TurnEngineInput {
    const modelContext = this.profile.resolveModelContext();
    return {
      turnId,
      signal,
      llm: {
        modelAlias: modelContext.modelAlias,
        modelId: modelContext.modelId,
        systemPrompt: this.profile.getSystemPrompt(),
        chat: async (chatInput) => {
          const finish = await this.llmRequester.request(
            {
              messages: [...chatInput.messages],
              tools: [...chatInput.tools],
              source: { type: 'turn', turnId, step },
            },
            (part) => {
              if (part.type === 'text') return chatInput.onTextPart?.(part);
              if (part.type === 'think') return chatInput.onThinkPart?.(part);
              return undefined;
            },
            chatInput.signal ?? signal,
          );
          return {
            toolCalls: finish.message.toolCalls,
            providerFinishReason: finish.providerFinishReason,
            usage: finish.usage,
          };
        },
      },
      maxSteps: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn,
      buildMessages: async () => [...this.projector.project(this.context.get())],
      getGoal: () => this.getEngineGoal(),
      buildTools: () =>
        this.toolSelect.shapeTools(this.toolRegistry.list()).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? {},
        })),
      dispatchEvent: (event) => {
        this.context.appendLoopEvent(event);
        this.dispatchEngineUIBridge(turnId, event);
      },
      executeTool: async (call, options) => {
        const results: ToolExecutionResult[] = [];
        for await (const toolResult of this.toolExecutor.execute([call], {
          signal: options.signal,
          turnId: options.turnId,
          trace: options.trace,
          onToolCall: (payload) => {
            options.onToolCall?.(payload);
          },
        })) {
          results.push(toolResult);
        }
        const last = results[results.length - 1];
        if (last === undefined) return { output: '', isError: true };
        return {
          output: last.result.output,
          isError: last.result.isError,
          note: last.result.note,
          stopTurn: last.result.stopTurn,
        };
      },
      checkToolPermission: async (call) => {
        const denied = (reason: string) => ({ decision: 'deny' as const, reason });
        try {
          // Resolved lazily on first use: constructing the gate earlier would
          // reorder the toolExecutor permission listeners ahead of features
          // that must short-circuit them (e.g. plan-mode file interception).
          const gate = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentPermissionGate),
          );
          const tool = this.toolRegistry.resolve(call.name);
          if (tool === undefined) return denied(`Tool "${call.name}" is not registered`);
          let args: unknown = {};
          if (typeof call.arguments === 'string' && call.arguments.length > 0) {
            args = JSON.parse(call.arguments);
          }
          const execution = await tool.resolveExecution(args);
          if (!('execute' in execution)) {
            return denied(`Tool "${call.name}" failed to resolve its execution`);
          }
          const decision = await gate.authorize({
            turnId,
            signal,
            toolCall: call,
            toolCalls: [call],
            tool,
            args,
            execution,
          });
          if (decision?.veto !== undefined) {
            const output = decision.veto.output;
            return denied(typeof output === 'string' ? output : JSON.stringify(output));
          }
          return { decision: 'allow' };
        } catch (error) {
          // Fail closed: a permission evaluation error must not open a
          // native execution path.
          return denied(
            `permission check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      finalizeToolResult: async (toolName, toolCallId, result) => {
        const truncation = this.instantiation.invokeFunction((accessor) =>
          accessor.get(IAgentToolResultTruncationService),
        );
        // Native engines return plain strings; the policy's output type is the
        // mutable form, so flatten anything else before applying it.
        const output =
          typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        const shared = { note: result.note, stopTurn: result.stopTurn };
        const executable =
          result.isError === true
            ? { output, isError: true as const, ...shared }
            : { output, ...shared };
        try {
          const finalized = await truncation.truncateForModel({
            toolName,
            toolCallId,
            result: executable,
          });
          return {
            output: finalized.output,
            isError: 'isError' in finalized && finalized.isError === true,
            note: finalized.note,
            stopTurn: finalized.stopTurn,
          };
        } catch {
          // A failed result policy must not cost the model its tool output.
          return result;
        }
      },
      askUserQuestion: async (request) => {
        const turnId = Number(request.turn_id);
        const result = await this.question.request(
          {
            turnId: turnId || undefined,
            toolCallId: request.tool_call_id,
            questions: request.questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: q.options.map((o) => ({ label: o.label, description: o.description })),
              multiSelect: q.multi_select,
            })),
          },
          { signal, agentId: this.scopeContext.agentId },
        );
        if (result === null) {
          return { answers: {}, note: 'User dismissed the question without answering.' };
        }
        if (isCancelledQuestionResult(result)) {
          return { cancelled: true, reason: result.reason };
        }
        if (isQuestionResponse(result)) {
          return { answers: mapQuestionAnswers(result.answers), method: result.method };
        }
        return { answers: mapQuestionAnswers(result) };
      },
      stateRead: async (request) => {
        if (request.domain === 'todo') {
          const lifecycle = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentLifecycleService),
          );
          const todo = lifecycle.resolve(this.scopeContext.agentContext, AgentTodo);
          return { value: todo.get() };
        }
        if (request.domain === 'plan') {
          const plan = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentPlanService),
          );
          const status = await plan.status();
          return {
            value:
              status === null
                ? { active: false }
                : { active: true, id: status.id, path: status.path },
          };
        }
        if (request.domain === 'cron') {
          const cron = cronRuntimeOf(this.instantiation, this.scopeContext.agentContext);
          return { value: cronEntriesWire(cron) };
        }
        if (request.domain === 'goal') {
          const lifecycle = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentLifecycleService),
          );
          const goal = lifecycle.resolve(this.scopeContext.agentContext, AgentGoal);
          return { value: goal.getGoal() };
        }
        throw stateBridgeError(-32001, `unknown state domain: ${request.domain}`);
      },
      stateWrite: async (request) => {
        if (request.domain === 'todo') {
          if (!Array.isArray(request.value)) {
            throw stateBridgeError(
              -32003,
              'invalid todo state value: expected an array of todo items',
            );
          }
          const lifecycle = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentLifecycleService),
          );
          const todo = lifecycle.resolve(this.scopeContext.agentContext, AgentTodo);
          await todo.replace(readTodoItems(request.value));
          return { ok: true, value: todo.get() };
        }
        if (request.domain === 'plan') {
          const value = request.value;
          if (
            typeof value !== 'object' ||
            value === null ||
            typeof (value as { active?: unknown }).active !== 'boolean'
          ) {
            throw stateBridgeError(
              -32003,
              'invalid plan state value: expected { active: boolean }',
            );
          }
          const plan = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentPlanService),
          );
          if ((value as { active: boolean }).active) {
            try {
              await plan.enter();
            } catch (error) {
              if (isError2(error) && error.code === ErrorCodes.SESSION_PLAN_MODE_INVALID) {
                throw stateBridgeError(-32004, error.message);
              }
              throw error;
            }
          } else {
            plan.exit();
          }
          const status = await plan.status();
          return {
            ok: true,
            value:
              status === null
                ? { active: false }
                : { active: true, id: status.id, path: status.path },
          };
        }
        if (request.domain === 'cron') {
          const value = request.value;
          if (typeof value !== 'object' || value === null) {
            throw stateBridgeError(
              -32003,
              'invalid cron state value: expected { action: "create" | "delete", ... }',
            );
          }
          const action = (value as { action?: unknown }).action;
          const cron = cronRuntimeOf(this.instantiation, this.scopeContext.agentContext);
          if (action === 'create') {
            const input = value as { cron?: unknown; prompt?: unknown; recurring?: unknown };
            if (typeof input.cron !== 'string' || typeof input.prompt !== 'string') {
              throw stateBridgeError(
                -32003,
                'invalid cron create value: expected { action: "create", cron: string, prompt: string, recurring?: boolean }',
              );
            }
            const recurring = input.recurring !== false;
            const normalizedCron = input.cron.trim().split(/\s+/).join(' ');
            let parsed: ParsedCronExpression;
            try {
              parsed = parseCronExpression(normalizedCron);
            } catch (error) {
              throw stateBridgeError(
                -32003,
                `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            const nowMs = cron.now();
            if (cron.isDisabled()) {
              throw stateBridgeError(-32003, 'Cron scheduling is disabled (KIMI_DISABLE_CRON=1).');
            }
            if (!hasFireWithinYears(parsed, 5, nowMs)) {
              throw stateBridgeError(
                -32003,
                `Cron expression ${JSON.stringify(normalizedCron)} has no fire within 5 years; refusing to schedule.`,
              );
            }
            if (cron.list().length >= MAX_CRON_JOBS_PER_SESSION) {
              throw stateBridgeError(
                -32003,
                `Cron job cap reached (max ${String(MAX_CRON_JOBS_PER_SESSION)} per session).`,
              );
            }
            const byteLen = Buffer.byteLength(input.prompt, 'utf8');
            if (byteLen > MAX_PROMPT_BYTES) {
              throw stateBridgeError(
                -32003,
                `Prompt exceeds ${String(MAX_PROMPT_BYTES)} bytes (got ${String(byteLen)}).`,
              );
            }
            if (!recurring) {
              const firstFire = computeNextCronRun(parsed, nowMs);
              if (firstFire !== null && firstFire - nowMs > ONE_SHOT_MAX_FUTURE_MS) {
                throw stateBridgeError(
                  -32003,
                  `One-shot cron ${JSON.stringify(normalizedCron)} would not fire until ${formatLocalIsoWithOffset(firstFire)} (more than a year out). If you meant "today" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.`,
                );
              }
            }
            const task = cron.addTask({ cron: normalizedCron, prompt: input.prompt, recurring });
            cron.emitScheduled(task, this.scopeContext.agentId);
            return { ok: true, value: cronEntryWire(cron, task) };
          }
          if (action === 'delete') {
            const id = (value as { id?: unknown }).id;
            if (typeof id !== 'string') {
              throw stateBridgeError(
                -32003,
                'invalid cron delete value: expected { action: "delete", id: string }',
              );
            }
            const removed = cron.removeTasks([id]);
            if (removed.length === 0) {
              throw stateBridgeError(-32004, `No cron job with id ${id}.`);
            }
            cron.emitDeleted(id, this.scopeContext.agentId);
            return { ok: true, value: cronEntriesWire(cron) };
          }
          throw stateBridgeError(-32003, `invalid cron action: ${String(action)}`);
        }
        if (request.domain === 'goal') {
          const value = request.value;
          if (typeof value !== 'object' || value === null) {
            throw stateBridgeError(
              -32003,
              'invalid goal state value: expected { action: "update" | "set_budget", ... }',
            );
          }
          const action = (value as { action?: unknown }).action;
          const lifecycle = this.instantiation.invokeFunction((accessor) =>
            accessor.get(IAgentLifecycleService),
          );
          const goal = lifecycle.resolve(this.scopeContext.agentContext, AgentGoal);
          if (action === 'update') {
            const status = (value as { status?: unknown }).status;
            if (status !== 'active' && status !== 'complete' && status !== 'blocked') {
              throw stateBridgeError(
                -32003,
                'Invalid goal status. Use `active`, `complete`, or `blocked`.',
              );
            }
            try {
              if (status === 'active') {
                await goal.resumeGoal({}, 'model');
                return { ok: true, value: goal.getGoal() };
              }
              if (status === 'complete') {
                const completed = await goal.markComplete({}, 'model');
                if (completed === null) {
                  throw stateBridgeError(-32004, 'Goal not completed: no active goal.');
                }
                return { ok: true, value: { goal: completed } };
              }
              const blocked = await goal.markBlocked({}, 'model');
              if (blocked === null) {
                throw stateBridgeError(-32004, 'Goal not blocked: no active goal.');
              }
              return { ok: true, value: { goal: blocked } };
            } catch (error) {
              if (isError2(error)) {
                throw stateBridgeError(-32004, error.message);
              }
              throw error;
            }
          }
          if (action === 'set_budget') {
            const input = value as { value?: unknown; unit?: unknown };
            if (
              typeof input.value !== 'number' ||
              !Number.isFinite(input.value) ||
              typeof input.unit !== 'string' ||
              !isBudgetUnit(input.unit)
            ) {
              throw stateBridgeError(
                -32003,
                'invalid goal set_budget value: expected { action: "set_budget", value: number, unit: "turns" | "tokens" | "milliseconds" | "seconds" | "minutes" | "hours" }',
              );
            }
            const budget = budgetLimitsFromWire(input.value, input.unit);
            if (budget === null) {
              throw stateBridgeError(
                -32003,
                `Goal budget not set: ${formatBudgetWire(input.value, input.unit)} is not a reasonable goal budget.`,
              );
            }
            try {
              const snapshot = await goal.setBudgetLimits({ budgetLimits: budget }, 'model');
              return { ok: true, value: { goal: snapshot } };
            } catch (error) {
              if (isError2(error)) {
                throw stateBridgeError(-32004, error.message);
              }
              throw error;
            }
          }
          throw stateBridgeError(-32003, `invalid goal action: ${String(action)}`);
        }
        throw stateBridgeError(-32001, `unknown state domain: ${request.domain}`);
      },
    };
  }

  private dispatchEngineUIBridge(turnId: number, event: LoopRecordedEvent): void {
    if (event.type !== 'content.part') return;
    const part = event.part;
    if (part.type === 'text') {
      void this.dispatcher.dispatch(
        new AssistantDelta({ agentId: this.scopeContext.agentId, turnId, delta: part.text }),
      );
    } else if (part.type === 'think') {
      void this.dispatcher.dispatch(
        new ThinkingDelta({ agentId: this.scopeContext.agentId, turnId, delta: part.think }),
      );
    }
  }

  private beginStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): () => void {
    signal.throwIfAborted();
    void this.dispatcher.dispatch(
      new TurnStepStarted({
        agentId: this.scopeContext.agentId,
        turnId,
        step: currentStep,
        stepId: stepUuid,
      }),
    );
    this.context.appendLoopEvent({
      type: 'step.begin',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
    });
    let stepStarted = false;
    return () => {
      if (stepStarted) return;
      stepStarted = true;
      onStarted?.(currentStep);
    };
  }

  private appendResponseContent(
    turnId: number,
    currentStep: number,
    stepUuid: string,
    response: AgentLLMRequestFinish,
  ): void {
    for (const part of response.message.content) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turnId),
        step: currentStep,
        stepUuid,
        part,
      });
    }
  }

  private appendInterruptedStreamContent(
    turnId: number,
    currentStep: number,
    stepUuid: string,
    streamParts: StreamPartCollector,
  ): void {
    for (const part of streamParts.drainInterruptedContent()) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turnId),
        step: currentStep,
        stepUuid,
        part,
      });
    }
  }

  private async executeStepTools(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    response: AgentLLMRequestFinish,
    trace: LLMRequestTrace,
  ): Promise<FinishReason> {
    let finishReason = response.providerFinishReason ?? 'completed';
    if (response.message.toolCalls.length === 0) {
      return finishReason === 'tool_calls' ? 'other' : finishReason;
    }
    const toolCallUuids = new Map<string, string>();
    let stopTurn = false;
    for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
      signal,
      turnId,
      trace,
      onToolCall: ({ toolCallId, name, args }) => {
        const callUuid = randomUUID();
        toolCallUuids.set(toolCallId, callUuid);
        const extras = response.message.toolCalls.find((t) => t.id === toolCallId)?.extras;
        this.context.appendLoopEvent({
          type: 'tool.call',
          uuid: callUuid,
          turnId: String(turnId),
          step: currentStep,
          stepUuid,
          toolCallId,
          name,
          args,
          extras,
        });
      },
    })) {
      const { result } = toolResult;
      this.context.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallUuids.get(toolResult.toolCallId) ?? randomUUID(),
        toolCallId: toolResult.toolCallId,
        result: { output: result.output, isError: result.isError, note: result.note },
      });
      if (result.stopTurn === true) stopTurn = true;
    }
    finishReason = stopTurn ? 'completed' : 'tool_calls';
    return finishReason;
  }

  private finishStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    response: AgentLLMRequestFinish,
    finishReason: FinishReason,
    markStepStarted: () => void,
  ): void {
    signal.throwIfAborted();
    markStepStarted();
    const timing = response.timing;
    const stepFinishReason = normalizeFinishReason(finishReason);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
      finishReason: stepFinishReason,
      usage: response.usage,
      llmFirstTokenLatencyMs: timing?.firstTokenLatencyMs,
      llmStreamDurationMs: timing?.streamDurationMs,
      llmRequestBuildMs: timing?.requestBuildMs,
      llmServerFirstTokenMs: timing?.serverFirstTokenMs,
      llmServerDecodeMs: timing?.serverDecodeMs,
      llmClientConsumeMs: timing?.clientConsumeMs,
      messageId: response.providerMessageId,
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
    this.emitStepCompleted(
      turnId,
      currentStep,
      stepUuid,
      response.usage,
      stepFinishReason,
      response,
    );
  }

  private async runAfterStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    firstStepOfTurn: boolean,
    usage: TokenUsage,
    finishReason: FinishReason,
  ): Promise<boolean> {
    const context: AfterStepContext = {
      turnId,
      step: currentStep,
      firstStepOfTurn,
      signal,
      usage,
      finishReason,
      stopTurn: false,
    };
    try {
      await this.hooks.onDidFinishStep.run(context);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
    }
    return context.stopTurn;
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: string,
    response: AgentLLMRequestFinish,
  ): void {
    void this.dispatcher.dispatch(
      new TurnStepCompleted({
        agentId: this.scopeContext.agentId,
        turnId,
        step,
        stepId,
        usage,
        finishReason,
        llmFirstTokenLatencyMs: response.timing?.firstTokenLatencyMs,
        llmStreamDurationMs: response.timing?.streamDurationMs,
        llmRequestBuildMs: response.timing?.requestBuildMs,
        llmServerFirstTokenMs: response.timing?.serverFirstTokenMs,
        llmServerDecodeMs: response.timing?.serverDecodeMs,
        llmClientConsumeMs: response.timing?.clientConsumeMs,
        providerFinishReason: response.providerFinishReason,
        rawFinishReason: response.rawFinishReason,
      }),
    );
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    void this.dispatcher.dispatch(
      new TurnStepInterrupted({
        agentId: this.scopeContext.agentId,
        turnId,
        step: activeStep,
        reason,
        message,
      }),
    );
  }

  private createStreamPartHandler(
    turnId: number,
    onResponseEvent: () => void,
  ): StreamPartCollector {
    const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();
    const partialContent: ContentPart[] = [];
    let forceContentPartBoundary = false;
    const accumulate = (part: ContentPart): void => {
      const last = partialContent.at(-1);
      if (!forceContentPartBoundary && last !== undefined && mergeInPlace(last, part)) return;
      forceContentPartBoundary = false;
      partialContent.push({ ...part });
    };

    return {
      handle: (part) => {
        switch (part.type) {
          case 'text':
            onResponseEvent();
            accumulate(part);
            void this.dispatcher.dispatch(
              new AssistantDelta({ agentId: this.scopeContext.agentId, turnId, delta: part.text }),
            );
            return;
          case 'think':
            onResponseEvent();
            accumulate(part);
            void this.dispatcher.dispatch(
              new ThinkingDelta({ agentId: this.scopeContext.agentId, turnId, delta: part.think }),
            );
            return;
          case 'image_url':
          case 'audio_url':
          case 'video_url':
            return;
          case 'function': {
            onResponseEvent();
            forceContentPartBoundary = true;
            callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
            void this.dispatcher.dispatch(
              new ToolCallDelta({
                agentId: this.scopeContext.agentId,
                turnId,
                toolCallId: part.id,
                name: part.name,
                argumentsPart: part.arguments ?? undefined,
              }),
            );
            return;
          }
          case 'tool_call_part': {
            if (part.argumentsPart === null) return;
            const toolCall = callsByIndex.get(part.index);
            if (toolCall === undefined) return;
            onResponseEvent();
            void this.dispatcher.dispatch(
              new ToolCallDelta({
                agentId: this.scopeContext.agentId,
                turnId,
                toolCallId: toolCall.id,
                name: toolCall.name,
                argumentsPart: part.argumentsPart,
              }),
            );
            return;
          }
          default: {
            const _exhaustive: never = part;
            return _exhaustive;
          }
        }
      },
      drainInterruptedContent: () =>
        partialContent.splice(0).filter((part) => !isVacuousContentPart(part)),
    };
  }
}

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

function stateBridgeError(code: number, message: string): Error {
  const error = new Error(message);
  (error as { code?: number }).code = code;
  return error;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;
const MIN_REASONABLE_TIME_BUDGET_MS = 1_000;
const MAX_REASONABLE_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
const BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'] as const;

function cronRuntimeOf(instantiation: IInstantiationService, agentContext: AgentContext): CronRuntime {
  const lifecycle = instantiation.invokeFunction((accessor) =>
    accessor.get(IAgentLifecycleService),
  );
  return lifecycle.resolve(agentContext, AgentCron);
}

function cronEntryWire(cron: CronRuntime, task: CronTask): Record<string, unknown> {
  const recurring = task.recurring !== false;
  let humanSchedule = task.cron;
  let nextFireAt: string | null = null;
  try {
    const parsed = parseCronExpression(task.cron);
    humanSchedule = cronToHuman(parsed);
    const nextFireMs = cron.getNextFireForTask(task.id);
    if (nextFireMs !== null) nextFireAt = formatLocalIsoWithOffset(nextFireMs);
  } catch {
  }
  const ageMs = cron.now() - task.createdAt;
  return {
    id: task.id,
    cron: task.cron,
    humanSchedule,
    prompt: task.prompt,
    createdAt: task.createdAt,
    recurring,
    lastFiredAt: task.lastFiredAt,
    nextFireAt,
    ageDays: Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0,
    stale: cron.isStale(task),
  };
}

function cronEntriesWire(cron: CronRuntime): Record<string, unknown>[] {
  return cron.list().map((task) => cronEntryWire(cron, task));
}

function isBudgetUnit(unit: string): unit is (typeof BUDGET_UNITS)[number] {
  return (BUDGET_UNITS as readonly string[]).includes(unit);
}

function budgetLimitsFromWire(
  value: number,
  unit: (typeof BUDGET_UNITS)[number],
): GoalBudgetLimits | null {
  switch (unit) {
    case 'turns':
      return { turnBudget: Math.max(1, Math.round(value)) };
    case 'tokens':
      return { tokenBudget: Math.max(1, Math.round(value)) };
    case 'milliseconds':
    case 'seconds':
    case 'minutes':
    case 'hours': {
      const wallClockBudgetMs = Math.round(toMilliseconds(value, unit));
      if (
        wallClockBudgetMs < MIN_REASONABLE_TIME_BUDGET_MS ||
        wallClockBudgetMs > MAX_REASONABLE_TIME_BUDGET_MS
      ) {
        return null;
      }
      return { wallClockBudgetMs };
    }
  }
}

function toMilliseconds(
  value: number,
  unit: 'milliseconds' | 'seconds' | 'minutes' | 'hours',
): number {
  switch (unit) {
    case 'milliseconds':
      return value;
    case 'seconds':
      return value * 1000;
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
  }
}

function formatBudgetWire(value: number, unit: (typeof BUDGET_UNITS)[number]): string {
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(value)} ${value === 1 ? singular : unit}`;
}

function isCancelledQuestionResult(
  result: QuestionResult,
): result is { readonly cancelled: true; readonly reason: string } {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as { readonly cancelled?: unknown; readonly reason?: unknown };
  return candidate.cancelled === true && typeof candidate.reason === 'string';
}

function isQuestionResponse(result: Exclude<QuestionResult, null>): result is QuestionResponse {
  if (typeof result !== 'object' || result === null) return false;
  if (!Object.hasOwn(result, 'answers')) return false;
  const answers = (result as { readonly answers?: unknown }).answers;
  return typeof answers === 'object' && answers !== null && !Array.isArray(answers);
}

function mapQuestionAnswers(answers: QuestionAnswers): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [question, answer] of Object.entries(answers)) {
    mapped[question] = typeof answer === 'string' ? answer : String(answer);
  }
  return mapped;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

type MutableStep = {
  -readonly [K in keyof Step]: Step[K];
} & {
  controller?: AbortController;
  resultControl?: ReturnType<typeof createControlledPromise<StepResult>>;
};

interface TurnJob {
  readonly request: StepRequest;
  readonly seed: TurnSeed;
  readonly controller: AbortController;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly queue: StepRequestQueue;
  readonly steps: Map<string, MutableStep>;
  readonly turn: MutableTurn;
}

interface HeldAdmission {
  readonly request: StepRequest;
  readonly options?: StepEnqueueOptions;
}

interface LoopRuntime {
  readonly turnId: number;
  readonly turnSignal: AbortSignal;
  readonly job: TurnJob | undefined;
  readonly queue: StepRequestQueue;
  steps: number;
  lastStopReason: FinishReason | undefined;
  current: StepRuntime | undefined;
}

interface StepRuntime {
  readonly number: number;
  readonly uuid: string;
  readonly batch: StepRequestBatch;
  readonly mutableStep: MutableStep | undefined;
  readonly signal: AbortSignal;
}

type BeginStepResult = { readonly step: StepRuntime } | { readonly result: LoopRunResult };

interface StreamPartCollector {
  readonly handle: (part: StreamedMessagePart) => void;
  drainInterruptedContent(): ContentPart[];
}

function cancelReasonFor(cancellation: unknown): 'user_cancelled' | 'aborted' {
  return isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted';
}

function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptReason {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}

type StepExecutionResult = {
  readonly stopReason: FinishReason;
  readonly hookStopTurn: boolean;
};

type LoopErrorDisposition =
  | { readonly type: 'continue' }
  | { readonly type: 'return'; readonly result: LoopRunResult };

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  ScopeActivation.OnScopeCreated,
  'loop',
);
