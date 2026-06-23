import type { ApprovalResponse } from '../../../agent/permission';
import { createDecorator } from '../../../di';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '../../../loop';
import type { PermissionServiceOptions } from '../permission/permission';

export type PermissionPolicyResolution =
  | PermissionPolicyResult
  | ({ readonly kind: 'result' } & AuthorizeToolExecutionResult);

export type PermissionPolicyResult =
  | {
      readonly kind: 'approve';
      readonly executionMetadata?: unknown;
    }
  | {
      readonly kind: 'deny';
      readonly message?: string;
    }
  | {
      readonly kind: 'ask';
      readonly resolveApproval?: (
        result: ApprovalResponse,
      ) => PermissionPolicyResolution | undefined;
      readonly resolveError?: (error: unknown) => PermissionPolicyResolution | undefined;
    };

export interface PermissionPolicy {
  readonly name: string;
  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}

export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface IPermissionPolicyService {
  readonly _serviceBrand: undefined;
  configure(options: PermissionServiceOptions): void;
  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPermissionPolicyService =
  createDecorator<IPermissionPolicyService>('agentPermissionPolicyService');
