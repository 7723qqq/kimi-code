/**
 * Approval adapter (W8.1 / Chain 5).
 *
 * Bridges two representations of the same approval interaction:
 *
 *   1. **In-process SDK shape** (agent-core, camelCase) — what `BridgeClientAPI`
 *      sees coming off `KimiCore.requestApproval(...)`. See
 *      `packages/agent-core/src/rpc/sdk-api.ts:17-23`:
 *        `ApprovalRequest { turnId?, toolCallId, toolName, action, display }`
 *      and `ApprovalResponse { decision, scope?, feedback?, selectedLabel? }`.
 *
 *   2. **Protocol wire shape** (snake_case, with daemon-allocated metadata) —
 *      what the daemon broadcasts as `event.approval.requested` and what the
 *      REST resolve handler receives as request body. See SCHEMAS.md §6.1 and
 *      `packages/protocol/src/approval.ts`.
 *
 * **Field translations**:
 *
 *     SDK (camelCase) → Protocol (snake_case)
 *     ----------------------------------------
 *     toolCallId      → tool_call_id
 *     toolName        → tool_name
 *     turnId          → turn_id          (optional)
 *     display         → tool_input_display  (passthrough — 12-arm union)
 *     selectedLabel   → selected_label   (response side)
 *
 * The `tool_input_display` field is passed through verbatim — SCHEMAS §6.1
 * mandates 12-arm passthrough with `generic.summary` fall-back rendering on
 * the client. We don't structurally validate it.
 *
 * **Anti-corruption**: this is the ONLY place protocol↔SDK shape translation
 * happens for approval. Daemon routes call `toBrokerRequest` indirectly via
 * the bridge (KimiCore → BridgeClientAPI.requestApproval → broker.request),
 * and `toAgentCoreResponse` from the REST resolve handler.
 */

import type {
  ApprovalRequest as InProcessApprovalRequest,
  ApprovalResponse as InProcessApprovalResponse,
} from '@moonshot-ai/agent-core';
import type {
  ApprovalRequest as ProtocolApprovalRequest,
  ApprovalResponse as ProtocolApprovalResponse,
} from '@moonshot-ai/protocol';

export interface ToBrokerRequestParams {
  /** Daemon-minted ULID identifying this approval interaction. */
  readonly approvalId: string;
  /** Session the approval lives in. */
  readonly sessionId: string;
  /** `createdAt` ISO string; broker passes a fresh `new Date().toISOString()`. */
  readonly createdAt: string;
  /** `expiresAt` ISO string; broker computes `createdAt + 60s`. */
  readonly expiresAt: string;
}

/**
 * In-process SDK request + daemon-allocated metadata → protocol wire shape.
 *
 * Used by the daemon broker to build the WS `event.approval.requested`
 * payload before broadcasting.
 *
 * `req` may carry extra context fields (`sessionId`, `agentId`) appended by
 * the bridge — we read `sessionId` from `params.sessionId` (the authoritative
 * daemon-side source) and ignore any duplicate on the request.
 */
export function toBrokerRequest(
  req: InProcessApprovalRequest,
  params: ToBrokerRequestParams,
): ProtocolApprovalRequest {
  return {
    approval_id: params.approvalId,
    session_id: params.sessionId,
    turn_id: req.turnId,
    tool_call_id: req.toolCallId,
    tool_name: req.toolName,
    action: req.action,
    // Passthrough — SCHEMAS §6.1 mandates 12-arm union preservation with
    // `generic.summary` fall-back rendering on the client.
    tool_input_display: req.display,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

/**
 * Protocol REST request body → in-process SDK response.
 *
 * Used by the REST resolve handler to settle the agent-side Promise.
 */
export function toAgentCoreResponse(
  resp: ProtocolApprovalResponse,
): InProcessApprovalResponse {
  return {
    decision: resp.decision,
    scope: resp.scope,
    feedback: resp.feedback,
    selectedLabel: resp.selected_label,
  };
}
