import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  Disposable,
} from "#/_base/di";
import { Emitter } from "#/_base/event";

import { IEventBus } from '#/eventBus';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { IWireRecord } from '#/wireRecord';

export class EventBusService extends Disposable implements IEventBus {
  private readonly onDidEmitEmitter = this._register(new Emitter<AgentEvent>());

  constructor(@IWireRecord private readonly wireRecord: IWireRecord) {
    super();
  }

  emit(event: AgentEvent): void {
    if (this.wireRecord.restoring) return;
    this.onDidEmitEmitter.fire(event);
  }

  on(handler: (event: AgentEvent) => void) {
    return this.onDidEmitEmitter.event(handler);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IEventBus,
  EventBusService,
  InstantiationType.Delayed,
  'eventBus',
);
