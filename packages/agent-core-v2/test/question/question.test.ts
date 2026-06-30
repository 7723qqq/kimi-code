import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { DisposableStore } from '#/_base/di/lifecycle';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import { ISessionInteractionService, SessionInteractionService } from '#/interaction';
import { type QuestionRequest, ISessionQuestionService, SessionQuestionService } from '#/question';

function makeRequest(id: string): QuestionRequest {
  return {
    id,
    toolCallId: `tc-${id}`,
    questions: [
      {
        question: 'Pick one',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
}

describe('ISessionQuestionService (Session scope facade over the interaction kernel)', () => {
  let disposables: DisposableStore;
  let host: ScopedTestHost;
  let session: Scope;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, ISessionInteractionService, SessionInteractionService, InstantiationType.Delayed, 'interaction');
    registerScopedService(LifecycleScope.Session, ISessionQuestionService, SessionQuestionService, InstantiationType.Delayed, 'question');

    disposables = new DisposableStore();
    host = createScopedTestHost();
    session = host.child(LifecycleScope.Session, 'session-a');
  });

  afterEach(() => {
    disposables.dispose();
    host.dispose();
  });

  it('request parks until answer resolves it with the rich result', async () => {
    const questions = session.accessor.get(ISessionQuestionService);

    const pending = questions.request(makeRequest('q1'));
    expect(questions.listPending().map((r) => r.id)).toEqual(['q1']);

    questions.answer('q1', { answers: { q_0: 'Yes' }, method: 'number_key' });
    await expect(pending).resolves.toEqual({ answers: { q_0: 'Yes' }, method: 'number_key' });
    expect(questions.listPending()).toEqual([]);
  });

  it('enqueue returns immediately and the answer streams over onDidResolve', () => {
    const interaction = session.accessor.get(ISessionInteractionService);
    const questions = session.accessor.get(ISessionQuestionService);

    const resolved: { id: string; response: unknown }[] = [];
    disposables.add(interaction.onDidResolve((r) => resolved.push(r)));

    const parked = questions.enqueue(makeRequest('q1'));
    expect(parked.id).toBe('q1');
    expect(questions.listPending().map((r) => r.id)).toEqual(['q1']);

    questions.answer('q1', { answers: { q_0: 'No' } });
    expect(resolved).toEqual([{ id: 'q1', response: { answers: { q_0: 'No' } } }]);
    expect(questions.listPending()).toEqual([]);
  });

  it('dismiss resolves a pending request with null', async () => {
    const questions = session.accessor.get(ISessionQuestionService);

    const pending = questions.request(makeRequest('q1'));
    questions.dismiss('q1');

    await expect(pending).resolves.toBeNull();
    expect(questions.listPending()).toEqual([]);
  });

  it('listPending returns the stored in-process payload', () => {
    const questions = session.accessor.get(ISessionQuestionService);
    questions.enqueue(makeRequest('q1'));

    const pending = questions.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'q1',
      toolCallId: 'tc-q1',
      questions: [{ question: 'Pick one' }],
    });
  });

  it('Session scope isolates brokers: a question parked in A is invisible to B', () => {
    const sessionB = host.child(LifecycleScope.Session, 'session-b');
    const questionsA = session.accessor.get(ISessionQuestionService);
    const questionsB = sessionB.accessor.get(ISessionQuestionService);

    questionsA.enqueue(makeRequest('q1'));
    expect(questionsA.listPending().map((r) => r.id)).toEqual(['q1']);
    expect(questionsB.listPending()).toEqual([]);

    // Answering from B is a no-op — the id lives in A's kernel.
    questionsB.answer('q1', { answers: { q_0: 'Yes' } });
    expect(questionsA.listPending().map((r) => r.id)).toEqual(['q1']);
  });
});
