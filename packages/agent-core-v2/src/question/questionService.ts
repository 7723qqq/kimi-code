/**
 * `question` domain (L7) — `IQuestionService` implementation.
 *
 * Typed facade over the `interaction` kernel for ask-user requests; owns no
 * pending state of its own (the kernel holds it). Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IInteractionService } from '#/interaction';

import { type QuestionRequest, IQuestionService } from './question';

export class QuestionService implements IQuestionService {
  declare readonly _serviceBrand: undefined;

  constructor(@IInteractionService private readonly interaction: IInteractionService) {}

  request(req: QuestionRequest): Promise<string> {
    return this.interaction.request<QuestionRequest, string>({
      id: req.id,
      kind: 'question',
      payload: req,
    });
  }

  enqueue(req: QuestionRequest): QuestionRequest {
    this.interaction.enqueue<QuestionRequest>({
      id: req.id,
      kind: 'question',
      payload: req,
    });
    return req;
  }

  answer(id: string, answer: string): void {
    this.interaction.respond(id, answer);
  }

  listPending(): readonly QuestionRequest[] {
    return this.interaction
      .listPending('question')
      .map((i) => i.payload as QuestionRequest);
  }
}

registerScopedService(LifecycleScope.Session, IQuestionService, QuestionService, InstantiationType.Delayed, 'question');
