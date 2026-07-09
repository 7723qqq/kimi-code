/**
 * `promptLegacy` domain (L7 edge adapter) — v1-compatible prompt scheduler.
 *
 * Implements the legacy `/api/v1` prompt contract (`submit` / `list` / `steer`
 * / `abort` with `prompt_id`, a FIFO queue, and `prompt.*` lifecycle events) on
 * top of the v2 turn-driver (`IAgentPromptService`). v2's native `IAgentPromptService`
 * (turn-is-the-submission, no queue) is untouched and continues to serve
 * `/api/v2`. This service exists purely so clients of the v1 server keep
 * working against server-v2. Bound at Agent scope — the queue and the active
 * submission are per-agent state.
 */

import type {
  PromptAbortResponse,
  PromptListResponse,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TurnResult } from '#/agent/turn/turn';

/**
 * Outcome of a prompt that was launched (or queued and later launched) by
 * {@link IAgentPromptLegacyService.submitAndSettle}. `result` is the underlying
 * turn's settled `TurnResult` — the same signal the legacy scheduler already
 * observes internally to advance its queue, now exposed to in-process callers
 * so they can await turn completion authoritatively instead of reverse
 * engineering it from the event stream.
 */
export interface PromptCompletion {
  readonly promptId: string;
  readonly result: TurnResult;
}

export interface PromptSettleResult {
  readonly submit: PromptSubmitResult;
  /**
   * Resolves when the submitted prompt's turn settles (covering prompts that
   * were queued and run later). Rejects if the prompt is dropped before it ever
   * launches (e.g. the agent is busy and the submission is `blocked`, or it is
   * aborted while still queued).
   */
  readonly completion: Promise<PromptCompletion>;
}

export interface IAgentPromptLegacyService {
  readonly _serviceBrand: undefined;

  list(): PromptListResponse;
  submit(body: PromptSubmission): Promise<PromptSubmitResult>;
  /**
   * Submit like {@link submit}, but also return a `completion` promise of the
   * launched turn's settled result. Used by in-process callers (e.g. `kimi -p`)
   * that need to await turn completion authoritatively; server callers that
   * only need the serializable `PromptSubmitResult` keep using {@link submit}.
   */
  submitAndSettle(body: PromptSubmission): Promise<PromptSettleResult>;
  steer(promptIds: readonly string[]): Promise<PromptSteerResult>;
  abort(promptId: string): Promise<PromptAbortResponse>;
}

export const IAgentPromptLegacyService: ServiceIdentifier<IAgentPromptLegacyService> =
  createDecorator<IAgentPromptLegacyService>('agentPromptLegacyService');
