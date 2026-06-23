import { randomUUID } from 'node:crypto';

import { registerSingleton, SyncDescriptor } from '../../../di';
import { OrderedHookSlot } from '../hooks';
import { ILoopService } from '../loop/loop';
import type { Turn, TurnResult, TurnStepContext } from '../types';
import { IUsageService } from '../usage/usage';
import { ITurnRunner } from './turnRunner';

export class TurnRunnerService implements ITurnRunner {
  private activeTurn: Turn | undefined;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    beforeStep: new OrderedHookSlot<TurnStepContext>(),
    afterStep: new OrderedHookSlot<TurnStepContext>(),
  };

  constructor(
    @ILoopService private readonly loop: ILoopService,
    @IUsageService private readonly usage: IUsageService,
  ) {}

  launch(): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: randomUUID(),
      abortController,
      ready: ready.promise,
      result: Promise.resolve({ reason: 'failed' }),
    };
    turn.result = this.runTurn(turn, ready).finally(() => {
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
    });
    this.activeTurn = turn;
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  private async runTurn(
    turn: Turn,
    ready: ControlledPromise<void>,
  ): Promise<TurnResult> {
    let readySettled = false;
    try {
      this.usage.beginTurn();
      if (!readySettled) {
        ready.resolve();
        readySettled = true;
      }
      return await this.loop.runTurn(turn, {
        beforeStep: this.hooks.beforeStep,
        afterStep: this.hooks.afterStep,
      });
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        if (!readySettled) {
          ready.resolve();
        }
        return { reason: 'cancelled', error: turn.abortController.signal.reason };
      }
      if (!readySettled) {
        ready.reject(error);
      }
      return { reason: 'failed', error };
    } finally {
      this.usage.endTurn();
    }
  }
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
