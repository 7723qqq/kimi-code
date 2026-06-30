import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/contextMemory';
import { IAgentEventSinkService } from '#/eventSink';
import { IAgentPromptService } from '#/prompt';
import { IAgentSkillService, InMemorySkillCatalog, ISessionSkillCatalog } from '#/skill';
import { AgentSkillService } from '#/skill/skillService';
import { ITelemetryService } from '#/telemetry';
import { IAgentToolRegistryService } from '#/toolRegistry';
import type { Turn } from '#/turn';
import { IAgentWireRecordService } from '#/wireRecord';
import { stubWireRecord } from '../contextMemory/stubs';
import { stubSkill } from './stubs';

const COMMIT_SKILL = stubSkill('commit', {
  description: 'commit changes',
  path: '/skills/commit/SKILL.md',
  dir: '/skills/commit',
  content: '# Commit',
  metadata: {},
  source: 'user',
});

function fakeTurn(): Turn {
  return {
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

describe('AgentSkillService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let prompted: ContextMessage[];

  beforeEach(() => {
    disposables = new DisposableStore();
    prompted = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentPromptService, {
          prompt: (message) => {
            prompted.push(message);
            return fakeTurn();
          },
          steer: () => undefined,
          retry: () => undefined,
          undo: () => 0,
          clear: () => {},
        });
        reg.definePartialInstance(IAgentEventSinkService, {
          emit: () => {},
          on: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(IAgentWireRecordService, stubWireRecord());
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
      },
    });
    const skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
      load: async () => {},
      reload: async () => {},
    };
    ix.set(ISessionSkillCatalog, skillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));
  });
  afterEach(() => disposables.dispose());

  it('activate prompts with the rendered skill for a known skill', async () => {
    const svc = ix.get(IAgentSkillService);
    const turn = await svc.activate({ name: 'commit' });

    expect(turn).toBeDefined();
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.role).toBe('user');
    expect(prompted[0]!.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });

  it('activate throws for an unknown skill', async () => {
    const svc = ix.get(IAgentSkillService);
    await expect(svc.activate({ name: 'missing' })).rejects.toThrow(/not found/i);
  });

  it('activate waits for the catalog to be ready before resolving', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    ix.set(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: skills,
      ready,
      load: async () => {},
      reload: async () => {},
    } satisfies ISessionSkillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));

    const svc = ix.get(IAgentSkillService);
    let finished = false;
    const activation = svc.activate({ name: 'commit' }).then(() => {
      finished = true;
    });

    await Promise.resolve();
    expect(finished).toBe(false);

    resolveReady();
    await activation;

    expect(finished).toBe(true);
    expect(prompted).toHaveLength(1);
  });
});
