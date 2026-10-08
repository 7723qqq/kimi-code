import { describe, expect, it, vi } from 'vitest';

import type { IAgentModeMutexService, ExclusiveReviewMode } from '#/agent/modeMutex/modeMutex';
import { IAgentPlanService, type PlanData } from '#/features/plan/plan';
import { EnterPlanModeTool } from '#/features/plan/tools/enter-plan-mode/enterPlanModeTool';
import { IAgentSpecService, type SpecData } from '#/features/spec/spec';
import { EnterSpecModeTool } from '#/features/spec/tools/enter-spec-mode/enterSpecModeTool';
import type { ToolResult } from '#/tool/toolContract';

import { recordingTelemetry } from '../../app/telemetry/stubs';

const SPEC_DIR = '/ws/specs/spec-1';

function specData(): SpecData {
  return {
    id: 'spec-1',
    dir: SPEC_DIR,
    files: { 'requirements.md': '# r', 'design.md': '# d', 'tasks.md': '# t' },
    missing: [],
    complete: true,
    stage: 'implement',
    progress: '',
  };
}

function mutex(): {
  readonly service: IAgentModeMutexService;
  readonly switchTo: ReturnType<typeof vi.fn>;
  readonly leave: ReturnType<typeof vi.fn>;
  active: ExclusiveReviewMode | null;
} {
  const holder = {
    active: null as ExclusiveReviewMode | null,
    switchTo: vi.fn(async (target: ExclusiveReviewMode) => {
      holder.active = target;
    }),
    leave: vi.fn(async () => {
      holder.active = null;
    }),
  };
  const service: IAgentModeMutexService = {
    _serviceBrand: undefined,
    activeMode: () => holder.active,
    switchTo: holder.switchTo as unknown as IAgentModeMutexService['switchTo'],
    leave: holder.leave as unknown as IAgentModeMutexService['leave'],
  };
  return {
    service,
    switchTo: holder.switchTo,
    leave: holder.leave,
    get active() {
      return holder.active;
    },
    set active(mode: ExclusiveReviewMode | null) {
      holder.active = mode;
    },
  };
}

function specService(status: SpecData | null): IAgentSpecService {
  return {
    _serviceBrand: undefined,
    enter: vi.fn(async () => {}),
    cancel: vi.fn(),
    exit: vi.fn(),
    clear: vi.fn(async () => {}),
    recordRevision: vi.fn(async () => {}),
    status: vi.fn(async () => status),
    activeSpecDir: () => null,
  };
}

function planService(status: PlanData): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: vi.fn(async () => {}),
    cancel: vi.fn(),
    clear: vi.fn(async () => {}),
    exit: vi.fn(),
    recordRevision: vi.fn(async () => {}),
    status: vi.fn(async () => status),
  };
}

async function run(tool: { resolveExecution: (a: never) => { execute: () => Promise<ToolResult> } }) {
  return tool.resolveExecution(undefined as never).execute();
}

describe('EnterSpecModeTool — evicts conflicting modes', () => {
  it('routes entry through the mutex rather than calling spec.enter directly', async () => {
    const m = mutex();
    m.active = 'plan';
    const spec = specService(null);
    const tool = new EnterSpecModeTool(spec, m.service, recordingTelemetry([], {}));

    const result = await run(tool as never);

    expect(m.switchTo).toHaveBeenCalledWith('spec');
    expect(result.isError).toBeFalsy();
  });

  it('names the evicted mode in the output', async () => {
    const m = mutex();
    m.active = 'plan';
    const tool = new EnterSpecModeTool(specService(null), m.service, recordingTelemetry([], {}));

    const result = await run(tool as never);

    expect(result.output).toContain('plan');
  });

  it('does not claim an eviction when nothing was active', async () => {
    const m = mutex();
    const tool = new EnterSpecModeTool(specService(null), m.service, recordingTelemetry([], {}));

    const result = await run(tool as never);

    expect(result.output).not.toContain('Left');
  });

  it('reports failure without evicting when the switch rejects', async () => {
    const m = mutex();
    m.switchTo.mockRejectedValueOnce(new Error('spec directory is not writable'));
    const tool = new EnterSpecModeTool(specService(null), m.service, recordingTelemetry([], {}));

    const result = await run(tool as never);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('spec directory is not writable');
  });
});

describe('EnterPlanModeTool — evicts conflicting modes', () => {
  it('routes entry through the mutex rather than calling plan.enter directly', async () => {
    const m = mutex();
    m.active = 'spec';
    const plan = planService(null);
    const tool = new EnterPlanModeTool(plan, m.service, recordingTelemetry([], {}));

    const result = await run(tool as never);

    expect(m.switchTo).toHaveBeenCalledWith('plan');
    expect(result.isError).toBeFalsy();
  });

  it('names the evicted mode in the output', async () => {
    const m = mutex();
    m.active = 'spec';
    const tool = new EnterPlanModeTool(planService(null), m.service, recordingTelemetry([], {}));

    const result = await run(tool as never);

    expect(result.output).toContain('spec');
  });
});
