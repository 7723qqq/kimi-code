import { Disposable, InstantiationType, registerSingleton } from '../../../di';
import { Emitter } from '../../../base/common/event';

import { IEventBus } from './eventBus';
import type { AgentEvent } from '../types';

export class EventBusService extends Disposable implements IEventBus {
  private readonly onDidEmitEmitter = this._register(new Emitter<AgentEvent>());

  emit(event: AgentEvent): void {
    this.onDidEmitEmitter.fire(event);
  }

  on(handler: (event: AgentEvent) => void) {
    return this.onDidEmitEmitter.event(handler);
  }
}

registerSingleton(IEventBus, EventBusService, InstantiationType.Delayed);
