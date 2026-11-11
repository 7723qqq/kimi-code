import { afterAll, describe, expect, it } from 'bun:test';

import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import { IFlagService } from '#/app/flag/flag';
import { ASSOCIATIVE_MEMORY_FLAG_ID } from '#/features/associativeMemory/flag';
import { GIT_MEMORY_FLAG_ID } from '#/features/gitMemory/flag';
import { LSP_FLAG_ID } from '#/features/lsp/flag';
import { NOTIFY_USER_FLAG_ID } from '#/features/notify/flag';
import { ISessionNotify } from '#/features/notify/sessionNotify';
import { TOWER_FLAG_ID } from '#/features/tower/tower';

import { createTestAgent, appService, sessionService, type TestAgentContext } from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

const contexts: TestAgentContext[] = [];

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.dispose();
});

function inventoryContext(associativeMemory: boolean): TestAgentContext {
  const ctx = createTestAgent(
    appService(
      IFlagService,
      stubFlag((id) => {
        if (id === ASSOCIATIVE_MEMORY_FLAG_ID) return associativeMemory;
        return [GIT_MEMORY_FLAG_ID, LSP_FLAG_ID, NOTIFY_USER_FLAG_ID, TOWER_FLAG_ID, WAIT_FOR_FLAG_ID].includes(
          id,
        );
      }),
    ),
    sessionService(ISessionNotify, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      enabled: true,
    }),
  );
  contexts.push(ctx);
  return ctx;
}

function readOnlyTools(ctx: TestAgentContext): readonly string[] {
  const registry = ctx.get(IAgentToolRegistryService);
  return registry
    .listReferences()
    .map((reference) => reference.name)
    .filter((name) => registry.resolve(name)?.repoMutation === 'none')
    .toSorted();
}

describe('repoMutation declarations', () => {
  it('matches the reviewed set of tools that never mutate the repository', async () => {
    const readOnly = [
      ...new Set([
        ...readOnlyTools(inventoryContext(false)),
        ...readOnlyTools(inventoryContext(true)),
      ]),
    ].toSorted();

    expect(readOnly).toEqual(
      [
        'Agent',
        'AgentSwarm',
        'AskUserQuestion',
        'CreateGoal',
        'CronCreate',
        'CronDelete',
        'CronList',
        'ExitPlanMode',
        'ExitSpecMode',
        'FetchURL',
        'GetGoal',
        'Glob',
        'Grep',
        'Knowledge',
        'lsp',
        'Memory',
        'MemoryGraph',
        'NotifyUser',
        'Read',
        'RepoMap',
        'select_tools',
        'session_query',
        'SetGoalBudget',
        'Skill',
        'SnapshotList',
        'TaskList',
        'TaskOutput',
        'TaskStop',
        'TodoList',
        'TowerStatus',
        'UpdateGoal',
        'WaitFor',
        'WebSearch',
      ].toSorted(),
    );
  });

  it('keeps repository writers and unknown tools fail-closed', async () => {
    const ctx = inventoryContext(false);
    const registry = ctx.get(IAgentToolRegistryService);
    const writers = ['Edit', 'Write', 'Bash', 'PowerShell', 'Workflow', 'run_code'];
    for (const name of writers) {
      expect(registry.resolve(name)?.repoMutation ?? 'possible').toBe('possible');
    }
  });
});
