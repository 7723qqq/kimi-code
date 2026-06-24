import { createDecorator } from '../../../di';
import type {
  AgentAPI,
} from '../../../rpc/core-api';
import type { PromisableMethods } from '../../../utils/types';

export interface IAgentRPCService extends PromisableMethods<AgentAPI> {}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAgentRPCService =
  createDecorator<IAgentRPCService>('agentRPCService');
