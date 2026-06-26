import { createDecorator } from "#/_base/di";

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface ISwarmService {
  readonly _serviceBrand: undefined;
  readonly isActive: boolean;
  enter(trigger: SwarmModeTrigger): void;
  exit(): void;
}

declare module '#/wireRecord' {
  interface WireRecordMap {
    'swarm_mode.enter': {
      trigger: SwarmModeTrigger;
    };
    'swarm_mode.exit': {};
  }

}

export const ISwarmService = createDecorator<ISwarmService>('agentSwarmService');
