import {
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
} from '@moonshot-ai/agent-core-v2';

export function notifyResultState(output: unknown): 'displayed' | 'suppressed' | undefined {
  if (output === NOTIFY_USER_DELIVERED_OUTPUT) return 'displayed';
  if (output === NOTIFY_USER_SUPPRESSED_OUTPUT) return 'suppressed';
  return undefined;
}
