import { registerSingleton, SyncDescriptor } from '../../../di';
import type { PromptOrigin } from '../../../agent/context';
import { toKimiErrorPayload, type KimiErrorPayload } from '../../../errors';
import { userCancellationReason } from '../../../utils/abort';
import { IEventBus } from '../eventBus/eventBus';
import { OrderedHookSlot } from '../hooks';
import { ILoopService } from '../loop/loop';
import { IMicroCompactionService } from '../microCompaction/microCompaction';
import type { Turn, TurnEndedContext, TurnResult, TurnStepContext } from '../types';
import { IUsageService } from '../usage/usage';
import { ITurnRunner } from './turnRunner';

declare module '../types' {
  interface AgentEventMap {
    'turn.before_step': {
      turnId: number;
    };
    'turn.started': {
      turnId: number;
      origin: PromptOrigin;
    };
    'turn.ended': {
      turnId: number;
      reason: TurnResult['reason'];
      error?: KimiErrorPayload;
      durationMs: number;
    };
  }
}

export class TurnRunnerService implements ITurnRunner {
  private nextTurnId = 0;
  private activeTurn: Turn | undefined;
  private readonly readyControllers = new WeakMap<Turn, ControlledPromise<void>>();
  private readonly readySettled = new WeakSet<Turn>();

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    onEnded: new OrderedHookSlot<TurnEndedContext>(),
    beforeStep: new OrderedHookSlot<TurnStepContext>(),
    afterStep: new OrderedHookSlot<TurnStepContext>(),
  };

  constructor(
    @ILoopService private readonly loop: ILoopService,
    @IUsageService private readonly usage: IUsageService,
    @IEventBus private readonly events: IEventBus,
    @IMicroCompactionService _microCompaction: IMicroCompactionService,
  ) {
    this.hooks.beforeStep.register('turn-before-step-event', async (ctx, next) => {
      this.events.emit({ type: 'turn.before_step', turnId: ctx.turn.id });
      await next();
      this.resolveReady(ctx.turn);
    });
  }

  launch(origin: PromptOrigin): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: this.nextTurnId++,
      abortController,
      ready: ready.promise,
      result: Promise.resolve({ reason: 'failed' }),
    };
    this.readyControllers.set(turn, ready);
    void ready.promise.catch(() => undefined);
    this.activeTurn = turn;
    turn.result = this.runTurn(turn, origin);
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  cancel(turnId?: number, reason?: unknown): void {
    const turn = this.activeTurn;
    if (turn === undefined) return;
    if (turnId !== undefined && turn.id !== turnId) return;
    turn.abortController.abort(reason ?? userCancellationReason());
  }

  private async runTurn(turn: Turn, origin: PromptOrigin): Promise<TurnResult> {
    const startedAt = Date.now();
    let result: TurnResult | undefined;
    try {
      this.usage.beginTurn();
      this.events.emit({ type: 'turn.started', turnId: turn.id, origin });
      result = await this.loop.runTurn(turn, {
        beforeStep: this.hooks.beforeStep,
        afterStep: this.hooks.afterStep,
      });
      return result;
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        result = { reason: 'cancelled', error: turn.abortController.signal.reason };
        this.rejectReady(turn, turn.abortController.signal.reason);
        return result;
      }
      this.rejectReady(turn, error);
      result = { reason: 'failed', error };
      return result;
    } finally {
      if (result !== undefined) {
        this.rejectReady(turn, result);
      }
      this.usage.endTurn();
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (result !== undefined) {
        this.events.emit(toTurnEndedEvent(turn, result, Date.now() - startedAt));
      }
      if (result !== undefined) {
        await this.hooks.onEnded.run({ turn, result });
      }
    }
  }

  private resolveReady(turn: Turn): void {
    if (this.readySettled.has(turn)) return;
    this.readySettled.add(turn);
    this.readyControllers.get(turn)?.resolve();
  }

  private rejectReady(turn: Turn, reason: unknown): void {
    if (this.readySettled.has(turn)) return;
    this.readySettled.add(turn);
    this.readyControllers.get(turn)?.reject(reason);
  }
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
    error: toKimiErrorPayload(result.error),
    durationMs,
  };
}

interface ControlledPromise<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

function createControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

registerSingleton(ITurnRunner, new SyncDescriptor(TurnRunnerService, [], true));
