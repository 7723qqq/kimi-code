import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { IReplayBuilderService } from '#/index';
import { SessionSkillRegistry, type SkillCatalog, type SkillDefinition } from '#/skill';
import { InMemoryWireRecordPersistence, testAgent } from '../harness';
import { recordingTelemetry } from '../telemetry/stubs';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { stubSkill } from './stubs';

function makeSkill(name: string, metadata: SkillDefinition['metadata'] = {}): SkillDefinition {
  return stubSkill(name, { metadata });
}

function recordContainsSkillLoaded(record: unknown, skillName: string): boolean {
  if (!isRecordWithMessages(record)) return false;
  return record.messages.some((message) => {
    return message.content?.some((part) => {
      return (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.includes(`<kimi-skill-loaded name="${skillName}"`)
      );
    });
  });
}

function isRecordWithMessages(
  record: unknown,
): record is {
  readonly type: string;
  readonly messages: readonly {
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  }[];
} {
  if (record === null || typeof record !== 'object') return false;
  const candidate = record as { readonly type?: unknown; readonly messages?: unknown };
  return candidate.type === 'context.splice' && Array.isArray(candidate.messages);
}

describe('ToolManager SkillTool registration', () => {
  it('does not expose Skill when the agent has no skill registry', () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Skill'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'Skill')).toBeUndefined();
    expect(ctx.tools.resolve('Skill')).toBeUndefined();
  });

  it('does not expose Skill when there are no model-invocable skills', () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('private', { disableModelInvocation: true }));

    const ctx = testAgent({ skills });
    ctx.configure({ tools: ['Skill'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'Skill')).toBeUndefined();
    expect(ctx.tools.resolve('Skill')).toBeUndefined();
  });

  it('exposes Skill when at least one inline skill is model-invocable', () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('review'));
    skills.register(makeSkill('flow-only', { type: 'flow' }));

    const ctx = testAgent({ skills });
    ctx.configure({ tools: ['Skill'] });

    const skillInfo = ctx.toolsData().find((tool) => tool.name === 'Skill');
    const skillTool = ctx.tools.resolve('Skill');

    expect(skillInfo).toMatchObject({ name: 'Skill', active: true, source: 'builtin' });
    expect(skillTool).toMatchObject({
      name: 'Skill',
      description: expect.stringContaining('Invoke a registered skill'),
    });
  });

  it('accepts a structural skill registry implementation', () => {
    const skill = makeSkill('review');
    const skills: SkillCatalog = {
      getSkill: (name) => (name === skill.name ? skill : undefined),
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => skill.content,
      listInvocableSkills: () => [skill],
      getSkillRoots: () => ['/skills/review'],
      getModelSkillListing: () => '- review: desc for review',
    };

    const ctx = testAgent({ skills });
    ctx.configure({ tools: ['Skill'] });

    expect(skills.getSkillRoots()).toEqual(['/skills/review']);
    expect(ctx.tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
  });

  it('persists model-invoked inline skill reminders through agent wire', async () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('review'));
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = testAgent({ skills, persistence });
    ctx.configure({ tools: ['Skill'] });

    const skillCall: ToolCall = {
      type: 'function',
      id: 'call_skill',
      name: 'Skill',
      arguments: '{"skill":"review"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will load the review skill.' }, skillCall);
    ctx.mockNextResponse({ type: 'text', text: 'Review skill loaded.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Review this change' }] });
    await ctx.untilTurnEnd();

    const skillSplice = persistence.records.find(
      (record) => recordContainsSkillLoaded(record, 'review'),
    );
    expect(skillSplice).toMatchObject({
      type: 'context.splice',
      messages: [
        expect.objectContaining({
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'Skill tool loaded instructions for this request. Follow them.',
                '',
                '<kimi-skill-loaded name="review" trigger="model-tool" source="user" dir="/skills/review" args="">',
                'body of review',
                '</kimi-skill-loaded>',
              ].join('\n'),
            },
          ],
          origin: expect.objectContaining({
            kind: 'skill_activation',
            skillName: 'review',
            trigger: 'model-tool',
          }),
        }),
      ],
    });
    expect(persistence.records.find((record) => record.type === 'skill.activate')).toMatchObject({
      type: 'skill.activate',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
        trigger: 'model-tool',
      },
    });
    expect(ctx.context.getHistory().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Review skill loaded.' }],
    });
    expect(ctx.context.getHistory().at(-2)).toMatchObject({
      role: 'user',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
      },
    });
  });

  it('restores skill activation records before the skill service is otherwise used', async () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('review'));
    const telemetry = recordingTelemetry([]);
    const track = vi.spyOn(telemetry, 'track');
    const ctx = testAgent({
      skills,
      telemetry,
    });
    const emit = vi.spyOn(ctx.events, 'emit');
    const origin = {
      kind: 'skill_activation' as const,
      activationId: 'act_restore_skill',
      skillName: 'review',
      skillArgs: 'src/app.ts',
      trigger: 'user-slash' as const,
      skillPath: '/skills/review/SKILL.md',
      skillSource: 'user' as const,
    };
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'restored skill body' }],
      toolCalls: [],
      origin,
    };

    await ctx.runtime.restore([
      { type: 'skill.activate', origin },
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [message],
      },
    ]);

    expect(emit).toHaveBeenCalledWith({
      type: 'skill.activated',
      activationId: 'act_restore_skill',
      skillName: 'review',
      trigger: 'user-slash',
      skillArgs: 'src/app.ts',
      skillPath: '/skills/review/SKILL.md',
      skillSource: 'user',
    });
    expect(ctx.allEvents).not.toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'skill.activated' }),
    );
    expect(track).not.toHaveBeenCalledWith('skill_invoked', expect.anything());
    expect(ctx.context.getHistory()).toMatchObject([message]);
    expect(ctx.get(IReplayBuilderService).buildResult()).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          origin: expect.objectContaining({
            kind: 'skill_activation',
            activationId: 'act_restore_skill',
            skillName: 'review',
            trigger: 'user-slash',
          }),
        }),
      }),
    );
  });

  it('exposes session skills after the main agent is created', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-core-skill-tool-refresh-'));
    try {
      const homeDir = join(tmp, 'home');
      const workDir = join(tmp, 'work');
      const skillDir = join(workDir, '.kimi-code', 'skills', 'review');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: review', 'description: Review code', '---', '', 'Review body.'].join('\n'),
      );

      const skills = new SessionSkillRegistry();
      const skill = {
        ...makeSkill('review'),
        description: 'Review code',
        path: join(skillDir, 'SKILL.md'),
        dir: skillDir,
        content: 'Review body.',
      };
      skills.register(skill);

      const ctx = testAgent({
        kaos: createFakeKaos().withCwd(workDir),
        skills,
      });
      ctx.configure({ tools: ['Skill'] });

      expect(ctx.tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });
});
