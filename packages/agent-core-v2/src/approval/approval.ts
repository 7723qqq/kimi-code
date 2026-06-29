/**
 * `approval` domain (L7) — session-scope approval broker.
 *
 * Defines the public contract of approval brokering: the `ApprovalRequest` /
 * `ApprovalDecision` models and the `IApprovalService` used to request a
 * decision, resolve it, and list pending approvals. Session-scoped — one
 * broker per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

export interface ApprovalRequest {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface IApprovalService {
  readonly _serviceBrand: undefined;
  request(req: ApprovalRequest): Promise<ApprovalResponse>;
  /**
   * Submit an approval request without blocking on the decision. Returns the
   * request with its resolved `id`; the decision is delivered through the
   * interaction `onDidResolve` stream.
   */
  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string };
  decide(id: string, response: ApprovalResponse): void;
  listPending(): readonly ApprovalRequest[];
}

export const IApprovalService: ServiceIdentifier<IApprovalService> =
  createDecorator<IApprovalService>('approvalService');
