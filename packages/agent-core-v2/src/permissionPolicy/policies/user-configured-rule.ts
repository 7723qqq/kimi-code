import type {
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from '#/permissionRules';
import {
  matchPermissionRule,
  type PermissionRuleMatch,
} from '#/permissionRules';
import type { ResolvedToolExecutionHookContext } from '#/tool';
import type { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type { PermissionPolicyResult } from '../types';
import type { PermissionPolicyRuntime } from './runtime';

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

export function evaluateUserConfiguredRule(
  context: ResolvedToolExecutionHookContext,
  decision: PermissionRuleDecision,
  rulesService: IPermissionRulesService,
  runtime: PermissionPolicyRuntime,
): PermissionPolicyResult | undefined {
  const match = firstMatchingRule(context, decision, rulesService, USER_CONFIGURED_SCOPES);
  if (match === undefined) return undefined;
  if (decision === 'deny') {
    return {
      kind: 'deny',
      message: runtime.formatPermissionRuleDenyMessage(
        context.toolCall.name,
        match.rule.reason,
      ),
    };
  }
  if (decision === 'ask') return { kind: 'ask' };
  return { kind: 'approve' };
}

function firstMatchingRule(
  context: ResolvedToolExecutionHookContext,
  decision: PermissionRuleDecision,
  rulesService: IPermissionRulesService,
  scopes: ReadonlySet<PermissionRuleScope>,
): PermissionRuleMatch | undefined {
  const rules = rulesService.rules.filter((rule): rule is PermissionRule =>
    scopes.has(rule.scope),
  );
  for (const rule of rules) {
    if (rule.decision !== decision) continue;
    const match = matchPermissionRule({
      rule,
      toolName: context.toolCall.name,
      execution: context.execution,
    });
    if (match !== undefined) return match;
  }
  return undefined;
}
