/**
 * Approval request handler.
 *
 * Mirrors `tui/reverse-rpc/approval/handler.ts`. Wraps an
 * {@link ApprovalController} in an SDK `ApprovalHandler`: adapts the core
 * payload into view data, shows the panel, and maps the user's response back.
 * Failures degrade to a cancelled response rather than throwing.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/kimi-code-sdk';

import { adaptApprovalRequest } from './adapter';
import type { ApprovalController } from './controller';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
): ApprovalHandler {
  return async (event): Promise<ApprovalResponse> => {
    try {
      const response = await controller.show(adaptApprovalRequest(event));
      onResponse?.(event, response);
      return response;
    } catch {
      const response: ApprovalResponse = {
        decision: 'cancelled',
        feedback: 'approval handler failed',
      };
      onResponse?.(event, response);
      return response;
    }
  };
}
