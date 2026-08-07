/**
 * `tools` domain — `ICreateGoalTool` implementation.
 *
 * Resolves a CreateGoal call against the goal service (`goal`): guards
 * against the current goal changing between resolution and execution, then
 * creates the goal and returns its serialized snapshot. The approval display
 * carries a `goal_start` card unless the permission mode (`permissionMode`)
 * is `auto`. Registered for the main agent only, mirroring v1's
 * `agent.type === 'main'` gate. Bound at Agent scope.
 */

import { t } from '@moonshot-ai/kimi-i18n';

import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import { goalForModel } from '#/agent/goal/tools/serialize';

import DESCRIPTION from './create-goal.md?raw';
import {
  CreateGoalToolInputSchema,
  ICreateGoalTool,
  type CreateGoalToolInput,
} from './create-goal';

export class CreateGoalTool implements ICreateGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'CreateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CreateGoalToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
  ) {}

  resolveExecution(args: CreateGoalToolInput): ToolExecution {
    const goalAtResolution = this.goal.getGoal().goal;
    return {
      description: t('toolsV2.goal.creating'),
      display: this.resolveGoalStartDisplay(args),
      approvalRule: this.name,
      execute: async ({ turnId }) => {
        const currentGoal = this.goal.getGoal().goal;
        if (
          currentGoal?.goalId !== goalAtResolution?.goalId &&
          (currentGoal === null || !this.goal.isGoalToolTarget(turnId, currentGoal.goalId))
        ) {
          return { output: t('toolsV2.goal.notCreatedStale') };
        }
        // Reject missing or placeholder completion criteria at the tool boundary
        // so the model is forced to provide a concrete, verifiable check.
        const criterion = args.completionCriterion?.trim();
        if (!criterion || criterion.length < 10) {
          return {
            output:
              'Completion criterion is required and must be at least 10 characters. ' +
              'Provide a concrete, verifiable check — e.g. what test to run, what command should succeed, ' +
              'what condition must hold. If the user\'s request is vague, ask them via AskUserQuestion first.',
          };
        }
        const snapshot = await this.goal.createGoal(
          {
            objective: args.objective,
            completionCriterion: args.completionCriterion,
            replace: args.replace,
          },
          'model',
        );
        return { output: JSON.stringify({ goal: goalForModel(snapshot) }, null, 2) };
      },
    };
  }

  private resolveGoalStartDisplay(args: CreateGoalToolInput): ToolInputDisplay | undefined {
    const mode = this.permissionMode.mode;
    if (mode === 'auto') return undefined;
    return {
      kind: 'goal_start',
      objective: args.objective,
      completionCriterion: args.completionCriterion,
      mode,
    };
  }
}

registerAgentToolService(ICreateGoalTool, CreateGoalTool, {
  name: 'CreateGoal',
  domain: 'goal',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
