import type { ToolCall } from '@moonshot-ai/kosong';
import type { ApprovalResponse, ToolInputDisplay } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ResolvedToolExecutionHookContext } from '#/loop';
import { IPermissionModeService } from '#/permissionMode';
import type { PermissionMode } from '#/permissionPolicy';
import { ExitPlanModeReviewAskPermissionPolicyService } from '#/permissionPolicy/policies/exit-plan-mode-review-ask';
import type { PermissionPolicyRuntime } from '#/permissionPolicy/policies/runtime';
import { ITelemetryService } from '#/telemetry';
import { ToolAccesses } from '#/tool';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] as const;

type ExitPlanModeFn = PermissionPolicyRuntime['exitPlanMode'];

interface RuntimeApprovalResponse {
  readonly decision: ApprovalResponse['decision'];
  readonly selectedLabel?: string;
  readonly feedback?: string;
}

function approvalResponse(response: RuntimeApprovalResponse): ApprovalResponse {
  return response as unknown as ApprovalResponse;
}

function planReviewDisplay(
  input: {
    readonly plan?: string;
    readonly options?: readonly (typeof options)[number][] | undefined;
  } = {},
): ToolInputDisplay {
  const display: ToolInputDisplay = {
    kind: 'plan_review',
    plan: input.plan ?? '# Plan',
    path: '/tmp/kimi-plan.md',
  };
  if (input.options !== undefined) {
    display.options = input.options;
  }
  return display;
}

function policyContext(display: ToolInputDisplay): ResolvedToolExecutionHookContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: 'call_exit_plan',
    name: 'ExitPlanMode',
    arguments: '{}',
  };
  return {
    turnId: '7',
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args: {},
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: 'ExitPlanMode',
      display,
      execute: async () => ({ output: '' }),
    },
  };
}

function runtime(exitPlanMode: ExitPlanModeFn = vi.fn()): PermissionPolicyRuntime {
  return {
    options: {},
    planModeActive: () => true,
    planFilePath: () => '/tmp/kimi-plan.md',
    swarmModeIsActive: () => false,
    pathClass: () => {
      throw new Error('pathClass is not used by ExitPlanMode review policy');
    },
    findGitWorkTreeMarker: async () => null,
    exitPlanMode,
    formatPermissionRuleDenyMessage: (tool, reason) =>
      `Tool "${tool}" was denied by permission rule.${reason === undefined ? '' : ` Reason: ${reason}`}`,
  };
}

describe('ExitPlanModeReviewAskPermissionPolicyService telemetry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let records: TelemetryRecord[];
  let mode: PermissionMode;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    mode = 'manual';
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function makePolicy(
    exitPlanMode?: ExitPlanModeFn,
  ): ExitPlanModeReviewAskPermissionPolicyService {
    return ix.createInstance(
      ExitPlanModeReviewAskPermissionPolicyService,
      runtime(exitPlanMode),
    );
  }

  it('does not ask or track when auto mode approves upstream', () => {
    mode = 'auto';
    const result = makePolicy().evaluate(policyContext(planReviewDisplay()));

    expect(result).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('tracks submitted before asking for manual plan approval', () => {
    const result = makePolicy().evaluate(policyContext(planReviewDisplay()));

    expect(result?.kind).toBe('ask');
    expect(records).toContainEqual({
      event: 'plan_submitted',
      properties: { has_options: false },
    });
  });

  it('tracks approved multi-option plans with the chosen option', () => {
    const exitPlanMode = vi.fn();
    const result = makePolicy(exitPlanMode).evaluate(
      policyContext(planReviewDisplay({ options })),
    );
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'approved',
      selectedLabel: 'Approach B',
    }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Selected approach: Approach B'),
      },
    });
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(records).toContainEqual({
      event: 'plan_submitted',
      properties: { has_options: true },
    });
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: {
        outcome: 'approved',
        chosen_option: 'Approach B',
      },
    });
  });

  it('handles revision requests with feedback through plan resolution telemetry', () => {
    const exitPlanMode = vi.fn();
    const result = makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'rejected',
      selectedLabel: 'Revise',
      feedback: 'Add verification.',
    }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Add verification.'),
      },
    });
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: {
        outcome: 'revise',
        has_feedback: true,
      },
    });
  });

  it('handles plain rejections without exiting plan mode', () => {
    const exitPlanMode = vi.fn();
    const result = makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({ decision: 'rejected' }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    });
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'rejected' },
    });
  });

  it('handles dismissed approval dialogs without exiting plan mode', () => {
    const exitPlanMode = vi.fn();
    const result = makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({ decision: 'cancelled' }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    });
    expect(exitPlanMode).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'dismissed' },
    });
  });

  it('handles reject-and-exit and exits plan mode', () => {
    const exitPlanMode = vi.fn();
    const result = makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({
      decision: 'rejected',
      selectedLabel: 'Reject and Exit',
    }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: true,
        output: 'Plan rejected by user. Plan mode deactivated.',
      },
    });
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(records).toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'rejected_and_exited' },
    });
  });

  it('does not track approved when exitPlanMode fails', () => {
    const exitPlanMode = vi.fn(() => ({
      isError: true as const,
      output: 'Failed to exit plan mode: state transition failure',
    }));
    const result = makePolicy(exitPlanMode).evaluate(policyContext(planReviewDisplay()));
    if (result?.kind !== 'ask') throw new Error('expected ask');

    const approval = result.resolveApproval?.(approvalResponse({ decision: 'approved' }));

    expect(approval).toMatchObject({
      kind: 'result',
      syntheticResult: {
        isError: true,
        output: 'Failed to exit plan mode: state transition failure',
      },
    });
    expect(records).toContainEqual({
      event: 'plan_submitted',
      properties: { has_options: false },
    });
    expect(records).not.toContainEqual({
      event: 'plan_resolved',
      properties: { outcome: 'approved' },
    });
  });
});
