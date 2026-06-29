import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/contextMemory';
import { IEventSink } from '#/eventSink';
import { IPromptService } from '#/prompt';
import { IAgentSkillService, SessionSkillRegistry } from '#/skill';
import { AgentSkillService } from '#/skill/skillService';
import { ITelemetryService } from '#/telemetry';
import type { Turn } from '#/turn';
import { IWireRecord } from '#/wireRecord';
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
        reg.definePartialInstance(IPromptService, {
          prompt: (message) => {
            prompted.push(message);
            return fakeTurn();
          },
          steer: () => undefined,
          retry: () => undefined,
          undo: () => 0,
          clear: () => {},
        });
        reg.definePartialInstance(IEventSink, {
          emit: () => {},
          on: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(IWireRecord, stubWireRecord());
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
      },
    });
    const skills = new SessionSkillRegistry();
    skills.register(COMMIT_SKILL);
    ix.set(
      IAgentSkillService,
      new SyncDescriptor(AgentSkillService, [{ catalog: skills }]),
    );
  });
  afterEach(() => disposables.dispose());

  it('activate prompts with the rendered skill for a known skill', () => {
    const svc = ix.get(IAgentSkillService);
    const turn = svc.activate({ name: 'commit' });

    expect(turn).toBeDefined();
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.role).toBe('user');
    expect(prompted[0]!.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });

  it('activate throws for an unknown skill', () => {
    const svc = ix.get(IAgentSkillService);
    expect(() => svc.activate({ name: 'missing' })).toThrow(/not found/i);
  });
});
