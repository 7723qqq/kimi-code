import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type AgentModeName = 'agent' | 'plan' | 'spec' | 'swarm' | 'tower';

export interface IAgentModeMutexService {
  readonly _serviceBrand: undefined;
  activeMode(): AgentModeName;
  switchTo(mode: AgentModeName): Promise<void>;
}

export const IAgentModeMutexService: ServiceIdentifier<IAgentModeMutexService> =
  createDecorator<IAgentModeMutexService>('agentModeMutexService');
