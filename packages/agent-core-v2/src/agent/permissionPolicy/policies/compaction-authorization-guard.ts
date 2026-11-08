import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { PermissionPolicyContext } from '#/agent/permissionPolicy/types';

const IRREVERSIBLE_COMMAND =
  /\b(git\s+push|git\s+merge|git\s+reset\s+--hard|gh\s+pr\s+merge|gh\s+api\b[\s\S]*?-X\s+(PUT|DELETE|PATCH)|branch\s+protection|ruleset|deploy|kubectl\s+delete|rm\s+-rf|DROP\s+(TABLE|DATABASE)|TRUNCATE\b|DELETE\s+FROM)\b/i;

export class CompactionAuthorizationGuardPermissionPolicyService implements PermissionPolicy {
  declare readonly _serviceBrand: undefined;
  readonly name = 'compaction-authorization-guard';

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const compacted = this.context
      .get()
      .some((message) => message.origin?.kind === 'compaction_summary');
    if (!compacted) return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    if (command === undefined || !IRREVERSIBLE_COMMAND.test(command)) return undefined;
    return { kind: 'ask', reason: { compaction_authorization_required: true } };
  }
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}
