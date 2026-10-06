/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface SpecState {
  readonly active: boolean;
  readonly id?: string;
  readonly revisionCount?: Readonly<Record<string, number>>;
}

const specModeEnterSchema = z.object({ agentId: z.string(), id: z.string() });

export class SpecModeEnter extends AgentEvent2<z.infer<typeof specModeEnterSchema>> {
  static override readonly type = 'spec_mode.enter';
  static override readonly durable = true;
  static override readonly schema = specModeEnterSchema;
}
export interface SpecModeEnter {
  readonly agentId: string;
  readonly id: string;
}

const specModeCancelSchema = z.object({
  agentId: z.string(),
  id: z.string().optional(),
});

export class SpecModeCancel extends AgentEvent2<z.infer<typeof specModeCancelSchema>> {
  static override readonly type = 'spec_mode.cancel';
  static override readonly durable = true;
  static override readonly schema = specModeCancelSchema;
}
export interface SpecModeCancel {
  readonly agentId: string;
  readonly id?: string;
}

const specModeExitSchema = z.object({
  agentId: z.string(),
  id: z.string().optional(),
});

export class SpecModeExit extends AgentEvent2<z.infer<typeof specModeExitSchema>> {
  static override readonly type = 'spec_mode.exit';
  static override readonly durable = true;
  static override readonly schema = specModeExitSchema;
}
export interface SpecModeExit {
  readonly agentId: string;
  readonly id?: string;
}

export interface SpecRevisionRecordedEvent {
  readonly agentId: string;
  readonly id: string;
  readonly version: number;
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
}

const specRevisionSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  version: z.number(),
  key: z.string(),
  sha256: z.string(),
  bytes: z.number(),
});

export class SpecRevision extends AgentEvent2<SpecRevisionRecordedEvent> {
  static override readonly type = 'spec.revision';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = specRevisionSchema;
}
export interface SpecRevision extends SpecRevisionRecordedEvent {}

export const specKey = defineState('spec', (): SpecState => ({ active: false }))
  .replayable({ schema: z.custom<SpecState>() })
  .undoable()
  .on(SpecModeEnter, (s, e, ctx) => {
    if (!(s.active && s.id === e.id)) {
      s.active = true;
      s.id = e.id;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, specMode: true }));
  })
  .on(SpecModeCancel, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
      delete s.id;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, specMode: false }));
  })
  .on(SpecModeExit, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
      delete s.id;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, specMode: false }));
  })
  .on(SpecRevision, (s, e) => {
    s.revisionCount = { ...s.revisionCount, [e.id]: e.version };
  });
