import { registerSingleton, SyncDescriptor } from '../../../di';

import { IContextMemory } from '../contextMemory/contextMemory';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage, Turn } from '../types';
import { IPromptService } from './prompt';

export class PromptService implements IPromptService {
  private readonly steerQueue: ContextMessage[] = [];
  private observedTurn: Turn | undefined;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @ITurnRunner private readonly turnRunner: ITurnRunner,
  ) {}

  prompt(message: ContextMessage): Turn {
    this.assertNoActiveTurn('prompt');
    this.append(message);
    return this.turnRunner.launch();
  }

  steer(message: ContextMessage): Turn | undefined {
    const activeTurn = this.turnRunner.getActiveTurn();
    if (activeTurn !== undefined) {
      this.steerQueue.push(message);
      this.observe(activeTurn);
      return undefined;
    }

    this.append(message);
    const turn = this.turnRunner.launch();
    this.observe(turn);
    return turn;
  }

  retry(): Turn {
    this.assertNoActiveTurn('retry');
    return this.turnRunner.launch();
  }

  private append(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.context.spliceHistory(this.context.getHistory().length, 0, ...messages);
  }

  private observe(turn: Turn): void {
    if (this.observedTurn === turn) return;
    this.observedTurn = turn;
    void turn.result.finally(() => {
      if (this.observedTurn === turn) {
        this.observedTurn = undefined;
      }
      this.drainSteerQueue();
    });
  }

  private drainSteerQueue(): void {
    if (this.steerQueue.length === 0) return;

    const activeTurn = this.turnRunner.getActiveTurn();
    if (activeTurn !== undefined) {
      this.observe(activeTurn);
      return;
    }

    const messages = this.steerQueue.splice(0);
    this.append(...messages);
    const turn = this.turnRunner.launch();
    this.observe(turn);
  }

  private assertNoActiveTurn(operation: string): void {
    const activeTurn = this.turnRunner.getActiveTurn();
    if (activeTurn === undefined) return;
    throw new Error(`Cannot ${operation} while turn ${activeTurn.id} is active`);
  }
}

registerSingleton(IPromptService, new SyncDescriptor(PromptService, [], true));
