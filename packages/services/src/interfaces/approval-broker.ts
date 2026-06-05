/**
 * Reverse-RPC broker: routes `ApprovalRequest`s coming out of `KimiCore` to a
 * waiter (web client over WS in P1.x, mock handler in tests) and resolves the
 * promise when the response arrives.
 *
 * **Shape note (W3 placeholder):** the broker's `request()` returns the
 * agent-core in-process `ApprovalResponse` (`{ decision, scope?, feedback?,
 * selectedLabel? }`, see `packages/agent-core/src/rpc/sdk-api.ts:10`).
 * SCHEMAS.md §6.1 defines a protocol-level `ApprovalResponse` with the same
 * fields in snake_case (`selected_label`). The protocol↔in-process adapter
 * lives at the daemon/REST boundary (W4+ / Chain 5, see SCHEMAS.md §6.4) —
 * brokers stay on the SDK side. When Chain 5 (W8) ships the protocol Zod
 * validator, this interface stays SDK-shaped; the REST handler adapts.
 *
 * `request()` is the agent-facing entry. `resolve()` is the answer-facing
 * entry — concrete impls keep a `Map<requestId, deferred>` and resolve from
 * REST/WS callbacks. The 60s timeout + queue + WS broadcast are W4/Chain 5.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { ApprovalRequest, ApprovalResponse } from '@moonshot-ai/agent-core';
import type {} from '@moonshot-ai/protocol'; // type-only marker — keep protocol dep referenced

// Re-export ApprovalResponse for service-side consumers so they don't have to
// also depend on agent-core directly.
export type { ApprovalRequest, ApprovalResponse };

export interface IApprovalBroker {
  /**
   * Called by the bridge when KimiCore needs user approval. Resolves with the
   * user's decision (or a cancelled response if no client is connected /
   * timeout elapses — concrete-impl policy).
   */
  request(req: ApprovalRequest & { sessionId: string; agentId: string }): Promise<ApprovalResponse>;

  /**
   * Called by the answer-side (REST handler / TUI / mock) to settle a pending
   * `request()` promise. `id` matches `ApprovalRequest.toolCallId` (PLAN D4 —
   * the toolCallId is the stable correlation key; W4 may add a separate
   * `request_id` if the prefix harmonization decides so).
   */
  resolve(id: string, response: ApprovalResponse): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IApprovalBroker = createDecorator<IApprovalBroker>('IApprovalBroker');
