/**
 * Guardian review tests: verdict parsing, policy gating under yolo mode, and
 * the circuit breaker (ported from Reasonix's guardian.go contract).
 */

import { describe, expect, it } from 'vitest';

import type { IAgentGuardianService} from '#/agent/guardian/guardianService';
import { GuardianService, parseAssessment } from '#/agent/guardian/guardianService';
import { GuardianReviewPermissionPolicyService } from '#/agent/permissionPolicy/policies/guardian-review';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

describe('parseAssessment', () => {
  it('parses a clean JSON verdict', () => {
    const a = parseAssessment(
      '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"rm -rf is destructive"}',
    );
    expect(a).toEqual({
      riskLevel: 'high',
      userAuthorization: 'unknown',
      outcome: 'deny',
      rationale: 'rm -rf is destructive',
    });
  });

  it('extracts JSON from surrounding prose', () => {
    const a = parseAssessment(
      'Sure, here is my verdict: {"risk_level":"low","user_authorization":"implicit","outcome":"allow","rationale":"safe read"} hope that helps',
    );
    expect(a?.outcome).toBe('allow');
  });

  it('rejects unparseable or unknown-outcome text', () => {
    expect(parseAssessment('no json here')).toBeUndefined();
    expect(parseAssessment('{"outcome":"maybe"}')).toBeUndefined();
    expect(parseAssessment('{')).toBeUndefined();
  });
});

function hookContext(overrides: Partial<ResolvedToolExecutionHookContext>): ResolvedToolExecutionHookContext {
  return {
    turnId: 1,
    toolCall: { type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"rm -rf /"}' },
    toolCalls: [],
    tool: undefined,
    args: { command: 'rm -rf /' },
    execution: {
      approvalRule: 'Bash',
      accesses: [],
      execute: async () => ({ output: 'x' }),
    },
    ...overrides,
  } as unknown as ResolvedToolExecutionHookContext;
}

const mockMode = (mode: string) => ({ mode } as never);
const mockGuardian = (enabled: boolean, verdict: Awaited<ReturnType<IAgentGuardianService['review']>>) =>
  ({ enabled, circuitOpen: false, review: async () => verdict } as never);

describe('GuardianReviewPermissionPolicyService', () => {
  it('is a no-op outside yolo mode', async () => {
    const policy = new GuardianReviewPermissionPolicyService(
      mockMode('manual'),
      mockGuardian(true, { verdict: 'deny', riskLevel: 'high', rationale: 'x' }),
    );
    expect(await policy.evaluate(hookContext({}))).toBeUndefined();
  });

  it('is a no-op when disabled', async () => {
    const policy = new GuardianReviewPermissionPolicyService(
      mockMode('yolo'),
      mockGuardian(false, { verdict: 'deny', riskLevel: 'high', rationale: 'x' }),
    );
    expect(await policy.evaluate(hookContext({}))).toBeUndefined();
  });

  it('skips read-only tool calls', async () => {
    let reviewed = false;
    const guardian = {
      enabled: true,
      circuitOpen: false,
      review: async () => {
        reviewed = true;
        return { verdict: 'allow' as const, riskLevel: 'low', rationale: 'ok' };
      },
    };
    const policy = new GuardianReviewPermissionPolicyService(mockMode('yolo'), guardian as never);
    const readCtx = hookContext({
      toolCall: { type: 'function', id: 'c', name: 'Read', arguments: '{"path":"/a.txt"}' },
      args: { path: '/a.txt' },
    });
    expect(await policy.evaluate(readCtx)).toBeUndefined();
    expect(reviewed).toBe(false);
  });

  it('approves through when the reviewer allows', async () => {
    const policy = new GuardianReviewPermissionPolicyService(
      mockMode('yolo'),
      mockGuardian(true, { verdict: 'allow', riskLevel: 'low', rationale: 'safe write' }),
    );
    const result = await policy.evaluate(hookContext({}));
    expect(result?.kind).toBe('approve');
    expect((result as { reason?: Record<string, string> }).reason?.['guardian']).toContain('safe write');
  });

  it('degrades a reviewer deny to a human ask', async () => {
    const policy = new GuardianReviewPermissionPolicyService(
      mockMode('yolo'),
      mockGuardian(true, { verdict: 'deny', riskLevel: 'high', rationale: 'destructive' }),
    );
    const result = (await policy.evaluate(hookContext({}))) as PermissionPolicyResult;
    expect(result?.kind).toBe('ask');
  });

  it('bypasses when the review is unavailable', async () => {
    const policy = new GuardianReviewPermissionPolicyService(
      mockMode('yolo'),
      mockGuardian(true, { verdict: 'bypass', reason: 'circuit open' }),
    );
    expect(await policy.evaluate(hookContext({}))).toBeUndefined();
  });
});

describe('GuardianService circuit breaker', () => {
  function reviewService(): {
    service: GuardianService;
    setVerdict: (text: string) => void;
  } {
    let verdictText = '';
    const llm = {
      start: () => ({
        result: Promise.resolve({
          message: {
            content: [{ type: 'text', text: verdictText }],
            toolCalls: [],
          },
          usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        }),
      }),
    };
    const service = new GuardianService(
      llm as never,
      { get: () => [] } as never,
      { publish: () => {} } as never,
    );
    return { service, setVerdict: (text: string) => { verdictText = text; } };
  }

  const denyVerdict =
    '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"x"}';
  const allowVerdict =
    '{"risk_level":"low","user_authorization":"explicit","outcome":"allow","rationale":"ok"}';

  it('opens the circuit after consecutive denials', async () => {
    const { service, setVerdict } = reviewService();
    setVerdict(denyVerdict);
    const ctx = hookContext({});
    for (let i = 0; i < 3; i += 1) {
      const verdict = await service.review(ctx);
      expect(verdict.verdict).toBe('deny');
    }
    expect(service.circuitOpen).toBe(true);
    // After the circuit opens, reviews bypass without an LLM call.
    const verdict = await service.review(ctx);
    expect(verdict.verdict).toBe('bypass');
  });

  it('resets the consecutive-denial counter on an allow', async () => {
    const { service, setVerdict } = reviewService();
    setVerdict(denyVerdict);
    const ctx = hookContext({});
    await service.review(ctx);
    await service.review(ctx);
    expect(service.circuitOpen).toBe(false);
    // An allow resets the streak.
    setVerdict(allowVerdict);
    await service.review(ctx);
    setVerdict(denyVerdict);
    await service.review(ctx);
    await service.review(ctx);
    // Two denials after the reset — still under the three-deny threshold.
    expect(service.circuitOpen).toBe(false);
  });
});
