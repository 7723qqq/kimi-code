import { isPlainRecord } from '#/_base/utils/canonical-args';
import type { ResolvedToolExecutionHookContext } from '#/loop';
import { IExternalHooksService } from '../../externalHooks/externalHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';

export class PreToolCallHookPermissionPolicyService implements PermissionPolicy {
  readonly name = 'pre-tool-call-hook';

  constructor(
    @IExternalHooksService private readonly externalHooks: IExternalHooksService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const reason = await this.externalHooks.triggerPreToolUse(
      {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      },
      context.signal,
    );
    if (reason === undefined) return undefined;
    return { kind: 'deny', message: reason };
  }
}
