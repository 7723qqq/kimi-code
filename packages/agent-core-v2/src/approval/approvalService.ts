/**
 * `approval` domain (L7) — `IApprovalService` implementation.
 *
 * Owns the pending-approval set and resolves requests when a decision arrives.
 * Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  IApprovalService,
} from './approval';

interface Pending {
  readonly req: ApprovalRequest;
  readonly resolve: (decision: ApprovalResponse) => void;
}

export class ApprovalService implements IApprovalService {
  declare readonly _serviceBrand: undefined;
  private readonly pending = new Map<string, Pending>();

  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve) => {
      this.pending.set(requestId(req), { req, resolve });
    });
  }

  decide(id: string, response: ApprovalResponse): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.resolve(response);
  }

  listPending(): readonly ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }
}

function requestId(req: ApprovalRequest): string {
  return req.id ?? req.toolCallId ?? `${req.toolName}:${String(Date.now())}`;
}

registerScopedService(LifecycleScope.Session, IApprovalService, ApprovalService, InstantiationType.Delayed, 'approval');
