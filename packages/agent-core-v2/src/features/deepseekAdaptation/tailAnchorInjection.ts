import { planTailContract } from '#/agent/tokenCounting/tailAnchor';
import { systemReminderContent } from '#/features/reminder/systemReminder';
import type { ContextInjectionContext } from '#/features/reminder/types';
import { resolveModelFamily } from '#/llm-adapter/contract/modelFamily';

export const TAIL_ANCHOR_INJECTION_VARIANT = 'deepseek_tail_contract';

export const TAIL_ANCHOR_THRESHOLD_TOKENS = 120_000;

export const TAIL_ANCHOR_GOAL = 'finish the latest request in this session';

export const TAIL_ANCHOR_CONSTRAINTS: readonly string[] = [
  're-read the original request before declaring the work finished',
  'keep every explicit requirement until it is done or explicitly deferred',
  'report the command output that proves each claim',
];

export function resolveTailContract(
  injection: ContextInjectionContext,
  wire: string | undefined,
): string | undefined {
  if (wire === undefined) return undefined;
  if (resolveModelFamily(wire)?.id !== 'deepseek') return undefined;
  const lastInjected =
    injection.lastInjection === undefined
      ? undefined
      : (systemReminderContent(injection.lastInjection) ?? '');
  return planTailContract({
    goal: TAIL_ANCHOR_GOAL,
    constraints: TAIL_ANCHOR_CONSTRAINTS,
    estimatedTokens: injection.estimatedTokens ?? 0,
    threshold: TAIL_ANCHOR_THRESHOLD_TOKENS,
    ...(lastInjected === undefined ? {} : { lastInjected }),
  });
}
