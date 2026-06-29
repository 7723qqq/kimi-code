import { describe, expect, it } from 'vitest';

import type { IPermissionModeService } from '#/permissionMode';
import type { IProfileService } from '#/profile';
import type { IPromptService } from '#/prompt';
import type { ITurnService, Turn, TurnResult } from '#/turn';
import type { PromptSubmission } from '@moonshot-ai/protocol';

import { PromptLegacyService } from '#/promptLegacy';

interface ControlledTurn {
  readonly turn: Turn;
  readonly settle: (result: TurnResult) => void;
}

function controlledTurn(id: number): ControlledTurn {
  let settle!: (result: TurnResult) => void;
  const result = new Promise<TurnResult>((resolve) => {
    settle = resolve;
  });
  const turn: Turn = {
    id,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result,
  };
  return { turn, settle };
}

function textBody(text: string): PromptSubmission {
  return { content: [{ type: 'text', text }] };
}

interface Harness {
  readonly service: PromptLegacyService;
  readonly turns: Turn[];
  readonly settleActive: (result: TurnResult) => void;
  readonly steered: string[];
}

function createHarness(): Harness {
  let nextTurnId = 0;
  let activeTurn: Turn | undefined;
  let activeSettle: ((result: TurnResult) => void) | undefined;
  const turns: Turn[] = [];
  const steered: string[] = [];

  const prompt: IPromptService = {
    prompt: () => {
      if (activeTurn !== undefined) return undefined;
      const { turn, settle } = controlledTurn(nextTurnId++);
      activeTurn = turn;
      activeSettle = settle;
      turns.push(turn);
      void turn.result.then(() => {
        if (activeTurn === turn) {
          activeTurn = undefined;
          activeSettle = undefined;
        }
      });
      return turn;
    },
    steer: (message) => {
      for (const part of message.content) {
        if (part.type === 'text') steered.push(part.text);
      }
      return undefined;
    },
    retry: () => undefined,
    undo: () => 0,
    clear: () => {},
  };

  const turnService: ITurnService = {
    launch: () => {
      throw new Error('not used');
    },
    getActiveTurn: () => activeTurn,
    hooks: {
      onLaunched: { run: async () => {} },
      onEnded: { run: async () => {} },
      beforeStep: { run: async () => {} },
      afterStep: { run: async () => {} },
    },
  } as unknown as ITurnService;

  const profile = {
    setModel: () => Promise.resolve({ model: '' }),
    setThinking: () => {},
  } as unknown as IProfileService;

  const permissionMode = {
    setMode: () => {},
  } as unknown as IPermissionModeService;

  const service = new PromptLegacyService(prompt, turnService, profile, permissionMode);
  return {
    service,
    turns,
    steered,
    settleActive: (result) => activeSettle?.(result),
  };
}

describe('PromptLegacyService', () => {
  it('launches a turn on submit and reports running', async () => {
    const { service, turns } = createHarness();
    const result = await service.submit(textBody('hi'));
    expect(result.status).toBe('running');
    expect(result.prompt_id).toMatch(/^prompt_/);
    expect(turns).toHaveLength(1);
    expect(service.list().active?.prompt_id).toBe(result.prompt_id);
  });

  it('queues a second submit while a turn is active', async () => {
    const { service, turns } = createHarness();
    const first = await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    expect(second.status).toBe('queued');
    expect(turns).toHaveLength(1);
    const list = service.list();
    expect(list.active?.prompt_id).toBe(first.prompt_id);
    expect(list.queued.map((q) => q.prompt_id)).toEqual([second.prompt_id]);
  });

  it('auto-launches the next queued prompt when the active turn settles', async () => {
    const { service, turns, settleActive } = createHarness();
    await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    settleActive({ reason: 'completed' });
    await Promise.resolve();
    expect(turns).toHaveLength(2);
    expect(service.list().active?.prompt_id).toBe(second.prompt_id);
  });

  it('aborts the active prompt and starts the next queued on settle', async () => {
    const { service, turns, settleActive } = createHarness();
    const first = await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    const aborted = await service.abort(first.prompt_id);
    expect(aborted.aborted).toBe(true);
    settleActive({ reason: 'cancelled' });
    await Promise.resolve();
    expect(turns).toHaveLength(2);
    expect(service.list().active?.prompt_id).toBe(second.prompt_id);
  });

  it('removes a queued prompt on abort', async () => {
    const { service } = createHarness();
    await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    const aborted = await service.abort(second.prompt_id);
    expect(aborted.aborted).toBe(true);
    expect(service.list().queued).toEqual([]);
  });

  it('steers queued prompts into the active turn', async () => {
    const { service, steered } = createHarness();
    await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    const result = await service.steer([second.prompt_id]);
    expect(result.steered).toBe(true);
    expect(result.prompt_ids).toEqual([second.prompt_id]);
    expect(steered).toEqual(['second']);
    expect(service.list().queued).toEqual([]);
  });

  it('throws PROMPT_NOT_FOUND when aborting an unknown prompt', async () => {
    const { service } = createHarness();
    await expect(service.abort('prompt_missing')).rejects.toMatchObject({
      code: 'prompt.not_found',
    });
  });

  it('throws PROMPT_NOT_FOUND when steering with no active turn', async () => {
    const { service } = createHarness();
    await expect(service.steer(['prompt_x'])).rejects.toMatchObject({
      code: 'prompt.not_found',
    });
  });
});
