import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { setLocale } from '@moonshot-ai/kimi-i18n';

import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentSwarmService } from '#/agent/swarm/swarm';
import type {
  IPersistentSubagentService,
  PersistentSubagentHost,
  PersistentSubagentSpawnOptions,
} from '#/session/subagent/persistentSubagent';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import type { ExecutableToolContext } from '#/tool/toolContract';
import {
  IAgentSwarmDiscussionTool,
  SwarmDiscussionToolInputSchema,
} from '#/agent/tools/swarm-discussion/swarm-discussion';
import { SwarmDiscussionTool } from '#/agent/tools/swarm-discussion/swarmDiscussionTool';

import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

type TestContext<Input> = ExecutableToolContext & { readonly args: Input };

interface ToolStubs {
  readonly service: IPersistentSubagentService;
  readonly bind: Mock;
  readonly swarmMode: IAgentSwarmService;
  readonly enter: Mock;
  readonly spawned: PersistentSubagentSpawnOptions[];
  readonly turns: Array<{ readonly agentId: string; readonly prompt: string }>;
  readonly destroyed: string[];
}

function createToolStubs(replies: readonly string[] = []): ToolStubs {
  const spawned: PersistentSubagentSpawnOptions[] = [];
  const turns: Array<{ readonly agentId: string; readonly prompt: string }> = [];
  const destroyed: string[] = [];
  let nextId = 0;
  let turnIndex = 0;

  const host: PersistentSubagentHost = {
    spawnPersistent: async (options) => {
      spawned.push(options);
      return `agent-${String(nextId++)}`;
    },
    runDiscussionTurn: async (agentId, prompt) => {
      const index = turnIndex++;
      turns.push({ agentId, prompt });
      return replies[index] ?? `Speech ${String(index)} from ${agentId}`;
    },
    getPersistentUsage: () => undefined,
    destroyPersistent: async (agentId) => {
      destroyed.push(agentId);
    },
  };
  const bind = vi.fn(() => host);
  const enter = vi.fn();
  const exit = vi.fn();

  return {
    service: { _serviceBrand: undefined, bind },
    bind,
    swarmMode: { _serviceBrand: undefined, isActive: false, enter, exit },
    enter,
    spawned,
    turns,
    destroyed,
  };
}

function createTool(stubs: ToolStubs): SwarmDiscussionTool {
  return new SwarmDiscussionTool(
    stubs.service,
    stubs.swarmMode,
    makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
  );
}

function context<Input>(
  args: Input,
  toolCallId = 'call_discussion',
): TestContext<Input> {
  return { turnId: 0, toolCallId, args, signal };
}

const DISCUSSION_ARGS = {
  mode: 'discussion' as const,
  topic: 'How should we optimize the database?',
  participants: [
    {
      profileName: 'coder',
      roleDescription: 'You are a database researcher.',
    },
    {
      profileName: 'explore',
      roleDescription: 'You are a systems architect.',
    },
  ],
  enableVoting: false,
  maxRounds: 3,
};

const DEBATE_ARGS = {
  mode: 'debate' as const,
  topic: 'Should we migrate to GraphQL?',
  participants: [
    {
      profileName: 'coder',
      roleDescription: 'You are a backend engineer.',
      assignedStance: 'Argue against GraphQL',
    },
    {
      profileName: 'explore',
      roleDescription: 'You are a frontend architect.',
      assignedStance: 'Argue for GraphQL',
    },
  ],
  maxRounds: 1,
  summaryPrompt: 'List points of consensus.',
  enableVoting: true,
};

describe('SwarmDiscussionTool', () => {
  beforeEach(() => {
    setLocale('en');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the SwarmDiscussion name and validates its input schema', () => {
    const stubs = createToolStubs();
    const tool = createTool(stubs);

    expect(tool.name).toBe('SwarmDiscussion');
    expect(tool.description).toContain('Run a roundtable discussion OR a structured debate');
    expect(SwarmDiscussionToolInputSchema.safeParse(DISCUSSION_ARGS).success).toBe(true);
    expect(
      SwarmDiscussionToolInputSchema.safeParse({ ...DISCUSSION_ARGS, participants: [] }).success,
    ).toBe(false);
    expect(
      SwarmDiscussionToolInputSchema.safeParse({ ...DISCUSSION_ARGS, mode: 'nope' }).success,
    ).toBe(false);
    expect(
      SwarmDiscussionToolInputSchema.safeParse({ ...DISCUSSION_ARGS, maxRounds: -1 }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        mode: { type: 'string' },
        topic: { type: 'string' },
        participants: { type: 'array' },
      },
    });
  });

  it('resolves execution with agent_call display and SwarmDiscussion approval rule', () => {
    const stubs = createToolStubs();
    const tool = createTool(stubs);
    const execution = tool.resolveExecution(DISCUSSION_ARGS);

    expect(execution).toMatchObject({
      accesses: [{ kind: 'all' }],
      description: 'Roundtable discussion: How should we optimize the database?',
      display: {
        kind: 'agent_call',
        agent_name: 'discussion (2 participants)',
        prompt: DISCUSSION_ARGS.topic,
      },
      approvalRule: 'SwarmDiscussion',
    });
    expect(typeof (execution as { execute?: unknown }).execute).toBe('function');
  });

  it('runs a discussion through the persistent subagent host and renders XML', async () => {
    const stubs = createToolStubs();
    const tool = createTool(stubs);

    const result = await executeTool(tool, context({ ...DISCUSSION_ARGS, maxRounds: 1 }));

    expect(stubs.bind).toHaveBeenCalledWith('main');
    expect(stubs.enter).toHaveBeenCalledWith('tool');
    expect(stubs.spawned.map((s) => s.profileName)).toEqual(['coder', 'explore']);
    expect(stubs.spawned[0]).toMatchObject({
      prompt: '',
      description: 'You are a database researcher.',
      parentToolCallId: 'discussion',
      runInBackground: false,
    });
    expect(stubs.turns).toHaveLength(2);
    expect(stubs.destroyed).toEqual(['agent-0', 'agent-1']);

    expect(result.isError).toBeUndefined();
    const output = result.output as string;
    expect(output).toContain('<discussion_result>');
    expect(output).toContain('<summary>rounds: 1, speeches: 2, status: completed</summary>');
    expect(output).toContain('[coder] Speech 0 from agent-0');
    expect(output).toContain('[explore] Speech 1 from agent-1');
    expect(output).toContain('</discussion_result>');
  });

  it('renders the summary when summaryPrompt is provided', async () => {
    const stubs = createToolStubs(['summary text']);
    const tool = createTool(stubs);

    const result = await executeTool(
      tool,
      context({
        ...DISCUSSION_ARGS,
        maxRounds: 1,
        summaryPrompt: 'Summarize the key decisions.',
      }),
    );

    expect(stubs.turns).toHaveLength(3);
    const output = result.output as string;
    expect(output).toContain('<final_summary>');
    expect(output).toContain('summary text');
    expect(output).toContain('</final_summary>');
  });

  it('runs a structured debate with voting and renders phase breakdown', async () => {
    const stubs = createToolStubs();
    const tool = createTool(stubs);

    const result = await executeTool(tool, context(DEBATE_ARGS));

    expect(stubs.spawned[0]).toMatchObject({ parentToolCallId: 'debate' });
    expect(stubs.spawned[1]).toMatchObject({
      profileName: 'explore',
      description: 'You are a frontend architect.',
    });
    // opening 2 + free debate 2 + closing 2 + consensus 1 + votes 2 + tally 1
    expect(stubs.turns).toHaveLength(10);

    expect(result.isError).toBeUndefined();
    const output = result.output as string;
    expect(output).toContain('<debate_result>');
    expect(output).toContain('<summary>speeches: 6, phases: 3, cross_refs: 0, position_changes: 2, status: completed</summary>');
    expect(output).toContain('<phase name="opening" speeches="2" />');
    expect(output).toContain('<phase name="free_debate" speeches="2" />');
    expect(output).toContain('<phase name="closing" speeches="2" />');
    expect(output).toContain('[coder] Speech 0 from agent-0');
    expect(output).toContain('<consensus>');
    expect(output).toContain('<voting_result>');
    expect(output).toContain('</debate_result>');
  });

  it('returns an error result when binding the host fails', async () => {
    const stubs = createToolStubs();
    stubs.bind.mockImplementation(() => {
      throw new Error('bind failed');
    });
    const tool = createTool(stubs);

    const result = await executeTool(tool, context(DISCUSSION_ARGS));

    expect(result.isError).toBe(true);
    expect(result.output).toBe('bind failed');
  });

  it('returns an error result when execution throws outside the coordinators', async () => {
    const stubs = createToolStubs();
    stubs.enter.mockImplementation(() => {
      throw new Error('swarm mode unavailable');
    });
    const tool = createTool(stubs);

    const result = await executeTool(tool, context(DISCUSSION_ARGS));

    expect(result.isError).toBe(true);
    expect(result.output).toBe('swarm mode unavailable');
    expect(stubs.bind).not.toHaveBeenCalled();
  });

  it('is registered as an agent tool service named SwarmDiscussion', () => {
    expect(IAgentSwarmDiscussionTool).toBeDefined();
    expect(typeof IAgentSwarmDiscussionTool).toBe('function');
    expect(
      getAgentToolContributions().some((contribution) => contribution.options.name === 'SwarmDiscussion'),
    ).toBe(true);
  });
});
