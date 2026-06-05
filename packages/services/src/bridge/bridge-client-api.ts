/**
 * `BridgeClientAPI` — the SDK side of the in-process RPC pair owned by
 * `HarnessBridge`. Satisfies `SDKAPI` (`@moonshot-ai/agent-core` rpc/sdk-api.ts:78,
 * via `SDKAgentAPI` at :67-72) so `KimiCore` can call into it through
 * `createRPC<CoreAPI, SDKAPI>()`. Methods route to DI-resolved brokers:
 *
 *   emitEvent(event)        → IEventBus.publish(event)
 *   requestApproval(req)    → IApprovalBroker.request(req)
 *   requestQuestion(req)    → IQuestionBroker.request(req)
 *   toolCall(req)           → unsupported (SDK custom tool calls not used here)
 *
 * The protocol↔in-process adapters (SCHEMAS.md §6.4 snake_case shapes, REST
 * request/response Zod validation) live at the daemon REST boundary in
 * Chain 5/6 (W8) — NOT here. The broker interfaces stay SDK-shaped.
 */

import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
  SDKAPI,
  ToolCallRequest,
  ToolCallResponse,
} from '@moonshot-ai/agent-core';

import type { IApprovalBroker } from '../interfaces/approval-broker';
import type { IEventBus } from '../interfaces/event-bus';
import type { IQuestionBroker } from '../interfaces/question-broker';

export interface BridgeClientAPIDeps {
  readonly eventBus: IEventBus;
  readonly approvalBroker: IApprovalBroker;
  readonly questionBroker: IQuestionBroker;
}

export class BridgeClientAPI implements SDKAPI {
  private readonly deps: BridgeClientAPIDeps;

  constructor(deps: BridgeClientAPIDeps) {
    this.deps = deps;
  }

  emitEvent(event: Event): void {
    this.deps.eventBus.publish(event);
  }

  async requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    return this.deps.approvalBroker.request(request);
  }

  async requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    return this.deps.questionBroker.request(request);
  }

  async toolCall(
    request: ToolCallRequest & { sessionId: string; agentId: string },
  ): Promise<ToolCallResponse> {
    // Mirrors `SDKRpcClientBase.toolCall` (packages/node-sdk/src/rpc.ts:577-582)
    // — daemon's bridge does not expose SDK-side custom tool calls; the agent
    // gets an error result it can surface upstream.
    return {
      output: `SDK custom tool calls are not supported in the daemon bridge: ${request.toolCallId}`,
      isError: true,
    };
  }
}
