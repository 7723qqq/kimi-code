import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IFlagService } from '#/app/flag/flag';
import {
  ISessionPromptOptimizerService,
  PROMPT_OPTIMIZER_FLAG_ID,
  PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH,
  PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS,
  PROMPT_OPTIMIZER_MAX_INPUT_LENGTH,
  PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH,
  PROMPT_OPTIMIZER_PROFILE_NAME,
  PROMPT_OPTIMIZER_SYSTEM_PROMPT,
  PROMPT_OPTIMIZER_TOOL_DISABLED_MESSAGE,
  PROMPT_OPTIMIZER_TRUNCATION_MARKER,
} from '#/features/promptOptimizer/promptOptimizer';
import { SessionPromptOptimizerService } from '#/features/promptOptimizer/promptOptimizerService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import type { ToolCall } from '#human/llm/message';

import { stubAgentContext } from '../../agent/agentContext/stubs';
import {
  stubToolExecutorEvents,
  type ToolExecutorEventStubs,
} from '../../agent/toolExecutor/stubs';

const CONTEXT = { cwd: 'C:/work/demo' };

describe('SessionPromptOptimizerService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let formatDenyMessage: ReturnType<typeof vi.fn>;
  let executorEvents: ToolExecutorEventStubs;
  let run: ReturnType<typeof vi.fn<(agent: unknown, request: unknown) => Promise<unknown>>>;
  let remove: ReturnType<typeof vi.fn>;
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
    ix.stub(ILogService, {
      _serviceBrand: undefined,
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ILogService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: (id: string) => (id === PROMPT_OPTIMIZER_FLAG_ID ? enabled : false),
    } as unknown as IFlagService);
    ix.set(ISessionPromptOptimizerService, new SyncDescriptor(SessionPromptOptimizerService));
  });
  afterEach(() => disposables.dispose());

  it('defines the draft as a pointer and asks for the full request', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(/The draft is a pointer, not the whole request/);
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(/Write that request out in full/);
  });

  it('requires the real referent behind a vague reference', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(
      /Put the real name behind every vague reference/,
    );
  });

  it('requires stating what the user is working from but has not written down', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(
      /State what the user is clearly working from but has not written down/,
    );
  });

  it('allows the rewrite to grow, and says why it may', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(/Getting longer is expected/);
  });

  it('grounds every added detail and forbids inventing one', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(
      /Every sentence must carry something the user meant/,
    );
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(
      /do not invent requirements or background that nothing shows they have in mind/,
    );
  });

  it('still rejects a rewrite that only swaps in grander wording', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(
      /restating a draft in grander or more formal wording adds nothing/,
    );
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).not.toMatch(/the user did not imply/);
  });

  it('keeps the language and no-answer constraints', () => {
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(/Write in the draft's language/);
    expect(PROMPT_OPTIMIZER_SYSTEM_PROMPT).toMatch(/Do not answer the draft/);
  });

  it('returns the rewritten prompt and disposes the throwaway agent', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    const result = await svc.optimize('fix the thing', CONTEXT);

    expect(result).toBe('Rewritten prompt.');
    expect(remove).toHaveBeenCalled();
  });

  it('forks the child onto the optimizer profile so it does not inherit the coding persona', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const fork = ix.get(IAgentLifecycleService).fork as unknown as ReturnType<typeof vi.fn>;
    const options = fork.mock.calls[0]?.[1] as { binding?: { profile?: string } };
    expect(options.binding?.profile).toBe(PROMPT_OPTIMIZER_PROFILE_NAME);
  });

  it('bounds the inherited history by the engine limit when the caller sends no turns', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const fork = ix.get(IAgentLifecycleService).fork as unknown as ReturnType<typeof vi.fn>;
    const options = fork.mock.calls[0]?.[1] as { inheritedHistory?: { maxUserTurns?: number } };
    expect(options.inheritedHistory?.maxUserTurns).toBe(PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS);
  });

  it('never inherits more turns than the engine limit, however many the caller sends', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    const turns = Array.from(
      { length: PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS + 4 },
      (_, i) => `turn-${i}`,
    );
    await svc.optimize('fix the thing', { ...CONTEXT, recentTurns: turns });

    const fork = ix.get(IAgentLifecycleService).fork as unknown as ReturnType<typeof vi.fn>;
    const options = fork.mock.calls[0]?.[1] as { inheritedHistory?: { maxUserTurns?: number } };
    expect(options.inheritedHistory?.maxUserTurns).toBe(PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS);
  });

  it('honors a smaller caller-requested window', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', { ...CONTEXT, recentTurns: ['a', 'b'] });

    const fork = ix.get(IAgentLifecycleService).fork as unknown as ReturnType<typeof vi.fn>;
    const options = fork.mock.calls[0]?.[1] as { inheritedHistory?: { maxUserTurns?: number } };
    expect(options.inheritedHistory?.maxUserTurns).toBe(2);
  });

  it('bounds the inherited context by the engine character budget', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const fork = ix.get(IAgentLifecycleService).fork as unknown as ReturnType<typeof vi.fn>;
    const options = fork.mock.calls[0]?.[1] as { inheritedHistory?: { maxChars?: number } };
    expect(options.inheritedHistory?.maxChars).toBe(PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH);
  });

  it('passes the draft and cwd to the child agent', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const prompt = run.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).toContain('fix the thing');
    expect(prompt.prompt).toContain(CONTEXT.cwd);
  });

  it('does not repeat the conversation context the fork already copied', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', { ...CONTEXT, sessionKey: 'session-1' });

    const prompt = run.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).not.toContain('Recent conversation:');
  });

  it('vetoes a tool call outside the read-only allowlist', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    for (const name of ['Bash', 'Write', 'Edit', 'Agent']) {
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

  it('lets the read-only tools through so the child can resolve ambiguity', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    for (const name of ['Read', 'Glob', 'Grep']) {
      const toolCall: ToolCall = { type: 'function', id: `call_${name}`, name, arguments: '{}' };
      const decision = await executorEvents.fireBeforeExecute({
        turnId: 0,
        signal: new AbortController().signal,
        toolCall,
        toolCalls: [toolCall],
        args: {},
        execution: { approvalRule: name, execute: async () => ({ output: '' }) },
      });

      expect(decision).toBeUndefined();
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

  it('rejects an over-long rewrite instead of returning it truncated', async () => {
    stubRunSummary('x'.repeat(PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH + 500));
    const svc = ix.get(ISessionPromptOptimizerService);
    await expect(svc.optimize('fix the thing', CONTEXT)).rejects.toThrow(/over the .* limit/i);
  });

  it('marks a draft that exceeds the input limit as truncated', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    const draft = 'y'.repeat(PROMPT_OPTIMIZER_MAX_INPUT_LENGTH + 100);
    await svc.optimize(draft, CONTEXT);

    const prompt = run.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).not.toContain(draft);
    expect(prompt.prompt).toContain('y'.repeat(16));
    expect(prompt.prompt).toContain(PROMPT_OPTIMIZER_TRUNCATION_MARKER);
  });

  it('does not mark a draft that fits as truncated', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const prompt = run.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).not.toContain(PROMPT_OPTIMIZER_TRUNCATION_MARKER);
  });

  it('keeps a draft that fits whole', async () => {
    const svc = ix.get(ISessionPromptOptimizerService);
    await svc.optimize('fix the thing', CONTEXT);

    const prompt = run.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).toContain('fix the thing');
  });

  it('logs when the throwaway agent cannot be removed', async () => {
    remove.mockRejectedValueOnce(new Error('remove exploded'));
    const warn = vi.fn();
    ix.stub(ILogService, { _serviceBrand: undefined, warn } as unknown as ILogService);
    const svc = ix.get(ISessionPromptOptimizerService);

    await expect(svc.optimize('fix the thing', CONTEXT)).resolves.toBe('Rewritten prompt.');
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a second rewrite while one is already running for the session', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    run = vi.fn(async () => ({
      agentId: 'agent-opt-1',
      turn: {},
      completion: gate.then(() => ({ summary: 'Rewritten prompt.' })),
    }));
    const svc = ix.get(ISessionPromptOptimizerService);

    const first = svc.optimize('fix the thing', { ...CONTEXT, sessionKey: 'session-1' });
    await expect(
      svc.optimize('fix the thing again', { ...CONTEXT, sessionKey: 'session-1' }),
    ).rejects.toThrow(/already running/i);

    release?.();
    await expect(first).resolves.toBe('Rewritten prompt.');
  });

  it('allows a rewrite for a different session while one is running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    run = vi.fn(async () => {
      calls++;
      return {
        agentId: 'agent-opt-1',
        turn: {},
        completion: gate.then(() => ({ summary: 'Rewritten prompt.' })),
      };
    });
    const svc = ix.get(ISessionPromptOptimizerService);

    const first = svc.optimize('fix the thing', { ...CONTEXT, sessionKey: 'session-1' });
    const second = svc.optimize('fix the other thing', { ...CONTEXT, sessionKey: 'session-2' });

    release?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });
});
