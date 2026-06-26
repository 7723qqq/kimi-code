import type {
  PermissionData,
  PermissionMode,
} from '#/permissionPolicy';
import { createDecorator } from "#/_base/di";
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/loop';
import type { PathClass } from '#/_base/tools/policies/path-access';

export interface PermissionPlanModeState {
  readonly isActive: boolean;
  readonly planFilePath: string | null;
  exit(id?: string): void;
}

export interface PermissionSwarmModeState {
  readonly isActive: boolean;
}

export interface PermissionGitWorkTreeMarker {
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export interface PermissionGateOptions {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly agentType?: 'main' | 'sub';
  readonly cwd?: string;
  readonly additionalDirs?: readonly string[];
  readonly pathClass?: PathClass;
  readonly planMode?: PermissionPlanModeState;
  readonly swarmMode?: PermissionSwarmModeState;
  readonly gitWorkTreeMarker?: (
    cwd: string,
  ) => Promise<PermissionGitWorkTreeMarker | null> | PermissionGitWorkTreeMarker | null;
  readonly initialMode?: PermissionMode;
}

export interface IPermissionGate {
  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined>;
}

export const IPermissionGate =
  createDecorator<IPermissionGate>('agentPermissionGate');
