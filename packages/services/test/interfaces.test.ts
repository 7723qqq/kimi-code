/**
 * W3.1 acceptance: the three broker decorators are typed correctly, can be
 * registered in a `ServiceCollection`, resolved through `InstantiationService`,
 * and surface their diagnostic names in not-registered errors.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  InstantiationService,
  ServiceCollection,
} from '@moonshot-ai/agent-core';
import type { ApprovalRequest, Event, QuestionRequest } from '@moonshot-ai/agent-core';

import {
  IApprovalBroker,
  IEventBus,
  IQuestionBroker,
  type ApprovalResponse,
  type QuestionResult,
} from '../src';

class FakeEventBus implements IEventBus {
  readonly events: Event[] = [];
  publish(event: Event): void {
    this.events.push(event);
  }
}

class FakeApprovalBroker implements IApprovalBroker {
  readonly received: ApprovalRequest[] = [];
  resolveCalls: Array<{ id: string; response: ApprovalResponse }> = [];
  async request(
    req: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    this.received.push(req);
    return { decision: 'approved' };
  }
  resolve(id: string, response: ApprovalResponse): void {
    this.resolveCalls.push({ id, response });
  }
}

class FakeQuestionBroker implements IQuestionBroker {
  readonly received: QuestionRequest[] = [];
  resolveCalls: Array<{ id: string; response: QuestionResult }> = [];
  dismissCalls: string[] = [];
  async request(
    req: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    this.received.push(req);
    return null;
  }
  resolve(id: string, response: QuestionResult): void {
    this.resolveCalls.push({ id, response });
  }
  dismiss(id: string): void {
    this.dismissCalls.push(id);
  }
}

function makeFakeEvent(): Event {
  // Minimal AgentStatusUpdatedEvent shape — the union narrows by `type`.
  return {
    type: 'agent_status_updated',
    sessionId: 'sess-1',
    agentId: 'main',
    status: { state: 'idle' },
  } as unknown as Event;
}

function makeFakeApproval(): ApprovalRequest & { sessionId: string; agentId: string } {
  return {
    toolCallId: 'tc-1',
    toolName: 'shell.run',
    action: 'execute',
    display: { kind: 'generic', summary: 'do thing' } as ApprovalRequest['display'],
    sessionId: 'sess-1',
    agentId: 'main',
  };
}

function makeFakeQuestion(): QuestionRequest & { sessionId: string; agentId: string } {
  return {
    questions: [
      {
        question: 'Which?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
    sessionId: 'sess-1',
    agentId: 'main',
  };
}

describe('@moonshot-ai/services · interfaces (W3.1)', () => {
  it('registers all three brokers in a ServiceCollection and resolves them through InstantiationService', () => {
    const bus = new FakeEventBus();
    const approvals = new FakeApprovalBroker();
    const questions = new FakeQuestionBroker();

    const services = new ServiceCollection(
      [IEventBus, bus],
      [IApprovalBroker, approvals],
      [IQuestionBroker, questions],
    );
    const ix = new InstantiationService(services);

    try {
      ix.invokeFunction((accessor) => {
        expect(accessor.get(IEventBus)).toBe(bus);
        expect(accessor.get(IApprovalBroker)).toBe(approvals);
        expect(accessor.get(IQuestionBroker)).toBe(questions);
      });
    } finally {
      ix.dispose();
    }
  });

  it('end-to-end smoke: invokes broker methods via the accessor', async () => {
    const bus = new FakeEventBus();
    const approvals = new FakeApprovalBroker();
    const questions = new FakeQuestionBroker();

    const services = new ServiceCollection(
      [IEventBus, bus],
      [IApprovalBroker, approvals],
      [IQuestionBroker, questions],
    );
    const ix = new InstantiationService(services);

    try {
      const event = makeFakeEvent();
      ix.invokeFunction((a) => a.get(IEventBus).publish(event));
      expect(bus.events).toEqual([event]);

      const approval = makeFakeApproval();
      const approvalResp = await ix.invokeFunction((a) =>
        a.get(IApprovalBroker).request(approval),
      );
      expect(approvalResp).toEqual({ decision: 'approved' });
      expect(approvals.received).toHaveLength(1);

      const question = makeFakeQuestion();
      const questionResp = await ix.invokeFunction((a) =>
        a.get(IQuestionBroker).request(question),
      );
      expect(questionResp).toBeNull();
      expect(questions.received).toHaveLength(1);
    } finally {
      ix.dispose();
    }
  });

  it('resolve/dismiss broker methods are wired through the same DI value', () => {
    const approvals = new FakeApprovalBroker();
    const questions = new FakeQuestionBroker();

    const services = new ServiceCollection(
      [IApprovalBroker, approvals],
      [IQuestionBroker, questions],
    );
    const ix = new InstantiationService(services);

    try {
      ix.invokeFunction((a) => {
        a.get(IApprovalBroker).resolve('tc-1', { decision: 'rejected', feedback: 'no' });
        a.get(IQuestionBroker).resolve('q-1', { answers: { q_1: 'A' } });
        a.get(IQuestionBroker).dismiss('q-2');
      });

      expect(approvals.resolveCalls).toEqual([
        { id: 'tc-1', response: { decision: 'rejected', feedback: 'no' } },
      ]);
      expect(questions.resolveCalls).toEqual([
        { id: 'q-1', response: { answers: { q_1: 'A' } } },
      ]);
      expect(questions.dismissCalls).toEqual(['q-2']);
    } finally {
      ix.dispose();
    }
  });

  it('looking up an unregistered broker throws with the decorator diagnostic name', () => {
    const ix = new InstantiationService(new ServiceCollection());
    try {
      expect(() => ix.invokeFunction((a) => a.get(IEventBus))).toThrow(/IEventBus/);
      expect(() => ix.invokeFunction((a) => a.get(IApprovalBroker))).toThrow(/IApprovalBroker/);
      expect(() => ix.invokeFunction((a) => a.get(IQuestionBroker))).toThrow(/IQuestionBroker/);
    } finally {
      ix.dispose();
    }
  });

  it('IEventBus / IApprovalBroker / IQuestionBroker are callable ServiceIdentifiers (compile-time guard)', () => {
    // The const half of the dual export must be usable as a ServiceCollection key
    // and as a `createDecorator` brand value. We exercise both at runtime to
    // also catch any accidental swap of the value with the type.
    expect(typeof IEventBus).toBe('function');
    expect(typeof IApprovalBroker).toBe('function');
    expect(typeof IQuestionBroker).toBe('function');

    // Avoid an unused-import warning on the type-only re-export.
    const _typeProbe: ApprovalResponse | QuestionResult = null;
    void _typeProbe;
    // And use vi to keep the import surface (helpful when running with strict
    // unused-imports lints in the future).
    vi.fn();
  });
});
