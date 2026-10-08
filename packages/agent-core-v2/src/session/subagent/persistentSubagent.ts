import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TokenUsage } from '#human/llm/usage';

export interface PersistentSubagentSpawnOptions {

  readonly profileName: string;

  readonly prompt: string;

  readonly description: string;

  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
}

export interface PersistentSubagentHost {
  spawnPersistent(options: PersistentSubagentSpawnOptions): Promise<string>;
  runDiscussionTurn(agentId: string, prompt: string, signal: AbortSignal): Promise<string>;
  getPersistentUsage(agentId: string): TokenUsage | undefined;
  destroyPersistent(agentId: string): Promise<void>;
}

export interface IPersistentSubagentService {
  readonly _serviceBrand: undefined;

  bind(callerAgentId: string): PersistentSubagentHost;
}

export const IPersistentSubagentService: ServiceIdentifier<IPersistentSubagentService> =
  createDecorator<IPersistentSubagentService>('persistentSubagentService');
