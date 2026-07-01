import type { ResolvedToolExecutionHookContext } from '#/agent/tool';
import { isWithinWorkspace } from '#/_base/tools/policies/path-access';
import { IKaos } from '#/app/kaos';
import type { IKaos as KaosService } from '#/app/kaos';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import {
  findLocalGitWorkTreeMarker,
  writeFileAccesses,
} from './path-utils';

export class GitCwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(
    @IKaos private readonly kaos: KaosService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    if (this.kaos.pathClass() !== 'posix') return undefined;

    const cwd = this.workspace.workDir;
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.workspace.additionalDirs },
          'posix',
        ),
      )
    ) {
      return undefined;
    }

    return (await findLocalGitWorkTreeMarker(cwd)) === null
      ? undefined
      : { kind: 'approve' };
  }
}
