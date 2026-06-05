/**
 * Reverse-RPC broker: routes `QuestionRequest`s coming out of `KimiCore` to a
 * waiter (web client over WS in P1.x, mock handler in tests) and resolves the
 * promise when the response arrives — or `dismiss()`-es it if the user closes
 * the panel (SCHEMAS.md §6.3).
 *
 * **Shape note (W3 placeholder):** the broker returns the in-process
 * `QuestionResult = null | QuestionAnswers | QuestionResponse` (see
 * `packages/agent-core/src/rpc/sdk-api.ts:48`). SCHEMAS.md §6.2/§6.4 defines
 * a protocol-level `QuestionResponse` with a 5-kind discriminated union
 * (`single` / `multi` / `other` / `multi_with_other` / `skipped`); the
 * protocol↔in-process adapter lives at the daemon boundary (Chain 6 / W8),
 * NOT inside the broker interface. This keeps the SDK side of the bridge
 * untouched and confines protocol shape decisions to one place.
 *
 * `dismiss()` exists because Question has a tri-state outcome (resolved with
 * partial answers / fully dismissed / timeout) — see SCHEMAS.md §6.3.
 * Approval is binary (decision present or not), so it has no `dismiss()`.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { QuestionRequest, QuestionResult } from '@moonshot-ai/agent-core';
import type {} from '@moonshot-ai/protocol'; // type-only marker — keep protocol dep referenced

// Re-export for service-side consumers.
export type { QuestionRequest, QuestionResult };

export interface IQuestionBroker {
  /**
   * Called by the bridge when KimiCore needs the user to answer a question.
   * Resolves with the in-process `QuestionResult` (null = no handler / fully
   * dismissed). Concrete impls own timeout policy.
   */
  request(req: QuestionRequest & { sessionId: string; agentId: string }): Promise<QuestionResult>;

  /**
   * Called by the answer-side (REST handler / TUI / mock) to settle a pending
   * `request()` with user answers. `id` matches `QuestionRequest`'s correlation
   * id (`turnId`+`toolCallId` today; SCHEMAS.md §6.2's `question_id` once
   * Chain 6 lands).
   */
  resolve(id: string, response: QuestionResult): void;

  /**
   * Called when the user dismisses the panel without answering (ESC / close).
   * Concrete impls resolve the pending `request()` with the equivalent of
   * `dismissedQuestionResult()` (`packages/agent-core` — see SCHEMAS.md §6.3).
   */
  dismiss(id: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IQuestionBroker = createDecorator<IQuestionBroker>('IQuestionBroker');
