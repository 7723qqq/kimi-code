import { createControlledPromise } from '@antfu/utils';

import { isUserCancellation } from '#/_base/utils/abort';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { AgentTelemetryContext } from '#/app/telemetry/context';
import { ErrorCodes, isError2 } from '#/errors';
import type { ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import type { FinishReason } from '#human/llm/finish-reason';
import type { ContentPart, UserMessage } from '#human/llm/message';
import type { TokenUsage } from '#human/llm/usage';

import {
  isMaxStepsExceededError,
  type LoopError,
  type PromptCompletion,
  type Turn,
  type TurnResult,
} from './loop';
import { EMPTY_MACHINE_PROMPT, type MachineEngineEvent, type UserEntry } from './machine';
import type { TurnInterruptReason } from './turnEvents';

export type MachineGateDecision =
  | { readonly type: 'proceed'; readonly signal: AbortSignal; readonly step: number }
  | { readonly type: 'fail' };

export function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

export function machineUserMessage(message: ContextMessage | undefined): UserMessage {
  if (message === undefined) return EMPTY_MACHINE_PROMPT;
  return { role: 'user', content: [...message.content] };
}

export type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

export interface PromptWaiter {
  readonly id: string;
  readonly dispatchPromptId?: string;
  readonly launched: ReturnType<typeof createControlledPromise<Turn | undefined>>;
  readonly completion: ReturnType<typeof createControlledPromise<PromptCompletion>>;
  readonly onMaterialize?: () => void;
  failedEntry?: UserEntry;
}

export interface PromptProjection {
  readonly tracked: boolean;
  readonly origin: PromptOrigin;
  readonly message: ContextMessage;
  readonly userMessageId: string;
  readonly createdAt: string;
}

export interface ActivePrompt extends PromptProjection {
  readonly id: string;
  readonly promptId?: string;
}

export interface SteeredPrompt extends PromptProjection {
  readonly parentId: string;
}

export const EMPTY_HANDLE_MESSAGE: ContextMessage = {
  role: 'user',
  content: [],
  toolCalls: [],
};

export function projectionFromEntry(entry: UserEntry): PromptProjection {
  const origin = (entry.meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
  return {
    tracked: entry.meta?.tracked === true,
    origin,
    message: {
      role: 'user',
      content: [...entry.message.content],
      id: entry.meta?.promptId,
      toolCalls: [],
      origin: entry.meta?.origin as PromptOrigin | undefined,
    },
    userMessageId: entry.meta?.userMessageId ?? '',
    createdAt: entry.meta?.createdAt ?? '',
  };
}

export interface Nudge {
  readonly contextMessage?: ContextMessage;
  readonly promptIds?: readonly string[];
  readonly bypassMaxSteps: boolean;
  readonly turnScoped: boolean;
  readonly onConsume?: () => void;
  readonly onDrop?: () => void;
  dropped?: boolean;
  consumed?: boolean;
  sentToMachine?: boolean;
}

export type MachineStepEntry = Extract<
  MachineEngineEvent,
  { readonly type: 'stepCompleted' }
>['entry'];

export interface MachineStepState {
  readonly number: number;
  readonly uuid: string;
  readonly signal: AbortSignal;
  contentAppended: boolean;
  entry: MachineStepEntry | undefined;
  usage: TokenUsage | undefined;
  timing: ModelRequestTiming | undefined;
  providerFinishReason: FinishReason | undefined;
  rawFinishReason: string | undefined;
  messageId: string | undefined;
  pendingToolIds: Set<string>;
  toolCallUuids: Map<string, string>;
  resolvedToolIds: Set<string>;
  toolStopTurn: boolean;
}

export interface MachineFailedStep {
  readonly number: number;
  readonly uuid: string;
  readonly error: unknown;
}

export interface ActiveTurn {
  readonly id: number;
  readonly prompt: ActivePrompt;
  readonly controller: AbortController;
  steerController: AbortController;
  readonly turn: MutableTurn;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly startedAt: number;
  steps: number;
  gatedSteps: number;
  nudgeCursor: number;
  current: MachineStepState | undefined;
  interruptStep: number | undefined;
  failedStep: MachineFailedStep | undefined;
  stopRequested: boolean;
  toolStopRequested: boolean;
  forcedStopReason: string | undefined;
  lastStopReason: FinishReason | undefined;
  filtered: boolean;
  maxStepsError: LoopError | undefined;
  abortReason: unknown;
  retryRequested: boolean;
  afterChain: Promise<void>;
  partials: ContentPart[];
  forceContentPartBoundary: boolean;
  readyResolved: boolean;
  mode: AgentTelemetryContext['mode'] | undefined;
  providerType: string | undefined;
  protocol: string | undefined;
}

export function cancelReasonFor(cancellation: unknown): 'user_cancelled' | 'aborted' {
  return isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted';
}

export function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptReason {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}
