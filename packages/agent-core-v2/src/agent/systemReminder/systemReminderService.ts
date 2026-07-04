import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ensureMessageId, IAgentContextMemoryService } from '#/agent/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';
import { IAgentContextOpsService } from '#/agent/contextOps';

import { IAgentSystemReminderService } from './systemReminder';

export class AgentSystemReminderService extends Disposable implements IAgentSystemReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextOpsService private readonly contextOps: IAgentContextOpsService,
  ) {
    super();
  }

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage {
    const message: ContextMessage = ensureMessageId({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
        },
      ],
      toolCalls: [],
      origin,
    });
    this.contextOps.append(message);
    return message;
  }

  removeLastReminder(filter: (message: ContextMessage) => boolean): boolean {
    const history = this.context.get();
    const lastIndex = history.length - 1;
    const last = history[lastIndex];
    if (last === undefined || !filter(last)) {
      return false;
    }
    this.contextOps.remove([{ index: lastIndex, messageId: last.id }]);
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSystemReminderService,
  AgentSystemReminderService,
  InstantiationType.Delayed,
  'systemReminder',
);
