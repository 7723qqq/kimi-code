/**
 * `question` domain (L7) — ask-user request broker.
 *
 * Defines the public contract of asking the user: the `QuestionRequest` model
 * and the `IQuestionService` used to post a request, supply its answer, and
 * list pending requests. Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface QuestionRequest {
  readonly id: string;
  readonly prompt: string;
}

export interface IQuestionService {
  readonly _serviceBrand: undefined;
  request(req: QuestionRequest): Promise<string>;
  /**
   * Post a question without blocking on the answer. Returns the request (its
   * `id` is required, so it is already known); the answer is delivered through
   * the interaction `onDidResolve` stream.
   */
  enqueue(req: QuestionRequest): QuestionRequest;
  answer(id: string, answer: string): void;
  listPending(): readonly QuestionRequest[];
}

export const IQuestionService: ServiceIdentifier<IQuestionService> =
  createDecorator<IQuestionService>('questionService');
