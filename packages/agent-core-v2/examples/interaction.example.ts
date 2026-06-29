/**
 * Scenario: the **interaction** kernel and its `approval` / `question` facades,
 * resolved through the **Session scope** they belong to.
 *
 * All three Services are registered at `LifecycleScope.Session`, so this
 * example resolves them from a real Session scope (`createScopedTestHost` →
 * `host.child(LifecycleScope.Session, …)`), the same layer production uses. The
 * scoped registry is cleared and re-populated explicitly in `beforeEach` rather
 * than relying on import-order side effects.
 *
 * `IInteractionService` is the only Service that owns state — a pending set
 * plus a recently-resolved ledger — and it is domain-agnostic.
 * `IApprovalService` and `IQuestionService` are zero-state typed facades over
 * it: they tag each request with `kind: 'approval'` / `kind: 'question'`,
 * rename the resolve verb (`decide` / `answer` → `respond`), and cast the
 * stored payload back to the typed request on `listPending`.
 *
 * Two calling styles are demonstrated:
 *
 *  - **Blocking** (`request`): the caller `await`s a Promise that parks until a
 *    response arrives. Used by in-turn code (a tool gating on a user decision).
 *  - **Non-blocking** (`enqueue` + `onDidResolve`): the caller parks the request
 *    and returns its `id` immediately; the outcome is delivered through the
 *    `onDidResolve` stream. Used by edge callers that stream the result rather
 *    than awaiting a Promise (e.g. over WebSocket).
 *
 * The final scenario proves Session-scope isolation: two sessions hold
 * independent brokers, so a request parked in session A is invisible to, and
 * not resolvable from, session B.
 */

import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, test } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { DisposableStore } from '#/_base/di/lifecycle';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import { type ApprovalRequest, ApprovalService, IApprovalService } from '#/approval';
import { IInteractionService, InteractionService } from '#/interaction';
import { IQuestionService, QuestionService } from '#/question';

const display: ToolInputDisplay = { kind: 'command', command: 'rm -rf /tmp/demo' };

function approval(id: string): ApprovalRequest {
  return { id, toolName: 'bash', action: 'run', display };
}

describe('interaction kernel + approval/question facades (Session scope)', () => {
  let disposables: DisposableStore;
  let host: ScopedTestHost;
  let session: Scope;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, IInteractionService, InteractionService, InstantiationType.Delayed, 'interaction');
    registerScopedService(LifecycleScope.Session, IApprovalService, ApprovalService, InstantiationType.Delayed, 'approval');
    registerScopedService(LifecycleScope.Session, IQuestionService, QuestionService, InstantiationType.Delayed, 'question');

    disposables = new DisposableStore();
    host = createScopedTestHost();
    session = host.child(LifecycleScope.Session, 'session-a');
  });
  afterEach(() => {
    disposables.dispose();
    host.dispose();
  });

  test('blocking: approval.request parks until decide resolves the Promise', async () => {
    const approvals = session.accessor.get(IApprovalService);

    // The caller (e.g. a tool) awaits the decision. Nothing resolves yet.
    const decision = approvals.request(approval('bash-1'));
    console.log('1) after request, pending approvals:', approvals.listPending().map((r) => r.id));

    // The edge (HTTP/WS `approvals:decide`) supplies the user's decision.
    approvals.decide('bash-1', { decision: 'approved' });
    console.log('2) resolved decision:', await decision);
    console.log('3) after decide, pending approvals:', approvals.listPending());
  });

  test('non-blocking: question.enqueue returns immediately; the answer streams over onDidResolve', () => {
    const interaction = session.accessor.get(IInteractionService);
    const questions = session.accessor.get(IQuestionService);

    // Edge callers observe outcomes through the stream instead of awaiting.
    const resolved: { id: string; response: unknown }[] = [];
    disposables.add(interaction.onDidResolve((r) => resolved.push(r)));

    // enqueue parks the request and returns its id without blocking.
    const parked = questions.enqueue({ id: 'q-name', prompt: 'What is your name?' });
    console.log('1) enqueued question (id known up front):', parked);
    console.log('2) pending questions:', questions.listPending());

    // The answer arrives later (HTTP/WS `questions:answer`) and fans out.
    questions.answer('q-name', 'kimi');
    console.log('3) onDidResolve stream delivered:', resolved);
    console.log('4) after answer, pending questions:', questions.listPending());
  });

  test('one kernel backs both facades; onDidChange announces every mutation', () => {
    const interaction = session.accessor.get(IInteractionService);
    const approvals = session.accessor.get(IApprovalService);
    const questions = session.accessor.get(IQuestionService);

    let changes = 0;
    disposables.add(interaction.onDidChange(() => changes++));

    void approvals.request(approval('bash-1')); // change #1 (park approval)
    questions.enqueue({ id: 'q-name', prompt: 'name?' }); // change #2 (park question)

    // The kernel sees every pending interaction, regardless of which facade parked it.
    console.log('1) kernel listPending (all kinds):', interaction.listPending().map((i) => i.kind));
    console.log('2) kernel listPending("approval"):', interaction.listPending('approval').map((i) => i.id));
    console.log('3) kernel listPending("question"):', interaction.listPending('question').map((i) => i.id));

    approvals.decide('bash-1', { decision: 'rejected' }); // change #3 (resolve approval)
    questions.answer('q-name', 'kimi'); // change #4 (resolve question)
    console.log('4) onDidChange fired', changes, 'times (park x2 + resolve x2)');
  });

  test('Session scope isolates brokers: a request parked in A is invisible to B', async () => {
    const sessionB = host.child(LifecycleScope.Session, 'session-b');

    const approvalsA = session.accessor.get(IApprovalService);
    const approvalsB = sessionB.accessor.get(IApprovalService);
    console.log('1) distinct broker instances per session:', approvalsA !== approvalsB);

    const decisionA = approvalsA.request(approval('bash-1'));
    console.log('2) A pending after park:', approvalsA.listPending().map((r) => r.id));
    console.log('3) B pending (isolated):', approvalsB.listPending().map((r) => r.id));

    // Deciding from B is a no-op — the id is parked in A's kernel, not B's.
    approvalsB.decide('bash-1', { decision: 'approved' });
    console.log('4) A still pending after B.decide (no-op):', approvalsA.listPending().map((r) => r.id));

    approvalsA.decide('bash-1', { decision: 'approved' });
    console.log('5) A resolved by its own broker:', await decisionA);
  });
});
