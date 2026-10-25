import { createDecorator } from '#/_base/di/instantiation';

export type HelloWorldModeTrigger = 'manual' | 'task' | 'tool';

export interface IAgentHelloWorldService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: HelloWorldModeTrigger): void;
  exit(): void;
}

export const IAgentHelloWorldService = createDecorator<IAgentHelloWorldService>(
  'agentHelloWorldService',
);
