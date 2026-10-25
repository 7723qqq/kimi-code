import { createDecorator } from '#/_base/di/instantiation';

export type HelloWorldModeTrigger = 'manual' | 'task' | 'tool';

export const HELLO_WORLD_STAGES = [
  'requirements',
  'design',
  'implement',
  'test',
  'review',
  'docs',
  'deliver',
] as const;

export type HelloWorldStage = (typeof HELLO_WORLD_STAGES)[number];

export type HelloWorldRunItemId =
  | 'requirements-approved'
  | 'design-written'
  | 'tasks-complete'
  | 'tests-green'
  | 'review-done'
  | 'docs-updated'
  | 'changeset-ready';

export interface HelloWorldRunItem {
  readonly id: HelloWorldRunItemId;
  readonly done: boolean;
  readonly evidence?: string;
}

export interface HelloWorldRunState {
  readonly stage: HelloWorldStage;
  readonly task?: string;
  readonly items: readonly HelloWorldRunItem[];
  readonly waivers: readonly HelloWorldRunItemId[];
}

export interface IAgentHelloWorldService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  readonly run: HelloWorldRunState | null;
  enter(trigger: HelloWorldModeTrigger, task?: string): void;
  exit(): void;
  advance(stage: HelloWorldStage | 'next'): void;
  waive(item: HelloWorldRunItemId): void;
}

export const IAgentHelloWorldService = createDecorator<IAgentHelloWorldService>(
  'agentHelloWorldService',
);
