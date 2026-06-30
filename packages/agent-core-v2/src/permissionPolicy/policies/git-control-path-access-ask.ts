import type { ResolvedToolExecutionHookContext } from '#/tool';
import { IKaos } from '#/kaos';
import type { IKaos as KaosService } from '#/kaos';
import { ISessionWorkspaceContext } from '#/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';
import {
  fileAccesses,
  findLocalGitWorkTreeMarker,
  hasGitPathComponent,
  isGitControlPath,
} from './path-utils';

export class GitControlPathAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(
    @IKaos private readonly kaos: KaosService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.workspace.workDir;
    if (cwd.length === 0) return undefined;
    const pathClass = this.kaos.pathClass();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;

    const directGitAccess = accesses.find((fileAccess) =>
      hasGitPathComponent(fileAccess.path, cwd, pathClass),
    );
    if (directGitAccess !== undefined) return { kind: 'ask' };

    const marker = await findLocalGitWorkTreeMarker(cwd);
    if (marker === null) return undefined;
    const access = accesses.find((fileAccess) =>
      isGitControlPath(fileAccess.path, marker, pathClass),
    );
    return access === undefined ? undefined : { kind: 'ask' };
  }
}
