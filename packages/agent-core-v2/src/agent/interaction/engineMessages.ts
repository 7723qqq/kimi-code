export const GoalPauseReason = {
  RATE_LIMIT: 'Paused after provider rate limit',
  PROVIDER_CONNECTION: 'Paused after provider connection error',
  PROVIDER_AUTH: 'Paused after provider authentication error',
  PROVIDER_API: 'Paused after provider API error',
  MODEL_CONFIG: 'Paused after model configuration error',
  RUNTIME: 'Paused after runtime error',
  CONTINUATION_FAILURE: 'Paused after goal continuation failure',
  PROVIDER_FILTERED: 'Paused after provider safety policy block',
  INTERRUPTION: 'Paused after interruption',
} as const;

export type GoalPauseReason = (typeof GoalPauseReason)[keyof typeof GoalPauseReason];

export const GOAL_PAUSE_REASONS_WITH_DETAIL: ReadonlyArray<string> = [
  GoalPauseReason.PROVIDER_CONNECTION,
  GoalPauseReason.PROVIDER_AUTH,
  GoalPauseReason.PROVIDER_API,
  GoalPauseReason.MODEL_CONFIG,
  GoalPauseReason.RUNTIME,
  GoalPauseReason.CONTINUATION_FAILURE,
];

export function goalPauseReasonWithDetail(reason: string, detail: string): string {
  return `${reason}: ${detail}`;
}

export function isGoalPauseReason(reason: string | undefined): boolean {
  return reason !== undefined && reason.startsWith('Paused ');
}

export const SUBAGENT_CANCELLATION_MESSAGES: ReadonlyArray<string> = [
  'Aborted by the user',
  'The user manually interrupted this subagent batch.',
  'The user manually interrupted this subagent batch before this subagent finished.',
  'The user manually interrupted this subagent batch before this subagent was started.',
];

export function isSubagentCancellationMessage(output: string): boolean {
  const trimmed = output.trim();
  return SUBAGENT_CANCELLATION_MESSAGES.some((message) => message === trimmed);
}
