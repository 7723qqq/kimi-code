import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { IFlagService } from '#/app/flag/flag';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import {
  _setTowerFeatureAssembledForTests,
  TOWER_TOOL_CONTRIBUTIONS,
} from '#/features/tower/towerFeature';
import { TOWER_MODE_TOOLS } from '#/features/tower/towerService';
import '#/agent/tools/select-tools/selectToolsTool';

import { appService, createTestAgent, sessionService, type TestAgentContext } from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

_setTowerFeatureAssembledForTests(true);

const DYNAMIC_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  dynamically_loaded_tools: true,
  max_context_tokens: 128_000,
} as const;
const STATIC_CAPABILITIES = { ...DYNAMIC_CAPABILITIES, dynamically_loaded_tools: false } as const;

const SORTED_TOWER_MODE_TOOLS: readonly string[] = [...TOWER_MODE_TOOLS].toSorted();

interface LlmCall {
  readonly tools: readonly { readonly name: string }[];
  readonly history: readonly ContextMessage[];
}

interface DeferredToolsAgent {
  readonly ctx: TestAgentContext;
  readonly cwd: string;
}

function towerNamesIn(tools: readonly { readonly name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => TOWER_MODE_TOOLS.includes(name))
    .toSorted();
}

function toolNames(call: LlmCall): string[] {
  return call.tools.map((tool) => tool.name);
}

function historyText(call: LlmCall): string {
  return call.history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function announcementNames(call: LlmCall, kind: 'added' | 'removed'): string[] {
  const block = new RegExp(`<tools_${kind}>\\n([\\s\\S]*?)\\n</tools_${kind}>`).exec(
    historyText(call),
  )?.[1];
  return block === undefined ? [] : block.split('\n').toSorted();
}

function schemaToolNames(call: LlmCall): string[] {
  return call.history.flatMap((message) => (message.tools ?? []).map((tool) => tool.name));
}

function toolResultText(call: LlmCall, callId: string): string {
  const message = call.history.find(
    (entry) => entry.toolCallId === callId && entry.content.some((part) => part.type === 'text'),
  );
  expect(message, `tool result for ${callId}`).toBeDefined();
  return message!.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

function selectToolsCall(id: string, names: readonly string[]) {
  return {
    type: 'function' as const,
    id,
    name: 'select_tools',
    arguments: JSON.stringify({ names }),
  };
}

function functionCall(id: string, name: string) {
  return { type: 'function' as const, id, name, arguments: '{}' };
}

async function withTowerAgent(
  options: {
    readonly capabilities: typeof DYNAMIC_CAPABILITIES | typeof STATIC_CAPABILITIES;
    readonly enterBeforeLoopStart?: boolean;
  },
  body: (agent: DeferredToolsAgent) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'tower-deferred-e2e-'));
  let ctx: TestAgentContext | undefined;
  try {
    ctx = createTestAgent(
      { cwd },
      sessionService(ISessionMcpHandle, {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        connectionManager: new McpConnectionManager(),
        isBaselineServer: () => true,
      }),
      appService(
        IFlagService,
        stubFlag((id) => id === TOWER_FLAG_ID),
      ),
    );
    ctx.configure({ modelCapabilities: options.capabilities });
    if (options.enterBeforeLoopStart === true) await ctx.get(IAgentTowerService).enter();
    await ctx.restorePersisted();
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await body({ ctx, cwd });
  } finally {
    try {
      await ctx?.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

describe('tower deferred tools end-to-end', () => {
  it('session-start enter: a dynamically-loaded-tools model gets the tower tools as deferred loadables', async () => {
    await withTowerAgent(
      { capabilities: DYNAMIC_CAPABILITIES, enterBeforeLoopStart: true },
      async ({ ctx }) => {
        ctx.mockNextResponse(selectToolsCall('call_select_1', ['TowerStatus']));
        ctx.mockNextResponse(functionCall('call_status_1', 'TowerStatus'));
        ctx.mockNextResponse({ type: 'text', text: 'done' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'check the tower' }] });
        await ctx.untilTurnEnd();

        const initial = ctx.get(IAgentStateService).get(toolSelectKey).initial ?? [];
        expect(
          initial
            .filter((tool) => TOWER_MODE_TOOLS.includes(tool.name))
            .map((tool) => tool.name)
            .toSorted(),
        ).toEqual([...SORTED_TOWER_MODE_TOOLS]);
        expect(
          initial
            .filter((tool) => TOWER_MODE_TOOLS.includes(tool.name))
            .every((tool) => tool.disclosure === 'deferred'),
        ).toBe(true);

        const calls = ctx.llmCalls as unknown as LlmCall[];
        expect(calls).toHaveLength(3);
        const [first, second, third] = calls;
        expect(toolNames(first!)).toContain('select_tools');
        expect(towerNamesIn(first!.tools)).toEqual([]);
        const announced = announcementNames(first!, 'added');
        for (const name of TOWER_MODE_TOOLS) expect(announced).toContain(name);

        expect(schemaToolNames(second!)).toContain('TowerStatus');
        expect(toolResultText(third!, 'call_status_1')).toContain('tower is not initialized');
      },
    );
  });

  it('session-start enter: a model without dynamic loading gets the tower tools inline and callable', async () => {
    await withTowerAgent(
      { capabilities: STATIC_CAPABILITIES, enterBeforeLoopStart: true },
      async ({ ctx }) => {
        ctx.mockNextResponse(functionCall('call_status_1', 'TowerStatus'));
        ctx.mockNextResponse({ type: 'text', text: 'done' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'check the tower' }] });
        await ctx.untilTurnEnd();

        const calls = ctx.llmCalls as unknown as LlmCall[];
        expect(calls).toHaveLength(2);
        const [first, second] = calls;
        expect(towerNamesIn(first!.tools)).toEqual([...SORTED_TOWER_MODE_TOOLS]);
        expect(toolNames(first!)).not.toContain('select_tools');
        expect(toolResultText(second!, 'call_status_1')).toContain('tower is not initialized');
      },
    );
  });

  it('mid-session toggle: a dynamically-loaded-tools model gets delta announcements, loadable and stale-gated tools', async () => {
    await withTowerAgent({ capabilities: DYNAMIC_CAPABILITIES }, async ({ ctx }) => {
      const tower = ctx.get(IAgentTowerService);

      ctx.mockNextResponse({ type: 'text', text: 'plain turn' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await ctx.untilTurnEnd();
      const before = (ctx.llmCalls as unknown as LlmCall[])[0]!;
      expect(towerNamesIn(before.tools)).toEqual([]);

      await tower.enter();

      ctx.mockNextResponse(selectToolsCall('call_select_1', ['TowerStatus']));
      ctx.mockNextResponse(functionCall('call_status_1', 'TowerStatus'));
      ctx.mockNextResponse({ type: 'text', text: 'status reported' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start tower work' }] });
      await ctx.untilTurnEnd();

      const [addedWire, loadedWire, calledWire] = (
        ctx.llmCalls as unknown as LlmCall[]
      ).slice(1);
      expect(toolNames(addedWire!)).toEqual(toolNames(before));
      expect(announcementNames(addedWire!, 'added')).toEqual([...SORTED_TOWER_MODE_TOOLS]);

      expect(schemaToolNames(loadedWire!)).toContain('TowerStatus');
      expect(toolResultText(calledWire!, 'call_status_1')).toContain('tower is not initialized');

      await tower.exit();
      expect(ctx.get(IAgentToolRegistryService).resolve('TowerStatus')).toBeUndefined();

      await tower.enter();
      expect(towerNamesIn(ctx.get(IAgentToolRegistryService).list())).toEqual([
        ...SORTED_TOWER_MODE_TOOLS,
      ]);
    });
  });

  it('mid-session toggle: a model without dynamic loading keeps request tools unchanged and sees the runtime-change reminder', async () => {
    await withTowerAgent({ capabilities: STATIC_CAPABILITIES }, async ({ ctx }) => {
      const tower = ctx.get(IAgentTowerService);

      ctx.mockNextResponse({ type: 'text', text: 'plain turn' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await ctx.untilTurnEnd();
      const before = (ctx.llmCalls as unknown as LlmCall[])[0]!;
      expect(towerNamesIn(before.tools)).toEqual([]);

      await tower.enter();
      ctx.mockNextResponse({ type: 'text', text: 'noted' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start tower work' }] });
      await ctx.untilTurnEnd();

      const addedWire = (ctx.llmCalls as unknown as LlmCall[])[1]!;
      expect(toolNames(addedWire)).toEqual(toolNames(before));
      expect(towerNamesIn(addedWire.tools)).toEqual([]);
      const addedText = historyText(addedWire);
      expect(addedText).toContain('<tools_added>');
      expect(addedText).toContain(
        'The current model cannot load runtime tool additions with select_tools.',
      );

      await tower.exit();
      expect(ctx.get(IAgentToolRegistryService).resolve('TowerStatus')).toBeUndefined();
      ctx.mockNextResponse({ type: 'text', text: 'back to normal' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'stop tower work' }] });
      await ctx.untilTurnEnd();

      const calls = ctx.llmCalls as unknown as LlmCall[];
      expect(calls).toHaveLength(3);
      const removedWire = calls[2]!;
      expect(toolNames(removedWire)).toEqual(toolNames(before));
      const removedText = historyText(removedWire);
      expect(removedText).toContain('<tools_removed>');
      expect(removedText).toContain(
        'The current model cannot load runtime tool additions with select_tools.',
      );

      for (const call of calls) {
        expect(towerNamesIn(call.tools)).toEqual([]);
        expect(toolNames(call)).not.toContain('select_tools');
      }
    });
  });

  it('registers every tower mode tool through the shared contribution list', () => {
    expect(TOWER_TOOL_CONTRIBUTIONS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...TOWER_MODE_TOOLS]),
    );
  });
});
