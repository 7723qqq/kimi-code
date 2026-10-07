import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { GOAL_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { IAgentGoalService } from '#/features/goal/goalService';
import { goalResultForModel } from '#/features/goal/tools/serialize';
import { toInputJsonSchema } from '#/tool/input-schema';
import { type ToolExecution } from '#/tool/toolContract';

import { GetGoalToolInputSchema, IGetGoalTool, type GetGoalToolInput } from './get-goal';
import DESCRIPTION from './get-goal.md?raw';

export class GetGoalTool implements IGetGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'GetGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetGoalToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(_args: GetGoalToolInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, GOAL_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    return {
      description: 'Reading the current goal',
      approvalRule: this.name,
      execute: async () => {
        const result = this.goal.getGoal();
        return { output: JSON.stringify(goalResultForModel(result), null, 2) };
      },
    };
  }
}
