import { IAgentPermissionModeService } from '../../permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';

export class AutoModeApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-approve';

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  evaluate(): PermissionPolicyResult | undefined {
    return this.modeService.mode === 'auto' ? { kind: 'approve' } : undefined;
  }
}
