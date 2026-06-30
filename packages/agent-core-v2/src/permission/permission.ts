import type {
  PermissionData,
} from '#/permissionPolicy';
import { createDecorator } from "#/_base/di";
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/tool';

export interface PermissionGateOptions {
  readonly agentId?: string;
  readonly agentType?: 'main' | 'sub';
}

export interface IPermissionGate {
  readonly _serviceBrand: undefined;
  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined>;
}

export const IPermissionGate =
  createDecorator<IPermissionGate>('agentPermissionGate');
