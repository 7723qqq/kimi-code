import type { Message, UserMessage } from '@moonshot-ai/core/llm/message';
import type { IWireService } from '#/wire/wire';
import { contextFromHistoryEntry } from '#/agent/loop/history';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { AgentTaskService } from './taskService';
import { TERMINAL_STATUSES } from './types';
import { IAgentTaskOutputService } from './taskOutput';

export async function restoreTaskCompletions(options: {
  readonly wire: IWireService;
  readonly agentId: string;
  readonly taskOutputs: IAgentTaskOutputService;
  readonly messages: readonly Message[];
  readonly pending?: readonly Message[];
  readonly isLive?: (taskId: string) => boolean;
}): Promise<readonly UserMessage[]> {
  const { journal, restorable } = await options.wire.readRestoreChains();
  // fork's AgentTaskService has no restore(); journal is replayed through the wire instead.
  void journal;
  const delivered = new Set<string>();
  const recordDelivery = (origin: PromptOrigin | undefined): void => {
    if (origin?.kind === 'task') delivered.add(`${origin.taskId}\0${origin.status}\0${origin.notificationId}`);
  };
  for (const entry of [...options.messages, ...options.pending ?? []]) {
    recordDelivery(contextFromHistoryEntry(entry).origin);
  }
  for (const record of journal) {
    if (record['agentId'] !== undefined && record['agentId'] !== options.agentId) continue;
    if (record.type !== 'context.append_message') continue;
    recordDelivery((record['message'] as ContextMessage | undefined)?.origin);
  }
  for (const record of restorable) {
    if (record.type !== 'task.waitDelivered' || record['agentId'] !== options.agentId) continue;
    const keys = record['keys'];
    if (!Array.isArray(keys)) continue;
    for (const key of keys) {
      if (typeof key === 'string') delivered.add(key);
    }
  }
  const completions: UserMessage[] = [];
  for (const info of (restorable ?? []) as ReadonlyArray<any>) {
    if (!TERMINAL_STATUSES.has(info.status as never)) continue;
    if (info.status === 'lost' && options.isLive?.(info.taskId as string) === true) continue;
    if (info.detached === false || info.terminalNotificationSuppressed === true) continue;
    const notificationId = `task:${info.taskId}:${info.status}`;
    if (delivered.has(`${info.taskId}\0${info.status}\0${notificationId}`)) continue;
    const toolCallId = info.kind === 'question' ? info.toolCallId ?? info.taskId : info.parentToolCallId ?? info.taskId;
    if (toolCallId === undefined) continue;
    completions.push(await options.taskOutputs.createCompletion(info, toolCallId));
  }
  return completions;
}
