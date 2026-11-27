import type { Message } from '@moonshot-ai/core/llm/message';
import type { LlmPolicy, LlmRunControl } from '@moonshot-ai/core/llm/policy/policy';
import type { LlmRecoveryRecord } from '@moonshot-ai/core/llm/policy/recovery';
import { isAbortError, toLlmErrorMessage } from '@moonshot-ai/core/llm/protocol/errors';
import type { LlmRequest, LlmRequestProfile } from '@moonshot-ai/core/llm/request';
import type { LlmDimension, LlmRequester, LlmRequestRest } from '@moonshot-ai/core/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '@moonshot-ai/core/llm/response';
import type { LoopProfile } from './contract/profile';
import { isLlmOutcome } from './guards';

export interface LoopLlmRequester {
  snapshot?(): LoopLlmRequester;
  generate(rest: LlmRequestRest<LlmDimension>, control: LlmRunControl): Promise<LlmOutcome>;
}

export type FullLoopLlmRequester = LlmRequester<LlmDimension>;
export type LoopRequester = LoopLlmRequester | FullLoopLlmRequester;

export function isFullLoopRequester(requester: LoopRequester | undefined): requester is FullLoopLlmRequester {
  return requester !== undefined &&
    'with' in requester && typeof requester.with === 'function' &&
    'request' in requester && typeof requester.request === 'function';
}

export interface LoopRequestRuntime {
  readonly historyRevision: () => number;
}

export interface LoopLlmRunObservation {
  attempt?(
    request: LlmRequest,
    info: { readonly appliedRecoveries: readonly LlmRecoveryRecord[] },
  ): void;
  event?(event: LlmRunEvent): void;
  settle?(outcome: LlmOutcome, signal: AbortSignal): void;
}

export interface LoopLlmRunObserver {
  start?(request: LlmRequest): LoopLlmRunObservation | undefined;
}

export interface LoopRequestInput {
  readonly turnId: number;
  readonly step: number;
  readonly messages: readonly Message[];
  readonly profile: LoopProfile;
  readonly policy?: LlmPolicy;
  readonly signal: AbortSignal;
  readonly observer?: LoopLlmRunObserver;
}

export type LoopRequestProgress = Exclude<LlmRunEvent, { type: 'llm.ended' }>;

export function requestProfileOf(profile: LoopProfile): LlmRequestProfile {
  const { systemPrompt, tools } = profile;
  return {
    ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
  };
}

function failedOutcome(error: unknown): LlmOutcome {
  return { type: 'failed', error: toLlmErrorMessage(error), rawError: error };
}

function isAborted(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted) return true;
  try {
    return isAbortError(error);
  } catch {
    return false;
  }
}

export function normalizeLlmOutcome(value: unknown): LlmOutcome {
  return isLlmOutcome(value) ? value : failedOutcome(new Error('invalid llm outcome'));
}

export function outcomeForError(signal: AbortSignal, error: unknown): LlmOutcome {
  if (signal.aborted || isAborted(signal, error)) {
    return { type: 'aborted', message: null, usage: undefined, reason: signal.reason };
  }
  return failedOutcome(error);
}

export function runLoopRequest(
  requester: LoopRequester,
  input: LoopRequestInput,
  onProgress: (event: LoopRequestProgress) => void,
): Promise<LlmOutcome> {
  let resolve: (outcome: LlmOutcome) => void = () => undefined;
  const promise = new Promise<LlmOutcome>((reply) => {
    resolve = reply;
  });
  let ended = false;
  const end = (value: unknown): void => {
    if (ended) return;
    ended = true;
    resolve(normalizeLlmOutcome(value));
  };
  const forward = (event: LlmRunEvent): void => {
    if (ended) return;
    if (event.type === 'llm.ended') end(event.outcome);
    else onProgress(event);
  };
  void (async () => {
    if (!isFullLoopRequester(requester)) {
      try {
        end(
          await requester.generate(
            { content: { messages: input.messages }, profile: requestProfileOf(input.profile), policy: input.policy },
            { signal: input.signal, onEvent: forward },
          ),
        );
      } catch (error) {
        end(outcomeForError(input.signal, error));
      }
      return;
    }
    let observation: LoopLlmRunObservation | undefined;
    let outcome: LlmOutcome;
    try {
      const prepared = requester.with({
        content: { messages: input.messages },
        profile: requestProfileOf(input.profile),
        policy: input.policy,
        attributes: { kind: 'loop', turnId: input.turnId, step: input.step },
      });
      observation = input.observer?.start?.(prepared.request({}));
      outcome = normalizeLlmOutcome(await prepared.generate(
        {},
        {
          signal: input.signal,
          onAttempt: (attemptRequest, info) => observation?.attempt?.(attemptRequest, info),
          onEvent: (event) => {
            observation?.event?.(event);
            if (event.type !== 'llm.ended') forward(event);
          },
        },
      ));
    } catch (error) {
      outcome = outcomeForError(input.signal, error);
    }
    observation?.settle?.(outcome, input.signal);
    end(outcome);
  })();
  return promise;
}
