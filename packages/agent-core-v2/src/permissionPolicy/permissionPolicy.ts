import { createDecorator } from "#/_base/di";
import type {
  ResolvedToolExecutionHookContext
} from '#/loop';
import type { PermissionServiceOptions } from '#/permission';
import type { PermissionPolicyResult } from './types';


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

export const IPermissionPolicyService =
  createDecorator<IPermissionPolicyService>('agentPermissionPolicyService');
