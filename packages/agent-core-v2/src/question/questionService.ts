/**
 * `question` domain (L7) — `ISessionQuestionService` implementation.
 *
 * Typed facade over the `interaction` kernel for ask-user requests; owns no
 * pending state of its own (the kernel holds it). Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionInteractionService } from '#/interaction';

import {
  type QuestionRequest,
  type QuestionResult,
  ISessionQuestionService,
} from './question';

export class SessionQuestionService implements ISessionQuestionService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionInteractionService private readonly interaction: ISessionInteractionService) {}

  request(req: QuestionRequest): Promise<QuestionResult> {
    return this.interaction.request<QuestionRequest, QuestionResult>({
      id: requestId(req),
      kind: 'question',
      payload: req,
      origin: { turnId: req.turnId },
    });
  }

  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string } {
    const id = requestId(req);
    this.interaction.enqueue<QuestionRequest>({
      id,
      kind: 'question',
      payload: req,
      origin: { turnId: req.turnId },
    });
    return { ...req, id };
  }

  answer(id: string, result: QuestionResult): void {
    this.interaction.respond(id, result);
  }

  dismiss(id: string): void {
    this.interaction.respond(id, null);
  }

  listPending(): readonly QuestionRequest[] {
    return this.interaction
      .listPending('question')
      .map((i) => i.payload as QuestionRequest);
  }
}

function requestId(req: QuestionRequest): string {
  return req.id ?? req.toolCallId ?? `question:${String(Date.now())}`;
}

registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, InstantiationType.Delayed, 'question');
