import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from '../../../di';
import type { ExecutableToolResult } from '../../../loop';
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
  readonly hookEngine?:
    | Pick<HookEngine, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'>
    | undefined;
}

export interface NotificationHookPayload {
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface IExternalHooksService {
  triggerPreToolUse(
    payload: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
    },
    signal: AbortSignal,
  ): Promise<string | undefined>;
  triggerUserPromptSubmit(
    input: readonly ContentPart[],
    signal: AbortSignal,
  ): Promise<UserPromptHookDecision | undefined>;
  triggerStop(signal: AbortSignal, stopHookActive: boolean): Promise<string | undefined>;
  triggerPostToolUse(
    payload: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
      readonly result: ExecutableToolResult;
    },
    signal: AbortSignal,
  ): Promise<void>;
  triggerStopFailure(error: unknown, signal: AbortSignal): void;
  triggerInterrupt(payload: { readonly turnId: number; readonly reason: 'cancelled' }): void;
  triggerNotification(payload: NotificationHookPayload): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IExternalHooksService =
  createDecorator<IExternalHooksService>('agentExternalHooksService');
