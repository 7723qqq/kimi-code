import type { ApprovalRequest as KapApprovalRequest, QuestionRequest as KapQuestionRequest } from '@moonshot-ai/protocol';

import type { SDKRpcClientBase } from '#/rpc';

import type { KapHttpClient } from './http-client';
import {
  toApprovalRequest,
  toKapApprovalResponse,
  toKapQuestionResponse,
  toQuestionRequest,
} from './mappers';

export interface ReverseChannelContext {
  readonly client: SDKRpcClientBase;
  readonly http: KapHttpClient;
}

/** Dispatch a WS reverse-request frame to the local handler and POST the resolution back. */
export async function handleReverseRequest(
  ctx: ReverseChannelContext,
  frame: { type: string; sessionId: string; payload: unknown },
): Promise<void> {
  if (frame.type === 'event.approval.requested') {
    const kapRequest = frame.payload as KapApprovalRequest;
    const response = await ctx.client.requestApproval({
      ...toApprovalRequest(kapRequest),
      sessionId: frame.sessionId,
      agentId: 'main',
    });
    await ctx.http.post(`/sessions/${frame.sessionId}/approvals/${kapRequest.approval_id}`, toKapApprovalResponse(response));
    return;
  }
  if (frame.type === 'event.question.requested') {
    const kapRequest = frame.payload as KapQuestionRequest;
    const result = await ctx.client.requestQuestion({
      ...toQuestionRequest(kapRequest),
      sessionId: frame.sessionId,
      agentId: 'main',
    });
    if (result === null) {
      await ctx.http.post(`/sessions/${frame.sessionId}/questions/${kapRequest.question_id}:dismiss`, {});
    } else {
      await ctx.http.post(`/sessions/${frame.sessionId}/questions/${kapRequest.question_id}`, toKapQuestionResponse(result));
    }
  }
}
