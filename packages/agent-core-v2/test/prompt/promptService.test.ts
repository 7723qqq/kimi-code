import { describe, expect, it, onTestFinished } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentLoopService } from '#/agent/loop';
import { AgentPromptService, IAgentPromptService } from '#/agent/prompt';
import type { PromptSubmitContext } from '#/agent/prompt';
import { IAgentContextMemoryService, type ContextMessage } from '#/agent/contextMemory';
import { IAgentRecordService } from '#/agent/record';
import { IAgentTurnService } from '#/agent/turn';

import { stubContextMemory, stubRecord } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubTurn } from '../turn/stubs';

function userMessage(text: string, origin: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function createHarness() {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());

  const context = stubContextMemory();
  const turn = stubTurn();
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentTurnService, turn);
      reg.defineInstance(IAgentRecordService, stubRecord());
      reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
      reg.define(IAgentPromptService, AgentPromptService);
    },
  });

  return {
    context,
    prompt: ix.get(IAgentPromptService),
    turn,
  };
}

describe('AgentPromptService', () => {
  it('runs submit hooks for any prompt and steer origin', async () => {
    const { prompt, turn } = createHarness();
    const seen: Array<Pick<PromptSubmitContext, 'isSteer'> & {
      readonly originKind: string | undefined;
    }> = [];

    prompt.hooks.onWillSubmitPrompt.register('capture', async (ctx, next) => {
      seen.push({ isSteer: ctx.isSteer, originKind: ctx.promptMessage.origin?.kind });
      await next();
    });

    await prompt.prompt(userMessage('from prompt', { kind: 'system_trigger', name: 'test_prompt' }));
    await prompt.steer(userMessage('from steer', { kind: 'system_trigger', name: 'test_steer' }));

    expect(seen).toEqual([
      { isSteer: false, originKind: 'system_trigger' },
      { isSteer: true, originKind: 'system_trigger' },
    ]);
    expect(turn.launches).toHaveLength(2);
  });

  it('blocks launch when the hook sets block', async () => {
    const { context, prompt, turn } = createHarness();

    prompt.hooks.onWillSubmitPrompt.register('block', async (ctx) => {
      ctx.block = true;
    });

    const result = await prompt.prompt(
      userMessage('blocked', { kind: 'system_trigger', name: 'test_block' }),
    );

    expect(result).toBeUndefined();
    expect(turn.launches).toEqual([]);
    expect(context.messages).toHaveLength(1);
  });
});
