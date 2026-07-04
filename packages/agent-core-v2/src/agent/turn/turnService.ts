import { createControlledPromise } from '@antfu/utils';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';
import { IAgentContextMemoryService, USER_PROMPT_ORIGIN } from '#/agent/contextMemory';
import { OrderedHookSlot } from '#/hooks';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentTelemetryContextService, ITelemetryService } from '#/app/telemetry';
import { IAgentRecordService } from '#/agent/record';
import type {
  Turn,
  TurnEndedContext,
  TurnUserPromptSubmitContext,
  TurnResult,
} from './turn';
import { IAgentTurnService } from './turn';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'turn.launch': {
      turnId: number;
      origin: PromptOrigin;
      promptMessageId?: string;
    };
  }
}

export class AgentTurnService implements IAgentTurnService {
  declare readonly _serviceBrand: undefined;
  private nextTurnId = 0;
  private activeTurn: Turn | undefined;
  private lastEndedReasonValue: TurnResult['reason'] | undefined;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    onWillSubmitUserPrompt: new OrderedHookSlot<TurnUserPromptSubmitContext>(),
    onEnded: new OrderedHookSlot<TurnEndedContext>(),
  };

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
  ) {
    record.define('turn.launch', {
      resume: (r) => {
        this.restoreLaunch(r.turnId);
      },
    });
  }

  launch(origin: PromptOrigin, promptMessageId?: string): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    // A new turn clears the previous `aborted`/`failed` memory (mirrors v1
    // clearing `_abortedTurns` on `turn.started` / `prompt.submitted`).
    this.lastEndedReasonValue = undefined;

    const turnId = this.nextTurnId;
    this.record.append({ type: 'turn.launch', turnId, origin, promptMessageId });
    this.restoreLaunch(turnId);
    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: turnId,
      promptMessageId,
      abortController,
      ready,
      result: Promise.resolve({ reason: 'failed' }),
    };
    void ready.catch(() => undefined);
    this.activeTurn = turn;
    turn.result = this.runTurn(turn, origin, ready);
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  lastEndedReason(): TurnResult['reason'] | undefined {
    return this.lastEndedReasonValue;
  }

  private async runTurn(
    turn: Turn,
    origin: PromptOrigin,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const turnTelemetry = this.telemetry.withContext(this.telemetryContext.get());
    let result: TurnResult | undefined;
    try {
      turnTelemetry.track('turn_started');
      this.record.signal({
        type: 'turn.started',
        turnId: turn.id,
        origin,
        promptMessageId: turn.promptMessageId,
      });
      const promptHookResult = await this.applyUserPromptHook(turn, origin);
      if (promptHookResult !== undefined) {
        result = promptHookResult;
        return result;
      }
      result = await this.loop.runTurn(turn.id, {
        signal: turn.abortController.signal,
        onStepStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        result = { reason: 'cancelled', error: turn.abortController.signal.reason };
        return result;
      }
      result = { reason: 'failed', error };
      return result;
    } finally {
      ready.reject(createTurnReadyError(result));
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (result !== undefined) {
        this.lastEndedReasonValue = result.reason;
        const ended = toTurnEndedEvent(turn, result, Date.now() - startedAt);
        this.record.signal(ended);
        if (ended.error !== undefined) {
          this.record.signal({ type: 'error', ...ended.error });
        }
        if (ended.reason !== 'completed') {
          turnTelemetry.track('turn_interrupted', { at_step: result.steps ?? 0 });
        }
      }
      if (result !== undefined) {
        await this.hooks.onEnded.run({ turn, result });
      }
    }
  }

  private restoreLaunch(turnId: number): void {
    if (Number.isInteger(turnId) && turnId >= this.nextTurnId) {
      this.nextTurnId = turnId + 1;
    }
  }

  private async applyUserPromptHook(
    turn: Turn,
    origin: PromptOrigin,
  ): Promise<TurnResult | undefined> {
    if (origin.kind !== 'user') return undefined;
    const promptMessage = this.context.get().at(-1);
    if (!shouldRunUserPromptHook(promptMessage)) return undefined;

    const hookContext: TurnUserPromptSubmitContext = { turn, promptMessage };
    await this.hooks.onWillSubmitUserPrompt.run(hookContext);
    const hookResult = hookContext.decision;
    if (hookResult?.action === 'block') {
      this.append({
        role: 'assistant',
        content: [{ type: 'text', text: hookResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: hookResult.event, blocked: true },
      });
      this.record.signal({
        type: 'hook.result',
        turnId: turn.id,
        hookEvent: hookResult.event,
        content: hookResult.message,
        blocked: true,
      });
      return { reason: 'blocked' };
    }

    if (hookResult?.action === 'append') {
      this.append({
        role: 'user',
        content: [{ type: 'text', text: hookResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: hookResult.event },
      });
      this.record.signal({
        type: 'hook.result',
        turnId: turn.id,
        hookEvent: hookResult.event,
        content: hookResult.message,
      });
    }
    return undefined;
  }

  private append(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.context.splice(this.context.get().length, 0, messages);
  }

}

function shouldRunUserPromptHook(message: ContextMessage | undefined): message is ContextMessage {
  if (message === undefined || message.role !== 'user') return false;
  return (message.origin ?? USER_PROMPT_ORIGIN).kind === 'user';
}

function toTurnEndedEvent(
  turn: Turn,
  result: TurnResult,
  durationMs: number,
): {
  type: 'turn.ended';
  turnId: number;
  reason: TurnResult['reason'];
  error?: KimiErrorPayload;
  durationMs: number;
} {
  if (result.reason !== 'failed' || result.error === undefined) {
    return { type: 'turn.ended', turnId: turn.id, reason: result.reason, durationMs };
  }
  return {
    type: 'turn.ended',
    turnId: turn.id,
    reason: result.reason,
    error: summarizeTurnError(result.error, turn.id),
    durationMs,
  };
}

const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

function summarizeTurnError(error: unknown, turnId: number): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  const details = { ...payload.details, turnId };
  // Substitute a friendlier, login-aware message for model-not-configured. The
  // raw "Model not set" / "Provider not set" text is not actionable.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }
  return { ...payload, details };
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

function createTurnReadyError(result: TurnResult | undefined): Error {
  const cause = turnReadyFailureCause(result);
  return cause === undefined
    ? new Error('Turn ended before first step')
    : new Error('Turn ended before first step', { cause });
}

function turnReadyFailureCause(result: TurnResult | undefined): unknown {
  if (result === undefined) return undefined;
  if ('error' in result && result.error !== undefined) return result.error;
  return result.reason;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTurnService,
  AgentTurnService,
  InstantiationType.Delayed,
  'turn',
);
