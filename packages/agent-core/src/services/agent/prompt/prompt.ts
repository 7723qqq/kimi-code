import { createDecorator } from '../../../di';

import type { ContextMessage, Turn } from '../types';

export interface IPromptService {
  prompt(message: ContextMessage): Turn;
  steer(message: ContextMessage): Turn | undefined;
  retry(): Turn;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPromptService = createDecorator<IPromptService>('promptService.agent');
