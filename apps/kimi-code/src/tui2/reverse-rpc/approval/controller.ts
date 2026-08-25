/**
 * Approval reverse RPC controller.
 *
 * Mirrors `tui/reverse-rpc/approval/controller.ts`. Handles queued approval
 * requests and inherits session-scoped approvals onto matching queued
 * requests without re-prompting the user. Pure logic.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import type { ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { ReverseRpcController } from '../base-controller';
import type { ApprovalPanelData } from '../types';

export class ApprovalController extends ReverseRpcController<ApprovalPanelData, ApprovalResponse> {
  protected createCancelResponse(reason: string): ApprovalResponse {
    return { decision: 'cancelled', feedback: reason };
  }

  protected override autoResolveFor(
    resolvedPayload: ApprovalPanelData,
    response: ApprovalResponse,
    queuedPayload: ApprovalPanelData,
  ): ApprovalResponse | undefined {
    if (response.decision !== 'approved') return undefined;
    if (response.scope !== 'session') return undefined;
    if (resolvedPayload.action !== queuedPayload.action) return undefined;
    // Inherit the session-scoped approval. Drop `feedback` and
    // `selectedLabel` — those described the user's interaction with the
    // first request only and would be misleading on auto-resolved ones.
    return { decision: 'approved', scope: 'session' };
  }
}
