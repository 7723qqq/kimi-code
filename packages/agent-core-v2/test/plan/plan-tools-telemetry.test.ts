import type { ToolCall } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentPlanService, PlanData } from '#/plan';
import { EnterPlanModeTool } from '#/plan/tools/enter-plan-mode';
import {
  ExitPlanModeTool,
  type ExitPlanModeInput,
} from '#/plan/tools/exit-plan-mode';
import type { ITelemetryService } from '#/telemetry';
import { IAgentToolExecutorService } from '#/toolExecutor';

import { executeTool } from '../tools/fixtures/execute-tool';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import {
  createTestAgent,
  kaosServices,
  permissionModeServices,
  telemetryServices,
  type TestAgentContext,
} from '../harness/agent';
import {
  recordingTelemetry as captureTelemetry,
  type TelemetryRecord,
} from '../telemetry/stubs';

const ACTIVE_PLAN: NonNullable<PlanData> = {
  id: 'test-plan',
  content: '# Plan\n\n- Inspect\n- Change\n- Verify',
  path: '/tmp/kimi-plan.md',
};

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] satisfies NonNullable<ExitPlanModeInput['options']>;

function recordingTelemetry(): {
  readonly telemetry: ITelemetryService;
  readonly track: ReturnType<typeof vi.fn>;
} {
  const track = vi.fn();
  return {
    telemetry: {
      _serviceBrand: undefined,
      track,
      withContext: () => recordingTelemetry().telemetry,
      setContext: () => {},
      addAppender: () => ({ dispose: () => {} }),
      removeAppender: () => {},
      setAppender: () => {},
      setEnabled: () => {},
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    track,
  };
}

function planService({
  status = ACTIVE_PLAN,
  enter,
  exit,
}: {
  readonly status?: PlanData;
  readonly enter?: IAgentPlanService['enter'];
  readonly exit?: IAgentPlanService['exit'];
} = {}): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: enter ?? vi.fn(async () => {}),
    cancel: vi.fn(),
    clear: vi.fn(async () => {}),
    exit: exit ?? vi.fn(),
    status: vi.fn(async () => status),
  };
}

describe('EnterPlanModeTool telemetry', () => {
  it('tracks direct entry as auto_approved', async () => {
    let active = false;
    const planMode = planService({
      status: null,
      enter: vi.fn(async () => {
        active = true;
      }),
    });
    vi.mocked(planMode.status).mockImplementation(async () => (active ? ACTIVE_PLAN : null));
    const { telemetry, track } = recordingTelemetry();

    const result = await executeTool(new EnterPlanModeTool(planMode, telemetry), {
      turnId: '0',
      toolCallId: 'call_enter_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeFalsy();
    expect(track).toHaveBeenCalledWith('plan_enter_resolved', {
      outcome: 'auto_approved',
    });
  });
});

describe('AgentPlanService EnterPlanMode telemetry', () => {
  for (const mode of ['manual', 'auto', 'yolo'] as const) {
    describe(`${mode} mode`, () => {
      let ctx: TestAgentContext;
      let toolExecutor: IAgentToolExecutorService;
      const records: TelemetryRecord[] = [];

      beforeEach(() => {
        records.splice(0);
        ctx = createTestAgent(
          kaosServices(createFakeKaos({
            mkdir: vi.fn().mockResolvedValue(undefined),
          })),
          permissionModeServices(mode),
          telemetryServices(captureTelemetry(records)),
        );
        toolExecutor = ctx.get(IAgentToolExecutorService);
      });

      afterEach(async () => {
        try {
          await ctx.expectResumeMatches();
        } finally {
          await ctx.dispose();
        }
      });

      it('enters without approval and tracks auto_approved', async () => {
        const call: ToolCall = {
          type: 'function',
          id: `call_enter_plan_${mode}`,
          name: 'EnterPlanMode',
          arguments: '{}',
        };

        const result = await toolExecutor.execute([call], {
          turnId: '1',
          signal: new AbortController().signal,
        });

        expect(result[0]?.isError).toBeFalsy();
        expect(result[0]?.output).toContain('Plan mode is now active');
        expect(
          ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
        ).toBe(false);
        expect(records).toContainEqual({
          event: 'plan_enter_resolved',
          properties: { outcome: 'auto_approved' },
        });
      });
    });
  }
});

describe('ExitPlanModeTool telemetry', () => {
  it('tracks submitted without options and auto approval', async () => {
    const exit = vi.fn();
    const { telemetry, track } = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService({ exit }), telemetry), {
      turnId: '7',
      toolCallId: 'call_exit_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('plan_submitted', { has_options: false });
    expect(track).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });

  it('tracks submitted with options only when multiple options are present', async () => {
    const { telemetry, track } = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService(), telemetry), {
      turnId: '7',
      toolCallId: 'call_exit_plan_options',
      args: { options },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(track).toHaveBeenCalledWith('plan_submitted', { has_options: true });
    expect(track).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });

  it('does not track auto_approved when exitPlanMode fails', async () => {
    const exit = vi.fn(() => {
      throw new Error('state transition failure');
    });
    const { telemetry, track } = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService({ exit }), telemetry), {
      turnId: '7',
      toolCallId: 'call_exit_plan_fail',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to exit plan mode');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('plan_submitted', { has_options: false });
    expect(track).not.toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });
});
