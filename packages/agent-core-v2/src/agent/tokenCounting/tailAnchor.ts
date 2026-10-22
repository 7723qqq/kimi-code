export interface TailAnchorInput {
  readonly estimatedTokens: number;
  readonly threshold: number;
  readonly lastAnchorTokens?: number;
}

export function shouldReanchorTail(input: TailAnchorInput): boolean {
  if (input.threshold <= 0) return false;
  const sinceLastAnchor = input.estimatedTokens - (input.lastAnchorTokens ?? 0);
  return sinceLastAnchor >= input.threshold;
}

export const TAIL_CONTRACT_MAX_CHARS = 1200;

export interface TailContractInput {
  readonly goal: string;
  readonly constraints: readonly string[];
}

export interface TailContractPlanInput extends TailAnchorInput, TailContractInput {
  readonly lastInjected?: string;
}

export function renderTailContract(input: TailContractInput): string {
  const lines = [`Objective: ${input.goal.trim()}`];
  if (input.constraints.length > 0) {
    lines.push('Hard constraints:');
    for (const constraint of input.constraints) {
      lines.push(`- ${constraint.trim()}`);
    }
  }
  const text = lines.join('\n').trim();
  return text.length > TAIL_CONTRACT_MAX_CHARS
    ? text.slice(0, TAIL_CONTRACT_MAX_CHARS).trimEnd()
    : text;
}

export function planTailContract(input: TailContractPlanInput): string | undefined {
  if (input.lastInjected !== undefined && input.lastInjected.trim().length > 0) return undefined;
  if (!shouldReanchorTail(input)) return undefined;
  return renderTailContract(input);
}
