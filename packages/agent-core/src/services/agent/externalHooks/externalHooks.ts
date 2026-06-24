import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from '../../../di';
import type { ExecutableToolResult } from '../../../loop';
import type { ToolInputDisplay } from '../../../tools/display';
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

export interface IExternalHooksService {
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
  triggerPermissionRequest(
    payload: {
      toolCallId: string;
      toolName: string;
      action: string;
      display: ToolInputDisplay;
    },
    signal: AbortSignal,
  ): Promise<void>;
  triggerPermissionResult(
    payload: {
      toolCallId: string;
      toolName: string;
      action: string;
      decision: string;
      scope?: string | undefined;
      feedback?: string | undefined;
      error?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IExternalHooksService =
  createDecorator<IExternalHooksService>('agentExternalHooksService');
