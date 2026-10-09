import { afterEach, describe, expect, it } from 'vitest';

import type { ILogger } from '#/_base/log/log';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  isCuratedAdaptationModel,
  loadCuratedAdaptation,
} from '#/app/agentProfileCatalog/modelAdaptations';
import { IEventBus } from '#/app/event/eventBus';
import { PendingAdaptationCache } from '#/features/deepseekAdaptation/deepseekAdaptationService';

import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { createTestAgent, type TestAgentContext } from '../../harness';

const log: ILogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child() {
    return log;
  },
};

const ADAPTATIONS_ENV = 'KIMI_MODEL_ADAPTATIONS';

describe('curated adaptation lookup', () => {
  it('loads the curated family file for a deepseek wire name', async () => {
    const text = await loadCuratedAdaptation('deepseek-v4-pro', log);
    expect(text).toContain('# Model Adaptation: deepseek-v4-pro');
    expect(text).toContain('## Autonomy and persistence');
    expect(text).toContain('Give an evidence-backed response');
    expect(text).toContain('## Worked example');
    expect(text).not.toContain('reference data, not an');
  });

  it('falls back to the family file for a version without its own', async () => {
    const text = await loadCuratedAdaptation('deepseek-v4.1-flash', log);
    expect(text).toContain('# Model Adaptation: deepseek-v4.1-flash');
  });

  it('returns undefined outside the minimal deepseek family', async () => {
    expect(await loadCuratedAdaptation('gpt-4o', log)).toBeUndefined();
    expect(await loadCuratedAdaptation('my-deepseek-clone', log)).toBeUndefined();
    expect(await loadCuratedAdaptation('', log)).toBeUndefined();
  });

  it('routes every deepseek wire name through the curated family file', async () => {
    // The measured/ directory only loads under KIMI_MODEL_ADAPTATIONS=1, and the
    // curated file outranks it as the family default. Pinning the curated-vs-
    // measured decision here means a future change to the precedence cannot
    // silently make the curated guidance unreachable.
    for (const wire of [
      'deepseek-v3',
      'deepseek-v4-pro',
      'deepseek-flash',
      'workbuddy/deepseek-v4.1-flash',
      'xopdeepseekv32',
    ]) {
      expect(isCuratedAdaptationModel(wire)).toBe(true);
      expect(await loadCuratedAdaptation(wire, log)).toContain('# Model Adaptation:');
    }
  });
});

describe('PendingAdaptationCache', () => {
  it('reads once when callers race the same key', async () => {
    const cache = new PendingAdaptationCache<string>();
    let loads = 0;
    const load = async (): Promise<string | undefined> => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'text';
    };

    const [first, second, third] = await Promise.all([
      cache.load('deepseek-v4-pro', load),
      cache.load('deepseek-v4-pro', load),
      cache.load('deepseek-v4-pro', load),
    ]);

    expect(loads).toBe(1);
    expect(first).toBe('text');
    expect(second).toBe('text');
    expect(third).toBe('text');
  });

  it('remembers a missing adaptation instead of re-reading every step', async () => {
    const cache = new PendingAdaptationCache<string>();
    let loads = 0;
    const load = async (): Promise<string | undefined> => {
      loads += 1;
      return undefined;
    };

    await cache.load('gpt-4o', load);
    await cache.load('gpt-4o', load);

    expect(loads).toBe(1);
    expect(cache.size).toBe(1);
  });
});

type TestConfig = {
  providers: Record<string, unknown>;
  models: Record<string, Record<string, unknown>>;
};

function deepseekConfig(model: string): TestConfig {
  return {
    providers: {
      deepseek: { type: 'openai', apiKey: 'test-key', baseUrl: 'https://api.deepseek.test/v1' },
    },
    models: { ds: { provider: 'deepseek', model, maxContextSize: 1_000_000 } },
  };
}

function deepseekInjections(
  context: IAgentContextMemoryService,
): readonly { readonly role: string; readonly text: string }[] {
  return context
    .get()
    .filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'deepseek_adaptation',
    )
    .map((message) => {
      const part = message.content[0];
      return { role: message.role, text: part?.type === 'text' ? part.text : '' };
    });
}

function spliceContext(
  ctx: TestAgentContext,
  start: number,
  deleteCount: number,
  inserted: readonly ContextMessage[],
): void {
  const backing = [...ctx.agentState.get(contextMemoryKey)];
  backing.splice(start, deleteCount, ...inserted);
  ctx.agentState.set(contextMemoryKey, backing);
  ctx.get(IEventBus).publish(
    new ContextSpliced({ agentId: 'main', start, deleteCount, messages: [...inserted] }),
    ctx.agentContext,
  );
}

describe('DeepSeek minimal adaptation injection', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  async function boot(model: string): Promise<{
    context: IAgentContextMemoryService;
    loop: StubLoop;
  }> {
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig(model) as never,
    });
    await ctx.restorePersisted();
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });
    return {
      context: ctx.get(IAgentContextMemoryService),
      loop: ctx.get(IAgentLoopService) as StubLoop,
    };
  }

  it('injects the curated adaptation as a user-role reminder for a deepseek model', async () => {
    const { context, loop } = await boot('deepseek-v4-pro');
    await runWillBeginStepHooks(loop, true);

    const injected = deepseekInjections(context);
    expect(injected).toHaveLength(1);
    expect(injected[0]?.role).toBe('user');
    expect(injected[0]?.text).toContain('# Model Adaptation: deepseek-v4-pro');
    expect(injected[0]?.text).toContain('<system-reminder>');
  });

  it('injects nothing for a model outside the deepseek family', async () => {
    const { context, loop } = await boot('gpt-4o');
    await runWillBeginStepHooks(loop, true);

    expect(deepseekInjections(context)).toHaveLength(0);
  });

  it('does not inject a second copy while the first survives', async () => {
    const { context, loop } = await boot('deepseek-v4-pro');
    await runWillBeginStepHooks(loop, true);
    await runWillBeginStepHooks(loop, true);

    expect(deepseekInjections(context)).toHaveLength(1);
  });

  it('re-injects after compaction drops the injected message', async () => {
    const { context, loop } = await boot('deepseek-v4-pro');
    await runWillBeginStepHooks(loop, true);
    expect(deepseekInjections(context)).toHaveLength(1);

    const summary: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Compacted summary.' }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
    spliceContext(ctx!, 0, context.get().length, [summary]);
    await runWillBeginStepHooks(loop, true);

    expect(deepseekInjections(context)).toHaveLength(1);
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'deepseek_adaptation',
    });
  });
});

describe('DeepSeek adaptation under KIMI_MODEL_ADAPTATIONS=1', () => {
  let ctx: TestAgentContext | undefined;
  const originalEnv = process.env[ADAPTATIONS_ENV];

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    if (originalEnv === undefined) delete process.env[ADAPTATIONS_ENV];
    else process.env[ADAPTATIONS_ENV] = originalEnv;
  });

  async function bootAndInject(model: string): Promise<string> {
    process.env[ADAPTATIONS_ENV] = '1';
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig(model) as never,
    });
    await ctx.restorePersisted();
    await ctx.get(IAgentProfileService).bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: 'ds',
    });
    const loop = ctx.get(IAgentLoopService) as StubLoop;
    await runWillBeginStepHooks(loop, true);
    const injected = deepseekInjections(ctx.get(IAgentContextMemoryService));
    expect(injected).toHaveLength(1);
    return injected[0]?.text ?? '';
  }

  it('delivers the measured file through the reminder channel for deepseek-v3', async () => {
    // End to end: the measured file is reachable only under this flag, the
    // prompt shape for this family is `minimal` so the system-prompt path
    // cannot carry it, and the reminder injection is therefore the only route
    // by which it can reach the model. Pinning the shipped text here means a
    // precedence change that silences the measured file fails loudly instead of
    // quietly reverting to the curated family guidance.
    const text = await bootAndInject('deepseek-v3');

    expect(text).toContain('# Model Adaptation: deepseek-v3');
    expect(text).toContain('Negation Rewrite Patch');
    expect(text).toMatch(/reference data, not an/);
    expect(text).not.toContain('standing instructions for how to work');
  });

  it('falls back to the curated family file when no measured file exists', async () => {
    const text = await bootAndInject('deepseek-v4-pro');

    expect(text).toContain('# Model Adaptation: deepseek-v4-pro');
    expect(text).toContain('standing instructions for how to work');
    expect(text).not.toContain('Negation Rewrite Patch');
  });

  it('leaves the system prompt minimal under the opt-in', async () => {
    process.env[ADAPTATIONS_ENV] = '1';
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('deepseek-v3') as never,
    });
    await ctx.restorePersisted();
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    // The adaptation reaches the model as a reminder, never as a prompt section.
    expect(profile.getSystemPrompt()).not.toContain('# Model Adaptation');
  });
});
