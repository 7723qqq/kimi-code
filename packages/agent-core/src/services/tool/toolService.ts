/**
 * `ToolService` — implementation of `IToolService`.
 */

import { Disposable, registerSingleton, SyncDescriptor } from '../../di';

import {
  AgentRuntimeTodoError,
  IAgentRuntimeService,
  toAgentRuntimeService,
  type AgentRuntimeServiceSource,
} from '../agentRuntime/agentRuntime';
import { IToolService, toProtocolTool } from './tool';

/** Matches the convention used elsewhere in services (message-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;
  private readonly agentRuntimes: IAgentRuntimeService;

  constructor(
    @IAgentRuntimeService agentRuntimes: AgentRuntimeServiceSource,
  ) {
    super();
    this.agentRuntimes = toAgentRuntimeService(agentRuntimes);
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    if (sessionId === undefined) {
      throw new AgentRuntimeTodoError(
        'packages/agent-core/src/services/tool/toolService.ts:list',
        'Session-less tool listing has not been migrated; require a session id or define an agent-runtime backed global source.',
      );
    }
    const rpc = await this.agentRuntimes.requireRPC(sessionId, MAIN_AGENT_ID);
    return (await rpc.getTools({})).map((tool) => toProtocolTool(tool));
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(
  IToolService,
  new SyncDescriptor(ToolService, [], true),
);
