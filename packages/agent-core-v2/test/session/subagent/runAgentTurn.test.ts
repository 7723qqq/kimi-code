import { describe, expect, it } from 'bun:test';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  type Turn,
  type TurnResult,
} from '#/agent/loop/loop';
import { AssistantDelta, TurnStepStarted } from '#/agent/loop/turnEvents';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { ErrorCodes, isError2 } from '#/errors';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';

type BusHandler = (event: unknown) => void;

class FakeEventBus {
  private readonly handlers = new Map<unknown, Set<BusHandler>>();

  subscribe(type: unknown, handler: BusHandler): { dispose: () => void } {
    const set = this.handlers.get(type) ?? new Set<BusHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    return {
      dispose: () => {
        set.delete(handler);
      },
    };
  }

  emit(type: unknown, event: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
  }
}

function makeTurn(result: TurnResult): Turn {
  const controller = new AbortController();
  return {
    id: 1,
    signal: controller.signal,
    ready: Promise.resolve(),
    result: Promise.resolve(result),
    cancel: () => {
      controller.abort();
      return true;
    },
  };
}

function assistant(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function handleWith(
  turn: Turn,
  messages: readonly ContextMessage[],
): { readonly handle: IAgentScopeHandle; readonly prompts: unknown[] } {
  const prompts: unknown[] = [];
  const bus = new FakeEventBus();
  const textOf = (message: ContextMessage): string =>
    message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  const services = new Map<unknown, unknown>([
    [
      IAgentLoopService,
      {
        submit: (input: unknown) => {
          prompts.push(input);
          return { id: 'p' };
        },
        promptHandle: () => {
          bus.emit(TurnStepStarted, { turnId: turn.id });
          for (const message of messages) {
            if (message.role !== 'assistant') continue;
            bus.emit(AssistantDelta, { turnId: turn.id, delta: textOf(message) });
          }
          return { launched: Promise.resolve(turn) };
        },
        cancel: () => true,
      },
    ],
    [IAgentContextMemoryService, { get: () => messages }],
    [IEventBus, bus],
  ]);
  const handle: IAgentScopeHandle = {
    id: 'agent-child',
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((id: unknown) => services.get(id)) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
  return { handle, prompts };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('runAgentTurn', () => {
  const signal = new AbortController().signal;

  it('returns a short final message as is without a continuation prompt', async () => {
    const { handle, prompts } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('src/a.ts:12')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    await expect(run.completion).resolves.toMatchObject({ summary: 'src/a.ts:12' });
    expect(prompts).toHaveLength(1);
  });

  it('carries the loop stop reason alongside the handoff text', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 13, truncated: false, stopReason: 'repeat_breaker' }),
      [assistant('Stuck: the same grep keeps returning nothing.')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    await expect(run.completion).resolves.toMatchObject({
      summary: 'Stuck: the same grep keeps returning nothing.',
      stopReason: 'repeat_breaker',
    });
  });

  it('fails with agent.no_final_message when the turn ends without text', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 13, truncated: false, stopReason: 'repeat_breaker' }),
      [assistant('')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);
    expect(isError2(error) && error.code).toBe(ErrorCodes.AGENT_NO_FINAL_MESSAGE);
    expect((error as Error).message).toContain('stop reason: repeat_breaker');
  });

  it('rewrites the step-cap failure into a model-facing message', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'failed', steps: 5, error: createMaxStepsExceededError(5) }),
      [assistant('partial work')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);
    expect(isError2(error) && error.code).toBe(ErrorCodes.LOOP_MAX_STEPS_EXCEEDED);
    expect((error as Error).message).toContain('maxSteps=5');
    expect((error as Error).message).not.toContain('config.toml');
  });

  it('still reports max tokens as a failure', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: true }),
      [assistant('cut off')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);
    expect(isError2(error) && error.code).toBe(ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED);
  });

  it('stamps a plain subagent origin when no helper is named', async () => {
    const { handle, prompts } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('ok')],
    );
    await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });

    const submitted = prompts[0] as { meta: { origin: { kind: string; backgroundHelper?: string } } };
    expect(submitted.meta.origin.kind).toBe('system_trigger');
    expect(submitted.meta.origin.backgroundHelper).toBeUndefined();
  });

  it('carries the helper label on the turn origin when one is named', async () => {
    const { handle, prompts } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('ok')],
    );
    await runAgentTurn(
      handle,
      { kind: 'prompt', prompt: 'find it', helper: 'prompt_optimizer' },
      { signal },
    );

    const submitted = prompts[0] as {
      meta: { origin: { kind: string; name: string; backgroundHelper?: string } };
    };
    expect(submitted.meta.origin).toMatchObject({
      kind: 'system_trigger',
      name: 'subagent',
      backgroundHelper: 'prompt_optimizer',
    });
  });
});
