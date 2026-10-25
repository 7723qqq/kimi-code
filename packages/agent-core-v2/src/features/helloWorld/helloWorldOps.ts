/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { contextMemoryKey, popHelloWorldModeReminder } from '#/agent/contextMemory/contextOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { HelloWorldModeTrigger } from './agent/helloWorld';

const helloWorldModeEnterSchema = z.object({
  agentId: z.string(),
  trigger: z.custom<HelloWorldModeTrigger>(),
});

export class HelloWorldModeEnter extends AgentEvent2<z.infer<typeof helloWorldModeEnterSchema>> {
  static override readonly type = 'hello_world_mode.enter';
  static override readonly durable = true;
  static override readonly schema = helloWorldModeEnterSchema;
}
export interface HelloWorldModeEnter {
  readonly agentId: string;
  readonly trigger: HelloWorldModeTrigger;
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

export const helloWorldKey = defineState(
  'helloWorld',
  (): HelloWorldModeTrigger | null => null,
)
  .replayable({
    schema: z.custom<HelloWorldModeTrigger | null>(),
  })
  .on(HelloWorldModeEnter, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, helloWorldMode: true }));
    return e.trigger;
  })
  .on(HelloWorldModeExit, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, helloWorldMode: false }));
    return null;
  });

contextMemoryKey.on(HelloWorldModeExit, (s) => popHelloWorldModeReminder(s));
