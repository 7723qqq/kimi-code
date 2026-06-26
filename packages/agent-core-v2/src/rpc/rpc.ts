import { createDecorator } from "#/_base/di";
import type {
  AgentAPI,
  SessionAPI,
} from './core-api';
import type { PromisableMethods } from "#/_base/utils/types";

export interface IAgentRPCService extends PromisableMethods<AgentAPI> {}

export interface ISessionRPCService extends PromisableMethods<SessionAPI> {}

export const IAgentRPCService =
  createDecorator<IAgentRPCService>('agentRPCService');

export const ISessionRPCService =
  createDecorator<ISessionRPCService>('agentSessionRPCService');
