import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IContextMemory } from '#/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/contextMemory';

import { ISystemReminderService } from './systemReminder';

export class SystemReminderService extends Disposable implements ISystemReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
  ) {
    super();
  }

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage {
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
        },
      ],
      toolCalls: [],
      origin,
    };
    this.context.splice(this.context.get().length, 0, [message]);
    return message;
  }

  removeLastReminder(filter: (message: ContextMessage) => boolean): boolean {
    const history = this.context.get();
    const lastIndex = history.length - 1;
    const last = history[lastIndex];
    if (last === undefined || !filter(last)) {
      return false;
    }
    this.context.splice(lastIndex, 1, []);
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISystemReminderService,
  SystemReminderService,
  InstantiationType.Delayed,
  'systemReminder',
);
