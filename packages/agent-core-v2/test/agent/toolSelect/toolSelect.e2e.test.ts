import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { createControlledPromise } from '@antfu/utils';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { LOADABLE_TOOLS_VARIANT } from '#/agent/toolSelect/dynamicTools';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { IAgentToolSelectSchemasService } from '#/agent/toolSelect/toolSelectSchemas';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { setEnv, restoreEnvs } from '#test/helpers/stubs';
import '#/agent/tools/select-tools/selectToolsTool';

import { createTestAgent, sessionService, type TestAgentContext } from '../../harness';

const MCP_ALPHA = 'mcp__srv__alpha';
const DASHBOARD_TOOL = 'dashboard_create';

const DISCLOSURE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
  dynamically_loaded_tools: true,
} as const;

type WireEvent = Extract<TestAgentContext['allEvents'][number], { readonly type: '[wire]' }>;

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  description: string;
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  };
  calls = 0;

  constructor(readonly name: string) {
    this.description = `${name} desc`;
  }

  resolveExecution(): ToolExecution {
    return {
      description: `stub ${this.name}`,
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: 'mcp ok' };
      },
    };
  }
}

function wireEvents(ctx: TestAgentContext, eventName: string): readonly WireEvent[] {
  return ctx.allEvents.filter(
    (event): event is WireEvent => event.type === '[wire]' && event.event === eventName,
  );
}

function selectToolsCall(id: string, names: readonly string[]) {
  return {
    type: 'function' as const,
    id,
    name: 'select_tools',
    arguments: JSON.stringify({ names }),
  };
}

function toolNames(tools: readonly { readonly name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function historyText(history: readonly ContextMessage[]): string {
  return history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

describe('progressive tool disclosure end-to-end', () => {
  let ctx: TestAgentContext;
  let alpha: StubMcpTool;
  let registration: { dispose(): void } | undefined;
  let mcpReady: Promise<void>;
  let onMcpWait: () => void;

  beforeEach(async () => {
    setEnv(TOOL_SELECT_FLAG_ENV, '1');
    mcpReady = Promise.resolve();
    onMcpWait = () => {};
    ctx = createTestAgent(
      sessionService(ISessionMcpHandle, {
        _serviceBrand: undefined,
        get ready() {
          onMcpWait();
          return mcpReady;
        },
        connectionManager: new McpConnectionManager(),
        isBaselineServer: () => true,
      }),
    );
    ctx.get(IAgentToolSelectService);
    ctx.get(IAgentToolSelectAnnouncementsService);
    ctx.get(IAgentToolSelectSchemasService);
    ctx.get(IAgentToolExecutorService);
    ctx.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
    await ctx.restorePersisted();
    await ctx.rpc.setPermission({ mode: 'yolo' });
    alpha = new StubMcpTool(MCP_ALPHA);
    registration = ctx
      .get(IAgentToolRegistryService)
      .register(alpha, { source: 'mcp', disclosure: 'deferred' });
  });

  afterEach(async () => {
    registration?.dispose();
    restoreEnvs();
    await ctx.dispose();
  });

  it('announces MCP tools discovered during startup in the first model request', async () => {
    registration?.dispose();
    const ready = createControlledPromise<void>();
    const waiting = createControlledPromise<void>();
    mcpReady = ready;
    onMcpWait = waiting.resolve;
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use the server tool' }] });
    await waiting;
    expect(ctx.llmCalls).toHaveLength(0);
    registration = ctx
      .get(IAgentToolRegistryService)
      .register(alpha, { source: 'mcp', disclosure: 'deferred' });
    ready.resolve();
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(historyText(firstWire.history)).toContain(MCP_ALPHA);
  });

  it('announces a ranked shortlist for a large deferred catalog', async () => {
    const registrations = Array.from({ length: 19 }, (_, index) =>
      ctx
        .get(IAgentToolRegistryService)
        .register(new StubMcpTool(`mcp__srv__tool_${index}`), {
          source: 'mcp',
          disclosure: 'deferred',
        }),
    );
    registrations.push(
      ctx.get(IAgentToolRegistryService).register(new StubMcpTool('mcp__db__database_query'), {
        source: 'mcp',
        disclosure: 'deferred',
      }),
    );
    try {
      ctx.mockNextResponse({ type: 'text', text: 'done' });
      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'query the analytics database' }],
      });
      await ctx.untilTurnEnd();

      const first = ctx.llmCalls[0]!;
      const announcement = historyText(first.history);
      expect(announcement).toContain('<tools_relevant>');
      expect(announcement).toContain('mcp__db__database_query');
      expect(announcement).not.toContain('mcp__srv__tool_0');
      expect(toolNames(first.tools)).not.toContain('mcp__db__database_query');
    } finally {
      for (const extra of registrations) extra.dispose();
    }
  });

  it('can cancel the first turn while MCP discovery is still pending', async () => {
    const waiting = createControlledPromise<void>();
    mcpReady = new Promise(() => {});
    onMcpWait = waiting.resolve;

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use the server tool' }] });
    await waiting;
    expect(ctx.get(IAgentLoopService).cancel()).toBe(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('announces, loads, pins updates, and restores the initial tool table', async () => {
    const inlineName = 'mcp__srv__inline';
    const inlineTool = new StubMcpTool(inlineName);
    ctx.get(IAgentToolRegistryService).register(inlineTool, {
      source: 'mcp',
      disclosure: 'inline',
    });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_alpha_1',
      name: MCP_ALPHA,
      arguments: JSON.stringify({ query: 'moon' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try the srv alpha tool' }] });
    await ctx.untilTurnEnd();
    const initialTools = ctx.get(IAgentStateService).get(toolSelectKey).initial;

    inlineTool.description = `${inlineName} updated desc`;
    ctx.mockNextResponse(selectToolsCall('call_select_inline', [inlineName]));
    ctx.mockNextResponse({ type: 'text', text: 'after pending update' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try the updated inline tool' }] });
    await ctx.untilTurnEnd();

    const runtimeTool = 'mcp__srv__runtime';
    ctx.get(IAgentToolRegistryService).register(new StubMcpTool(runtimeTool), {
      source: 'mcp',
      disclosure: 'deferred',
    });
    await ctx.restorePersisted();
    expect(ctx.get(IAgentStateService).get(toolSelectKey).initial).toEqual(initialTools);
    ctx.configure({
      provider: { type: 'kimi', model: 'no-dynamic-tools' },
      modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false },
    });
    ctx.mockNextResponse({ type: 'text', text: 'after runtime registration' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after runtime registration' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(6);

    const firstWire = ctx.llmCalls[0]!;
    expect(initialTools?.map((tool) => tool.name)).toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).toContain('select_tools');
    expect(historyText(firstWire.history)).toContain('<tools_added>');
    expect(historyText(firstWire.history)).toContain(MCP_ALPHA);

    const requests = wireEvents(ctx, 'llm.request').filter(
      (event) => (event.args as { kind?: string }).kind === 'loop',
    );
    expect(requests.map((request) => (request.args as { toolSelect?: boolean }).toolSelect)).toEqual(
      [true, true, true, true, true, false],
    );

    const secondWire = ctx.llmCalls[1]!;
    const schemaMessages = secondWire.history.filter((message) =>
      message.tools?.some((tool) => tool.name === MCP_ALPHA),
    );
    expect(schemaMessages).toHaveLength(1);
    expect(schemaMessages[0]!.tools!.find((tool) => tool.name === MCP_ALPHA)?.parameters).toEqual(
      alpha.parameters,
    );
    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(ctx.llmCalls[2]!.tools).toEqual(firstWire.tools);

    for (const wire of [ctx.llmCalls[3]!, ctx.llmCalls[4]!]) {
      expect(wire.tools).toEqual(firstWire.tools);
      expect(wire.tools.find((tool) => tool.name === inlineName)?.description).toBe(
        `${inlineName} desc`,
      );
      expect(
        wire.history.flatMap((message) => message.tools ?? []).filter(
          (tool) => tool.name === inlineName,
        ),
      ).toEqual([]);
    }
    expect(historyText(ctx.llmCalls[3]!.history)).toContain('not applied in this session');
    expect(ctx.get(IAgentToolRegistryService).resolve(inlineName)).toBe(inlineTool);
    expect(
      ctx.get(IAgentContextMemoryService).get().filter(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === 'tool_update_pending',
      ),
    ).toHaveLength(1);

    const runtimeWire = ctx.llmCalls[5]!;
    expect(ctx.get(IAgentProfileService).data().activeToolNames).toBeUndefined();
    expect(ctx.get(IAgentToolSelectService).defaultTools(false).map((tool) => tool.name)).toContain(
      MCP_ALPHA,
    );
    expect(
      ctx.get(IAgentToolSelectService).defaultTools(false).find((tool) => tool.name === MCP_ALPHA)
        ?.deferred,
    ).toBeUndefined();
    expect(toolNames(runtimeWire.tools)).toContain(MCP_ALPHA);
    expect(toolNames(runtimeWire.tools)).not.toContain(runtimeTool);
    expect(toolNames(runtimeWire.tools)).not.toContain('select_tools');
    expect(historyText(runtimeWire.history)).toContain(runtimeTool);
    expect(historyText(runtimeWire.history)).toContain(
      'The available tools changed during this session.',
    );
    expect(historyText(runtimeWire.history)).not.toContain('Use the select_tools tool');
    expect(wireEvents(ctx, 'llm.tools_snapshot')).toHaveLength(2);
    expect(
      ctx.get(IAgentContextMemoryService).get().some(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT,
      ),
    ).toBe(true);
    expect(alpha.calls).toBe(1);
  });

  it('loads and dispatches a user tool registered through the domain service', async () => {
    ctx.get(IAgentUserToolService).register({
      name: DASHBOARD_TOOL,
      description: 'Create a dashboard.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      disclosure: 'deferred',
    });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [DASHBOARD_TOOL]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_dashboard_1',
      name: DASHBOARD_TOOL,
      arguments: JSON.stringify({ title: 'Operations' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'create a dashboard' }] });
    await ctx.untilToolCall({ output: 'dashboard-created' });
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(DASHBOARD_TOOL);
    expect(historyText(firstWire.history)).toContain(DASHBOARD_TOOL);

    const secondWire = ctx.llmCalls[1]!;
    const injected = secondWire.history.find((message) =>
      message.tools?.some((tool) => tool.name === DASHBOARD_TOOL),
    );
    expect(injected?.tools?.find((tool) => tool.name === DASHBOARD_TOOL)?.parameters).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      `Loaded: ${DASHBOARD_TOOL}`,
    );
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain('dashboard-created');
  });

  it('keeps the selected schema across undo and reports it as already available on reselect', async () => {
    ctx.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'alpha is loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();

    await ctx.get(IAgentConversationUndoService).undo(1);
    const afterUndo = ctx.get(IAgentContextMemoryService).get();
    expect(
      afterUndo.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'reloaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha again' }] });
    await ctx.untilTurnEnd();

    const afterReload = ctx.get(IAgentContextMemoryService).get();
    expect(
      afterReload.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);
    expect(historyText(afterReload)).toContain('Already available: mcp__srv__alpha');
    expect(historyText(afterReload)).not.toContain('Loaded: mcp__srv__alpha');
  });

  it('reports select_tools as callable despite a profile allowlist omission, but respects an explicit deny', async () => {
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Read'] });
    ctx.mockNextResponse(selectToolsCall('call_select_self', ['select_tools']));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select the selection tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain('"select_tools" is already available — call it directly;');
    expect(text).not.toContain('disabled by the current tool policy');
    expect(text).not.toContain('Unknown tool: select_tools');
    expect(ctx.get(IAgentToolSelectService).load(['select_tools'])).toMatchObject({
      alreadyCallable: ['select_tools'],
      consecutiveFailures: 0,
    });

    ctx.get(IAgentProfileService).update({ disallowedTools: ['select_tools'] });
    expect(ctx.get(IAgentToolSelectService).load(['select_tools'])).toMatchObject({
      alreadyCallable: [],
      policyDenied: ['select_tools'],
    });
  });

  it('answers not-available-in-this-session for a host-denied name', async () => {
    ctx.get(IAgentProfileService).update({ disallowedTools: ['Automation'] });

    ctx.mockNextResponse(selectToolsCall('call_select_1', ['Automation']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select automation' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain(
      '"Automation" is disabled by the current tool policy. select_tools cannot enable it. ' +
        'Do not retry unless the policy changes; use an available tool instead.',
    );
  });

  it('loads an announced user tool with an MCP-like name despite an MCP deny glob', async () => {
    registration?.dispose();
    registration = ctx.get(IAgentToolRegistryService).register(alpha, {
      source: 'user',
      disclosure: 'deferred',
    });
    ctx.get(IAgentProfileService).update({ disallowedTools: ['mcp__srv__*'] });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load the announced tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain(`<tools_added>\n${MCP_ALPHA}\n</tools_added>`);
    expect(text).toContain(`Loaded: ${MCP_ALPHA}`);
    expect(text).not.toContain('disabled by the current tool policy');
  });

  it('reports a loaded MCP tool as currently unavailable after its server disconnects', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      `Loaded: ${MCP_ALPHA}`,
    );

    registration?.dispose();
    registration = undefined;

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select alpha again' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain(
      `"${MCP_ALPHA}" was previously selected or loaded but is no longer registered. ` +
        'select_tools cannot restore it. Do not select it again unless a new <tools_added> announcement lists it.',
    );
    expect(text).not.toContain(`Already available: ${MCP_ALPHA}`);
  });

  it('resets the call streak on success but preserves unrelated name failures in the same turn', async () => {
    ctx.mockNextResponse(selectToolsCall('guess_1', ['Automation']));
    ctx.mockNextResponse(selectToolsCall('guess_2', ['AutomationList']));
    ctx.mockNextResponse(selectToolsCall('guess_3', ['mcp__example__automation']));
    ctx.mockNextResponse(selectToolsCall('load_alpha', [MCP_ALPHA]));
    ctx.mockNextResponse(selectToolsCall('guess_4', ['Automation']));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select a tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain('Unknown tool: mcp__example__automation.');
    expect(text.match(/3 consecutive select_tools calls/g)).toHaveLength(1);
    expect(text).toContain(`Loaded: ${MCP_ALPHA}`);
    expect(text).not.toContain('4 consecutive select_tools calls');
    expect(text).toContain('"Automation" has already failed selection 2 times');
  });

  it('escalates to stop-retry wording when the same unknown name is selected twice', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', ['mcp__srv__ghost']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load ghost' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'Unknown tool: mcp__srv__ghost.',
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', ['mcp__srv__ghost']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load ghost again' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      '"mcp__srv__ghost" has already failed selection 2 times. ' +
        'Stop retrying this name until its availability changes.',
    );
  });
});
