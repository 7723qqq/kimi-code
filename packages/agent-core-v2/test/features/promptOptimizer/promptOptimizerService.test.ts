import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import {
  ISessionPromptOptimizerService,
  PROMPT_OPTIMIZER_FLAG_ID,
  PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH,
  PROMPT_OPTIMIZER_SYSTEM_REMINDER,
  PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE,
} from '#/features/promptOptimizer/promptOptimizer';
import { SessionPromptOptimizerService } from '#/features/promptOptimizer/promptOptimizerService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import type { ToolCall } from '#human/llm/message';

import { stubAgentContext } from '../../agent/agentContext/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';

const CONTEXT = { cwd: 'C:/work/demo', recentTurns: 'user: fix the parser' };

describe('SessionPromptOptimizerService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let appendReminder: ReturnType<typeof vi.fn>;
  let formatDenyMessage: ReturnType<typeof vi.fn>;
  let executorEvents: ToolExecutorEventStubs;
  let run: ReturnType<typeof vi.fn<(agent: unknown, request: unknown) => Promise<unknown>>>;  let remove: ReturnType<typeof vi.fn>;
  let enabled: boolean;

  function stubRunSummary(summary: string): void {
    run = vi.fn(async () => ({
      agentId: 'agent-opt-1',
      turn: {},
      completion: Promise.resolve({ summary }),
    }));
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    appendReminder = vi.fn(() => 'reminder-id');
    formatDenyMessage = vi.fn((message: string) => `${message} [worker guidance]`);
    executorEvents = stubToolExecutorEvents();
    remove = vi.fn(async () => {});
    enabled = true;
    stubRunSummary('Rewritten prompt.');

    const child = {
      id: 'agent-opt-1',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentToolApprovalService) return { formatDenyMessage };
          if (id === IAgentToolExecutorService) return executorEvents.executor;
          if (id === IAgentReminderService) return { notify: appendReminder };
          return undefined;
        },
      },
    };
    const main = {
      id: MAIN_AGENT_ID,
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentScopeContext) {
            return {
              _serviceBrand: undefined,
              agentId: MAIN_AGENT_ID,
              agentContext: stubAgentContext(MAIN_AGENT_ID, 1),
              scope: (subKey?: string) => subKey ?? '',
            };
          }
          return undefined;
        },
      },
    };
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      fork: vi.fn(async () => stubAgentContext('agent-opt-1', 2)),
      remove,
      handleOf: (id: string) => {
        if (id === MAIN_AGENT_ID) return main;
        if (id === 'agent-opt-1') return child;
        return undefined;
      },
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionSubagentService, {
      _serviceBrand: undefined,
      run: (agent: unknown, request: unknown) => run(agent, request),
    } as unknown as ISessionSubagentService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: (id: string) => (id === PROMPT_OPTIMIZER_FLAG_ID ? enabled : false),
    } as unknown as IFlagService);
    ix.set(ISessionPromptOptimizerService, new SyncDescriptor(SessionPromptOptimizerService));
  });
  afterEach(() => disposables.dispose());

  it('returns the rewritten prompt and disposes the throwaway agent', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    const result = await svc.optimize('fix the thing', CONTEXT);

    expect(result).toBe('Rewritten prompt.');
    expect(appendReminder).toHaveBeenCalledWith(PROMPT_OPTIMIZER_SYSTEM_REMINDER, {
      variant: 'prompt_optimizer',
    });
    expect(remove).toHaveBeenCalled();
  });

  it('passes the draft, cwd and recent turns to the child agent', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const prompt = run.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).toContain('fix the thing');
    expect(prompt.prompt).toContain(CONTEXT.cwd);
    expect(prompt.prompt).toContain('fix the parser');
  });

  it('vetoes every tool call on the child', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    for (const name of ['Read', 'Grep', 'Bash', 'Write']) {
      const toolCall: ToolCall = { type: 'function', id: `call_${name}`, name, arguments: '{}' };
      const decision = await executorEvents.fireBeforeExecute({
        turnId: 0,
        signal: new AbortController().signal,
        toolCall,
        toolCalls: [toolCall],
        args: {},
        execution: { approvalRule: name, execute: async () => ({ output: '' }) },
      });

      expect(decision).toEqual({
        veto: {
          output: `${PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE} [worker guidance]`,
          isError: true,
        },
      });
    }
  });

  it('rejects an empty draft without forking', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await expect(svc.optimize('   ', CONTEXT)).rejects.toThrow(/no prompt to rewrite/i);
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects when the experimental flag is off', async () => {
    enabled = false;
    const svc = ix.get(ISessionPromptOptimizerService);
    await expect(svc.optimize('fix the thing', CONTEXT)).rejects.toThrow(/disabled/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects when the optimizer returns no text', async () => {
    stubRunSummary('   ');
    const svc = ix.get(ISessionPromptOptimizerService);
    await expect(svc.optimize('fix the thing', CONTEXT)).rejects.toThrow(/returned no text/i);
    expect(remove).toHaveBeenCalled();
  });

  it('truncates an over-long rewrite', async () => {
    stubRunSummary('x'.repeat(PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH + 500));
    const svc = ix.get(ISessionPromptOptimizerService);
    const result = await svc.optimize('fix the thing', CONTEXT);
    expect(result).toHaveLength(PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH);
  });
});
