import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IInteractionService } from '#/interaction';
import { InteractionService } from '#/interaction/interactionService';
import { IQuestionService, type QuestionRequest } from '#/question';
import { QuestionService } from '#/question/questionService';

function makeRequest(id: string): QuestionRequest {
  return { id, prompt: 'name?' };
}

describe('QuestionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IInteractionService, InteractionService);
        reg.define(IQuestionService, QuestionService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('request parks until answer resolves it', async () => {
    const svc = ix.get(IQuestionService);
    const req = makeRequest('q1');
    const pending = svc.request(req);

    expect(svc.listPending()).toEqual([req]);
    svc.answer('q1', 'kimi');

    await expect(pending).resolves.toBe('kimi');
    expect(svc.listPending()).toEqual([]);
  });

  it('answer on unknown id is a no-op', () => {
    const svc = ix.get(IQuestionService);
    expect(() => svc.answer('missing', 'kimi')).not.toThrow();
  });

  it('enqueue parks a question without blocking', () => {
    const svc = ix.get(IQuestionService);
    const req = makeRequest('q1');
    const enqueued = svc.enqueue(req);

    expect(enqueued).toEqual(req);
    expect(svc.listPending()).toEqual([req]);
    svc.answer('q1', 'kimi');
    expect(svc.listPending()).toEqual([]);
  });
});
