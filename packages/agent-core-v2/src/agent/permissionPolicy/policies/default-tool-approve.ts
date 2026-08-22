import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { GITHUB_READONLY_TOOL_NAMES } from '#/agent/tools/github/github-tools';

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'WaitFor',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'select_tools',
  ...GITHUB_READONLY_TOOL_NAMES,
]);

export class DefaultToolApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return DEFAULT_APPROVE_TOOLS.has(context.toolCall.name) ? { kind: 'approve' } : undefined;
  }
}
