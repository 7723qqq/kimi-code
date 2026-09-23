import { describe, expect, it, vi } from 'vitest';

import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '#/index';
import { Session } from '#/index';
import type { SDKRpcClientBase } from '#/rpc';

describe('Session approval handler', () => {
  it('registers an approval handler and returns approved responses', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_handler',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    const handler = vi.fn(async (request: ApprovalRequest) => {
      expect(request).toMatchObject({
        toolCallId: 'tool_1',
        toolName: 'Bash',
        action: 'Run command',
      });
      return { decision: 'approved' as const, selectedLabel: 'Approve once' };
    });
    session.setApprovalHandler(handler);

    await expect(
      rpc.requestApproval(
        session.id,
        'main',
        approvalRequest({
          toolCallId: 'tool_1',
          toolName: 'Bash',
          action: 'Run command',
        }),
      ),
    ).resolves.toEqual({ decision: 'approved', selectedLabel: 'Approve once' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sends rejected responses with feedback', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_rejected',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    session.setApprovalHandler(() => ({ decision: 'rejected', feedback: 'No writes.' }));

    await expect(
      rpc.requestApproval(
        session.id,
        'main',
        approvalRequest({
          toolCallId: 'tool_2',
          toolName: 'Write',
          action: 'Write file',
        }),
      ),
    ).resolves.toEqual({ decision: 'rejected', feedback: 'No writes.' });
  });

  it('sends session-scoped approved responses when requested', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_scope',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    session.setApprovalHandler(() => ({ decision: 'approved', scope: 'session' }));

    await expect(
      rpc.requestApproval(
        session.id,
        'main',
        approvalRequest({
          toolCallId: 'tool_scope',
          toolName: 'Bash',
          action: 'Run command',
        }),
      ),
    ).resolves.toEqual({ decision: 'approved', scope: 'session' });
  });

  it('cancels approval requests when no handler is registered', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_default',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });

    await expect(
      rpc.requestApproval(
        session.id,
        'main',
        approvalRequest({
          toolCallId: 'tool_3',
          toolName: 'Bash',
          action: 'Run command',
        }),
      ),
    ).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'No approval handler registered.',
    });
    await session.close();
    expect(rpc.closeSession).toHaveBeenCalledWith({ sessionId: session.id });
  });

  it('cancels approval requests when the handler throws', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_throw',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    session.setApprovalHandler(() => {
      throw new Error('boom');
    });

    await expect(
      rpc.requestApproval(
        session.id,
        'main',
        approvalRequest({
          toolCallId: 'tool_4',
          toolName: 'Bash',
          action: 'Run command',
        }),
      ),
    ).resolves.toEqual({
      decision: 'cancelled',
      feedback: 'Approval handler failed.',
    });
  });

  it('responds to the original subagent id', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_subagent',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    const handler = vi.fn(() => ({ decision: 'approved' as const }));
    session.setApprovalHandler(handler);

    await expect(
      rpc.requestApproval(
        session.id,
        'agent-1',
        approvalRequest({
          toolCallId: 'tool_5',
          toolName: 'Read',
          action: 'Read file',
        }),
      ),
    ).resolves.toEqual({ decision: 'approved' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        agentId: 'agent-1',
      }),
    );
  });

  // The engine's policy explanation has to survive `requestApproval` so the
  // host's prompt can say why it is asking, not just what it would run.
  it('delivers the engine reason to the registered handler', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_reason',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    const seen: Array<string | undefined> = [];
    session.setApprovalHandler(async (request) => {
      seen.push(request.reason);
      return { decision: 'approved' };
    });

    await rpc.requestApproval(
      session.id,
      'main',
      approvalRequest({
        toolCallId: 'tool_r',
        toolName: 'Read',
        action: 'read',
        reason: 'Access to sensitive file requires approval: .env',
      }),
    );

    expect(seen).toEqual(['Access to sensitive file requires approval: .env']);
  });

  it('leaves the reason undefined when the engine has none to give', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_approval_no_reason',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    const seen: Array<string | undefined> = [];
    session.setApprovalHandler(async (request) => {
      seen.push(request.reason);
      return { decision: 'approved' };
    });

    await rpc.requestApproval(
      session.id,
      'main',
      approvalRequest({ toolCallId: 'tool_n', toolName: 'Read', action: 'read' }),
    );

    expect(seen).toEqual([undefined]);
  });
});

interface ApprovalRequestInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  /** Why the engine is asking; omitted when it has no policy explanation. */
  readonly reason?: string;
}

function approvalRequest(input: ApprovalRequestInput): ApprovalRequest {
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    action: input.action,
    display: { kind: 'generic', summary: input.action },
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}
class FakeSDKRpcClient {
  private readonly approvalHandlers = new Map<string, ApprovalHandler>();
  readonly closeSession = vi.fn(async (_input: { readonly sessionId: string }) => {});

  asRpc(): SDKRpcClientBase {
    return this as unknown as SDKRpcClientBase;
  }

  setApprovalHandler(sessionId: string, handler: ApprovalHandler | undefined): void {
    if (handler === undefined) {
      this.approvalHandlers.delete(sessionId);
      return;
    }
    this.approvalHandlers.set(sessionId, handler);
  }

  async requestApproval(
    sessionId: string,
    agentId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> {
    const handler = this.approvalHandlers.get(sessionId);
    if (handler === undefined) {
      return {
        decision: 'cancelled',
        feedback: 'No approval handler registered.',
      };
    }
    try {
      return await handler({ ...request, sessionId, agentId } as ApprovalRequest);
    } catch {
      return {
        decision: 'cancelled',
        feedback: 'Approval handler failed.',
      };
    }
  }

  clearSessionHandlers(sessionId: string): void {
    this.approvalHandlers.delete(sessionId);
  }
}
