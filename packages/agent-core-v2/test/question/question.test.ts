import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IInteractionService } from '#/interaction';
import { InteractionService } from '#/interaction/interactionService';
import { IQuestionService } from '#/question';
import { QuestionService } from '#/question/questionService';

describe('QuestionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IInteractionService, new SyncDescriptor(InteractionService));
    ix.set(IQuestionService, new SyncDescriptor(QuestionService));
  });
  afterEach(() => disposables.dispose());

  it('request parks until answer resolves it', async () => {
    const svc = ix.get(IQuestionService);
    const p = svc.request({ id: 'q1', prompt: 'name?' });
    expect(svc.listPending()).toEqual([{ id: 'q1', prompt: 'name?' }]);
    svc.answer('q1', 'kimi');
    await expect(p).resolves.toBe('kimi');
    expect(svc.listPending()).toEqual([]);
  });
});
