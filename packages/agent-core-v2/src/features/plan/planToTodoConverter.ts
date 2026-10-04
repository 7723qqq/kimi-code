import type { AgentContext } from '../../agent/agentContext/agentContext';
import type { IAgentTodoService } from '../todo/todoService';
import type { PlanData } from './plan';
import { parsePlanToTodos } from './parsePlanToTodos';

export type PlanToTodoOutcome =
  | { readonly kind: 'converted'; readonly count: number }
  | { readonly kind: 'skipped'; readonly reason: 'empty-plan' | 'no-structure' | 'existing-todos' | 'no-agent' };

export async function tryConvertPlanToTodos(
  planData: PlanData,
  todo: IAgentTodoService,
  agent: AgentContext | undefined,
): Promise<PlanToTodoOutcome> {
  if (agent === undefined) return { kind: 'skipped', reason: 'no-agent' };
  if (planData === null) return { kind: 'skipped', reason: 'empty-plan' };
  if (planData.content.trim() === '') return { kind: 'skipped', reason: 'empty-plan' };

  const items = parsePlanToTodos(planData.content);
  if (items === null || items.length === 0) {
    return { kind: 'skipped', reason: 'no-structure' };
  }

  const current = todo.get();
  if (current.length > 0) {
    return { kind: 'skipped', reason: 'existing-todos' };
  }

  await todo.replace(items);
  return { kind: 'converted', count: items.length };
}

export function outcomeSkippedReason(
  outcome: PlanToTodoOutcome,
): 'empty-plan' | 'no-structure' | 'existing-todos' | 'no-agent' | undefined {
  return outcome.kind === 'skipped' ? outcome.reason : undefined;
}