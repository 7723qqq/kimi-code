import { createDecorator } from '../../di';
import type { CoreRPC, SessionSummary } from '../../rpc';
import type { AgentRuntime } from '../agent';
import type { IAgentRPCService } from '../agent/rpc/rpc';
import type { ICoreProcessService } from '../coreProcess/coreProcess';

export interface IAgentRuntimeService {
  readonly _serviceBrand: undefined;

  get(sessionId: string, agentId?: string): Promise<AgentRuntime | undefined>;
  require(sessionId: string, agentId?: string): Promise<AgentRuntime>;
  getRPC(sessionId: string, agentId?: string): Promise<IAgentRPCService | undefined>;
  requireRPC(sessionId: string, agentId?: string): Promise<IAgentRPCService>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | undefined>;
  listSessionSummaries(options?: {
    readonly workDir?: string;
    readonly includeArchive?: boolean;
  }): Promise<readonly SessionSummary[]>;
  forget(sessionId: string, agentId?: string): Promise<void>;
}

export const IAgentRuntimeService =
  createDecorator<IAgentRuntimeService>('agentRuntimeService');

export class AgentRuntimeTodoError extends Error {
  constructor(
    readonly location: string,
    readonly logic: string,
  ) {
    super(`TODO: ${location} is not migrated to services/agent. ${logic}`);
    this.name = 'AgentRuntimeTodoError';
  }
}

export type AgentRuntimeServiceSource =
  | IAgentRuntimeService
  | Pick<ICoreProcessService, 'rpc'>;

export function toAgentRuntimeService(
  source: AgentRuntimeServiceSource,
): IAgentRuntimeService {
  if (typeof (source as IAgentRuntimeService).requireRPC === 'function') {
    return source as IAgentRuntimeService;
  }
  return agentRuntimeServiceFromCoreProcess(source as Pick<ICoreProcessService, 'rpc'>);
}

export function agentRuntimeServiceFromCoreProcess(
  core: Pick<ICoreProcessService, 'rpc'>,
): IAgentRuntimeService {
  return {
    _serviceBrand: undefined,
    async get() {
      return undefined;
    },
    async require(sessionId: string, agentId = 'main') {
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/agentRuntime/agentRuntime.ts:require',
        `Runtime for session "${sessionId}" agent "${agentId}" is not available through services/agent.`,
      );
    },
    async getRPC(sessionId: string, agentId = 'main') {
      const summary = await this.getSessionSummary(sessionId);
      return summary === undefined ? undefined : scopedAgentRPC(core.rpc, sessionId, agentId);
    },
    async requireRPC(sessionId: string, agentId = 'main') {
      const rpc = await this.getRPC(sessionId, agentId);
      if (rpc !== undefined) return rpc;
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/agentRuntime/agentRuntime.ts:requireRPC',
        `RPC for session "${sessionId}" agent "${agentId}" is not available through services/agent.`,
      );
    },
    async getSessionSummary(sessionId: string) {
      const all = await core.rpc.listSessions({});
      return all.find((summary) => summary.id === sessionId);
    },
    listSessionSummaries(options = {}) {
      return core.rpc.listSessions(options);
    },
    async forget() {},
  };
}

function scopedAgentRPC(
  core: CoreRPC,
  sessionId: string,
  agentId: string,
): IAgentRPCService {
  return new Proxy({}, {
    get(_target, prop) {
      const method = core[prop as keyof CoreRPC];
      if (typeof method !== 'function') return undefined;
      return (payload: Record<string, unknown> = {}) =>
        method({ ...payload, sessionId, agentId } as never);
    },
  }) as IAgentRPCService;
}
