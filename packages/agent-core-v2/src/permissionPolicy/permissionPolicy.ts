import { createDecorator } from "#/_base/di";
import type {
  ResolvedToolExecutionHookContext
} from '#/tool';
import type { PermissionPolicyResult } from './types';


export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface IAgentPermissionPolicyService {
  readonly _serviceBrand: undefined;
  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
