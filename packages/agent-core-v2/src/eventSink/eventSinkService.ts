import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  Disposable,
} from "#/_base/di";
import { Emitter } from "#/_base/event";

import { IAgentWireRecordService } from '#/wireRecord';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { IAgentEventSinkService } from './eventSink';

export class AgentEventSinkService extends Disposable implements IAgentEventSinkService {
  declare readonly _serviceBrand: undefined;
  private readonly onDidEmitEmitter = this._register(new Emitter<AgentEvent>());

  constructor(@IAgentWireRecordService private readonly wireRecord: IAgentWireRecordService) {
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
  IAgentEventSinkService,
  AgentEventSinkService,
  InstantiationType.Delayed,
  'eventSink',
);
