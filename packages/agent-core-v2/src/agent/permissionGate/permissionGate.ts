import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionData,
} from '#/agent/permissionPolicy';
import { createDecorator } from "#/_base/di/instantiation";
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/agent/tool';
import type { Hooks } from '#/hooks';

export type PermissionApprovalRequestContext = ApprovalRequest & {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId: number;
  readonly toolInput: unknown;
};

export type PermissionApprovalResultContext = PermissionApprovalRequestContext &
  (
    | ApprovalResponse
    | {
        readonly decision: 'error';
        readonly error: string;
      }
  );

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;

  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined>;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
