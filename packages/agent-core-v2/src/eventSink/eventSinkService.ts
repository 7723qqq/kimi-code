import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  Disposable,
} from "#/_base/di";
import { Emitter } from "#/_base/event";

import { IWireRecord } from '#/wireRecord';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { IEventSink } from './eventSink';

export class EventSinkService extends Disposable implements IEventSink {
  declare readonly _serviceBrand: undefined;
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
  IEventSink,
  EventSinkService,
  InstantiationType.Delayed,
  'eventSink',
);
