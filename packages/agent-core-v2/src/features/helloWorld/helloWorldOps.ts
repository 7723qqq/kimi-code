/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { contextMemoryKey, popHelloWorldModeReminder } from '#/agent/contextMemory/contextOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type {
  HelloWorldModeTrigger,
  HelloWorldRunItem,
  HelloWorldRunItemId,
  HelloWorldRunState,
  HelloWorldStage,
} from './agent/helloWorld';

const helloWorldModeEnterSchema = z.object({
  agentId: z.string(),
  trigger: z.custom<HelloWorldModeTrigger>(),
  task: z.string().optional(),
});

export class HelloWorldModeEnter extends AgentEvent2<z.infer<typeof helloWorldModeEnterSchema>> {
  static override readonly type = 'hello_world_mode.enter';
  static override readonly durable = true;
  static override readonly schema = helloWorldModeEnterSchema;
}
export interface HelloWorldModeEnter {
  readonly agentId: string;
  readonly trigger: HelloWorldModeTrigger;
  readonly task?: string;
}

const helloWorldModeExitSchema = z.object({ agentId: z.string() });

export class HelloWorldModeExit extends AgentEvent2<z.infer<typeof helloWorldModeExitSchema>> {
  static override readonly type = 'hello_world_mode.exit';
  static override readonly durable = true;
  static override readonly schema = helloWorldModeExitSchema;
}
export interface HelloWorldModeExit {
  readonly agentId: string;
}

const helloWorldRunItemSchema = z.object({
  id: z.custom<HelloWorldRunItemId>(),
  done: z.boolean(),
  evidence: z.string().optional(),
});

const helloWorldRunUpdatedSchema = z.object({
  agentId: z.string(),
  stage: z.custom<HelloWorldStage>(),
  task: z.string().optional(),
  items: z.array(helloWorldRunItemSchema).readonly(),
  waivers: z.array(z.custom<HelloWorldRunItemId>()).readonly(),
});

export class HelloWorldRunUpdated extends AgentEvent2<z.infer<typeof helloWorldRunUpdatedSchema>> {
  static override readonly type = 'hello_world_run.updated';
  static override readonly durable = true;
  static override readonly schema = helloWorldRunUpdatedSchema;
}
export interface HelloWorldRunUpdated {
  readonly agentId: string;
  readonly stage: HelloWorldStage;
  readonly task?: string;
  readonly items: readonly HelloWorldRunItem[];
  readonly waivers: readonly HelloWorldRunItemId[];
}

const HELLO_WORLD_RUN_ITEM_IDS: readonly HelloWorldRunItemId[] = [
  'requirements-approved',
  'design-written',
  'tasks-complete',
  'tests-green',
  'review-done',
  'docs-updated',
  'changeset-ready',
];

function createHelloWorldRun(task: string | undefined): HelloWorldRunState {
  return {
    stage: 'requirements',
    task,
    items: HELLO_WORLD_RUN_ITEM_IDS.map((id) => ({ id, done: false })),
    waivers: [],
  };
}

export const helloWorldKey = defineState(
  'helloWorld',
  (): HelloWorldModeTrigger | null => null,
)
  .replayable({
    schema: z.custom<HelloWorldModeTrigger | null>(),
  })
  .on(HelloWorldModeEnter, (_s, e, ctx) => {
    ctx.emit(
      new AgentStatusUpdated({
        agentId: e.agentId,
        helloWorldMode: true,
        helloWorldStage: 'requirements',
      }),
    );
    return e.trigger;
  })
  .on(HelloWorldModeExit, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, helloWorldMode: false }));
    return null;
  });

export const helloWorldRunKey = defineState(
  'helloWorldRun',
  (): HelloWorldRunState | null => null,
)
  .replayable({
    schema: z.custom<HelloWorldRunState | null>(),
  })
  .on(HelloWorldModeEnter, (_s, e) => createHelloWorldRun(e.task))
  .on(HelloWorldRunUpdated, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, helloWorldStage: e.stage }));
    return { stage: e.stage, task: e.task, items: e.items, waivers: e.waivers };
  })
  .on(HelloWorldModeExit, () => null);

contextMemoryKey.on(HelloWorldModeExit, (s) => popHelloWorldModeReminder(s));
