import { createDecorator } from "#/_base/di";
import type {
  ResolvedToolExecutionHookContext
} from '#/loop';
import type { PermissionGateOptions } from '#/permission';
import type { PermissionPolicyResult } from './types';


export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface IPermissionPolicyService {
  readonly _serviceBrand: undefined;
  configure(options: PermissionGateOptions): void;
  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
}

export const IPermissionPolicyService =
  createDecorator<IPermissionPolicyService>('agentPermissionPolicyService');
