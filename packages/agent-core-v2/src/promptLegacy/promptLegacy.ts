/**
 * `promptLegacy` domain (L7 edge adapter) — v1-compatible prompt scheduler.
 *
 * Implements the legacy `/api/v1` prompt contract (`submit` / `list` / `steer`
 * / `abort` with `prompt_id`, a FIFO queue, and `prompt.*` lifecycle events) on
 * top of the v2 turn-driver (`IPromptService`). v2's native `IPromptService`
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

export interface IPromptLegacyService {
  readonly _serviceBrand: undefined;
  list(): PromptListResponse;
  submit(body: PromptSubmission): Promise<PromptSubmitResult>;
  steer(promptIds: readonly string[]): Promise<PromptSteerResult>;
  abort(promptId: string): Promise<PromptAbortResponse>;
}

export const IPromptLegacyService: ServiceIdentifier<IPromptLegacyService> =
  createDecorator<IPromptLegacyService>('promptLegacyService.agent');
