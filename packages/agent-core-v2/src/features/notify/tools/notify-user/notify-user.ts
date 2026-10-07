import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const NOTIFY_USER_TOOL_NAME = 'NotifyUser' as const;

export const NOTIFY_USER_DELIVERED_OUTPUT = 'Update shown to the user.';
export const NOTIFY_USER_SUPPRESSED_OUTPUT =
  'Notifications are disabled; the update was not displayed.';

export interface NotifyUserInput {
  message: string;
}

export const NotifyUserInputSchema: z.ZodType<NotifyUserInput> = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      "The update to show the user: a short intro paragraph followed by a few bullet points of light Markdown, in the user's language, under ~1000 characters.",
    ),
});

export interface INotifyUserTool extends AgentTool<NotifyUserInput> {
  readonly _serviceBrand: undefined;
}
export const INotifyUserTool = createDecorator<INotifyUserTool>('notifyUserTool');
