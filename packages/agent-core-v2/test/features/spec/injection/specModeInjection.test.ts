import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSpecService } from '#/features/spec/spec';

import { runWillBeginStepHooks, type StubLoop } from '../../../agent/loop/stubs';
import {
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../../harness';
import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';

const SPEC_DIR_NAME = 'specs';

async function enterSpec(
  ctx: TestAgentContext,
  id = 'test-spec',
): Promise<{ spec: IAgentSpecService; dir: string }> {
  const spec = ctx.get(IAgentSpecService);
  await spec.enter(id);
  const status = await spec.status();
  if (status === null) throw new Error('expected an active spec');
  return { spec, dir: status.dir };
}

async function injectDynamic(ctx: TestAgentContext): Promise<void> {
  await runWillBeginStepHooks(ctx.get(IAgentLoopService) as StubLoop, false);
}

function specReminderMessages(
  context: IAgentContextMemoryService,
): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'spec_mode';
  });
}

function lastSpecReminder(context: IAgentContextMemoryService): string {
  const message = specReminderMessages(context).at(-1);
  if (message === undefined) return '';
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function appendAssistantTurn(
  ctx: TestAgentContext,
  context: IAgentContextMemoryService,
  text: string,
): void {
  ctx.appendAssistantTurn(context.get().length, text);
}

describe('SpecModeInjection reminder variants', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let spec: IAgentSpecService;
  let specDir: string;
  let readText: (path: string) => Promise<string>;

  beforeEach(async () => {
    readText = async () => '';
    ctx = createTestAgent(
      execEnvServices({
        hostFs: createFakeHostFs({
          mkdir: vi.fn().mockResolvedValue(undefined),
          readText: (path: string) => readText(path),
          writeText: vi.fn(async () => undefined),
        }),
      }),
    );
    context = ctx.get(IAgentContextMemoryService);
    await ctx.restorePersisted();
    ({ spec, dir: specDir } = await enterSpec(ctx));
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('injects the full reminder with the spec directory on an empty spec', async () => {
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    expect(text).toContain('Acceptance criteria are the part that matters most');
    expect(text).toContain(`Spec directory: ${specDir}`);
  });

  it('injects the reentry reminder when the directory already has a document', async () => {
    readText = async (path: string) =>
      path.endsWith('/requirements.md') ? '# Requirements' : '';
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    expect(text).toContain('Spec mode is already active');
    expect(text).toContain(`Spec directory: ${specDir}`);
  });

  it('does not assert that earlier documents exist in the reentry reminder', async () => {
    readText = async (path: string) =>
      path.endsWith('/requirements.md') ? '# Requirements' : '';
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    // The directory may have content without any prior in-session work, so the
    // wording must not claim documents are there.
    expect(text).toContain('may already contain documents');
    expect(text).not.toContain('earlier documents may be present');
  });

});

describe('SpecModeInjection cadence', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let specDir: string;
  let readText: (path: string) => Promise<string>;

  beforeEach(async () => {
    readText = async () => '';
    ctx = createTestAgent(
      execEnvServices({
        hostFs: createFakeHostFs({
          mkdir: vi.fn().mockResolvedValue(undefined),
          readText: (path: string) => readText(path),
          writeText: vi.fn(async () => undefined),
        }),
      }),
    );
    context = ctx.get(IAgentContextMemoryService);
    await ctx.restorePersisted();
    ({ dir: specDir } = await enterSpec(ctx));
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('skips reinjection before the assistant-turn threshold', async () => {
    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(ctx);

    expect(specReminderMessages(context)).toHaveLength(1);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    expect(text).toContain('Spec mode still active');
    expect(text).toContain(`Spec directory: ${specDir}`);
  });

  it('makes the sparse reminder strictly shorter than the full one', async () => {
    await injectDynamic(ctx);
    const full = lastSpecReminder(context);

    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(ctx);

    expect(lastSpecReminder(context).length).toBeLessThan(full.length);
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    await injectDynamic(ctx);
    for (let i = 0; i < 5; i += 1) {
      appendAssistantTurn(ctx, context, `assistant ${String(i)}`);
    }
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    expect(text).toContain('Acceptance criteria are the part that matters most');
    expect(text).not.toContain('Spec mode still active');
  });

  it('refreshes the full reminder after a user message', async () => {
    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    expect(text).toContain('Acceptance criteria are the part that matters most');
    expect(text).not.toContain('Spec mode still active');
  });

  it('injects the exit reminder once spec mode ends', async () => {
    await injectDynamic(ctx);
    ctx.get(IAgentSpecService).exit();
    await injectDynamic(ctx);

    const text = lastSpecReminder(context);
    expect(text).toContain('Spec mode is no longer active');
  });
});
