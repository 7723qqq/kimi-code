import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  adaptationDeliveredByReminder,
  hasCuratedAdaptation,
  loadCuratedAdaptation,
} from '#/app/agentProfileCatalog/modelAdaptations';
import { IEventBus } from '#/app/event/eventBus';
import { PendingAdaptationCache } from '#/features/deepseekAdaptation/deepseekAdaptationService';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { createTestAgent, logServices, type TestAgentContext } from '../../harness';

const log: ILogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child() {
    return log;
  },
};

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
    // The family prefix is the only key: every deepseek-shaped name resolves to
    // the single curated file, so a new versioned or provider-qualified id does
    // not need its own adaptation file to receive guidance.
    for (const wire of [
      'deepseek-v3',
      'deepseek-v4-pro',
      'deepseek-flash',
      'workbuddy/deepseek-v4.1-flash',
      'xopdeepseekv32',
    ]) {
      expect(hasCuratedAdaptation(wire)).toBe(true);
      expect(adaptationDeliveredByReminder(wire)).toBe(true);
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
  const tempDirs: string[] = [];

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
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

  it('reports the variables the minimal shape cannot carry, but not the adaptation', async () => {
    // Two halves of the same mechanism. The minimal template drops most of its
    // context, so `applyProfile` must report those losses — that is what makes a
    // silent drop visible. The adaptation is *not* among them: this family is
    // served by the reminder channel, so the prompt path declines the file
    // rather than load it into a variable the template then discards. Without
    // that gate the guidance would be fetched, thrown away, and reported as
    // dropped on every applyProfile.
    //
    // Only `applyProfile` warns (`bind` renders without reporting), and the
    // logger is opt-in in the harness, so both have to be wired explicitly.
    const workDir = await mkdtemp(join(tmpdir(), 'ds-adapt-'));
    tempDirs.push(workDir);
    await writeFile(join(workDir, 'AGENTS.md'), 'PROJECT RULES', 'utf-8');
    const warnings: { message: string }[] = [];
    ctx = createTestAgent(
      logServices({
        warn: (message: string) => {
          warnings.push({ message });
        },
        info: () => {},
        debug: () => {},
        error: () => {},
        createChild: () => undefined as never,
      }),
      {
        autoConfigure: false,
        initialConfig: deepseekConfig('deepseek-v4-pro') as never,
        cwd: workDir,
      },
    );
    await ctx.restorePersisted();
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });
    const resolved = ctx.get(ISessionAgentProfileCatalog).get(DEFAULT_AGENT_PROFILE_NAME);
    expect(resolved).toBeDefined();

    await profile.applyProfile(resolved!);

    expect(profile.getSystemPrompt()).not.toContain('PROJECT RULES');
    expect(profile.getSystemPrompt()).not.toContain('standing instructions for how to work');

    const dropped = warnings.filter((w) => w.message.includes('ignored supplied variables'));
    // The loss is reported...
    expect(dropped.length, JSON.stringify(warnings)).toBeGreaterThan(0);
    // ...and the adaptation is not among what was lost, because it never loaded.
    for (const warning of dropped) {
      expect(warning.message).not.toContain('model_adaptation_section');
    }
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

describe('DeepSeek adaptation delivery end to end', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  async function bootAndInject(model: string): Promise<string> {
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

  it('delivers the curated family guidance through the reminder channel', async () => {
    // End to end: this family's prompt shape is `minimal`, so the system-prompt
    // path cannot carry the guidance, and the reminder injection is the only
    // route by which it reaches the model. Pinning the shipped text here means a
    // change that silences the reminder fails loudly rather than quietly leaving
    // the model without its family guidance.
    const text = await bootAndInject('deepseek-v4-pro');

    expect(text).toContain('# Model Adaptation: deepseek-v4-pro');
    expect(text).toContain('standing instructions for how to work');
    expect(text).toContain('## Autonomy and persistence');
    expect(text).toMatch(/<system-reminder>/);
  });

  it('carries the same guidance for a versioned wire name', async () => {
    // The family prefix is the only key, so a dated or differently-versioned id
    // still receives guidance without an adaptation file of its own.
    const text = await bootAndInject('deepseek-v3');

    expect(text).toContain('# Model Adaptation: deepseek-v3');
    expect(text).toContain('standing instructions for how to work');
    expect(text).not.toContain('Negation Rewrite Patch');
  });

  it('keeps the system prompt minimal so the prompt path stays empty', async () => {
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('deepseek-v3') as never,
    });
    await ctx.restorePersisted();
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    // The adaptation reaches the model as a reminder, never as a prompt section.
    expect(profile.getSystemPrompt()).not.toContain('# Model Adaptation');
    expect(profile.getSystemPrompt()).toContain('helpful software engineer assistant');
  });
});
