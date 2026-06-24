import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from '../../../di';
import type { HookEngine } from '../../../session/hooks';

export interface RenderedExternalHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export type UserPromptHookDecision =
  | ({ readonly action: 'append' } & RenderedExternalHookResult)
  | ({ readonly action: 'block' } & RenderedExternalHookResult);

export interface ExternalHooksServiceOptions {
  readonly hookEngine?: Pick<HookEngine, 'trigger' | 'triggerBlock'> | undefined;
}

export interface IExternalHooksService {
  triggerUserPromptSubmit(
    input: readonly ContentPart[],
    signal: AbortSignal,
  ): Promise<UserPromptHookDecision | undefined>;
  triggerStop(signal: AbortSignal, stopHookActive: boolean): Promise<string | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IExternalHooksService =
  createDecorator<IExternalHooksService>('agentExternalHooksService');
