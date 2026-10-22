import { describe, expect, it, mock, type Mock } from 'bun:test';

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import type { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import {
  SubAgentEventHandler,
  type SubagentLifecycleEvent,
} from '#/tui/controllers/subagent-event-handler';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';

function makeSwarmHandler(clock: FakeClock = createFakeClock()) {
  const requestRender = mock();
  const transcriptContainer = { addChild: mock() };
  const dockChild = { render: mock(() => ['dock line']) };
  const host = {
    state: {
      appState: { availableModels: {} },
      ui: {
        requestRender,
        terminal: { rows: 40, columns: 120 },
        children: [transcriptContainer, dockChild],
      },
      transcriptContainer,
      dockContainer: undefined,
    },
    streamingUI: {
      getToolComponent: mock(() => undefined),
      getActiveToolCall: mock(() => undefined),
      onToolCallStart: mock(),
      getTurnContext: mock(() => ({ turnId: 1, step: 0 })),
      removeToolComponentIfInactive: mock(),
      finalizeLiveTextBuffers: mock(),
    },
    appendTranscriptEntry: mock(),
    btwPanelController: { routeEvent: mock(() => false) },
    updateActivityPane: mock(),
  };
  const handler = new SubAgentEventHandler(host as never, {
    backgroundTasks: new Map(),
    backgroundTaskTranscriptedTerminal: new Set(),
    backgroundTaskTerminalEntries: new Map(),
    syncBackgroundAgentBadge: mock(),
    now: () => clock.now(),
    clock,
  });
  return { handler, host, requestRender, transcriptContainer, dockChild, clock };
}

function swarmComponentOf(host: { appendTranscriptEntry: Mock<(...args: any[]) => any> }) {
  return host.appendTranscriptEntry.mock.calls[0]?.[1] as AgentSwarmProgressComponent;
}

function lifecycleEvent(
  type: 'subagent.spawned' | 'subagent.started' | 'subagent.completed' | 'subagent.cancelled',
  subagentId: string,
  parentToolCallId: string,
): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type,
    subagentId,
    subagentName: 'explore',
    parentToolCallId,
    description: `task ${subagentId}`,
    runInBackground: false,
    resultSummary: type === 'subagent.completed' ? 'done' : undefined,
  } as unknown as SubagentLifecycleEvent;
}

function childEvent(type: 'assistant.delta' | 'tool.call.started', subagentId: string): Event {
  return {
    sessionId: 's1',
    agentId: subagentId,
    type,
    delta: type === 'assistant.delta' ? 'hello' : undefined,
    toolCallId: type === 'tool.call.started' ? 'tool-1' : undefined,
    name: type === 'tool.call.started' ? 'Read' : undefined,
    args: {},
  } as unknown as Event;
}

function startSwarmWithChild(handler: SubAgentEventHandler): void {
  handler.handleAgentSwarmToolCallStarted('tc-1', {
    description: 'Review changed files',
    items: ['src/a.ts'],
  });
  handler.handleLifecycleEvent(lifecycleEvent('subagent.spawned', 'child-1', 'tc-1'));
  handler.handleLifecycleEvent(lifecycleEvent('subagent.started', 'child-1', 'tc-1'));
}

describe('SubAgentEventHandler — swarm render batching', () => {
  it('does not request a render for each child delta routed to a swarm', () => {
    const { handler, requestRender } = makeSwarmHandler();
    startSwarmWithChild(handler);
    requestRender.mockClear();

    handler.routeChildAgentEvent(childEvent('assistant.delta', 'child-1'));
    handler.routeChildAgentEvent(childEvent('assistant.delta', 'child-1'));
    handler.routeChildAgentEvent(childEvent('tool.call.started', 'child-1'));

    expect(requestRender).not.toHaveBeenCalled();
  });

  it('still requests a render for swarm lifecycle transitions', () => {
    const { handler, requestRender } = makeSwarmHandler();
    handler.handleAgentSwarmToolCallStarted('tc-1', {
      description: 'Review changed files',
      items: ['src/a.ts'],
    });
    handler.handleLifecycleEvent(lifecycleEvent('subagent.spawned', 'child-1', 'tc-1'));
    requestRender.mockClear();

    handler.handleLifecycleEvent(lifecycleEvent('subagent.started', 'child-1', 'tc-1'));
    handler.handleLifecycleEvent(lifecycleEvent('subagent.completed', 'child-1', 'tc-1'));

    expect(requestRender).toHaveBeenCalled();
  });

  it('drives swarm re-renders from the frame timer after deltas', () => {
    const { handler, requestRender, clock } = makeSwarmHandler();
    startSwarmWithChild(handler);
    requestRender.mockClear();

    handler.routeChildAgentEvent(childEvent('assistant.delta', 'child-1'));
    expect(requestRender).not.toHaveBeenCalled();

    clock.advance(80);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });
});

describe('SubAgentEventHandler — subagent.cancelled', () => {
  it('marks a running swarm member cancelled instead of leaving it running', () => {
    const { handler, host } = makeSwarmHandler();
    startSwarmWithChild(handler);
    const component = swarmComponentOf(host);

    handler.handleLifecycleEvent(lifecycleEvent('subagent.cancelled', 'child-1', 'tc-1'));

    const output = component.render(120).join('\n');
    expect(output).toContain('⊘');
  });

  it('keeps the batch-level cancelled label when a member cancel event follows', () => {
    const { handler, host } = makeSwarmHandler();
    startSwarmWithChild(handler);
    handler.routeChildAgentEvent(childEvent('assistant.delta', 'child-1'));

    handler.handleAgentSwarmToolResult(
      'tc-1',
      { output: 'The user manually interrupted this subagent batch.' } as never,
      true,
    );
    handler.handleLifecycleEvent(lifecycleEvent('subagent.cancelled', 'child-1', 'tc-1'));

    const component = swarmComponentOf(host);
    const output = component.render(120).join('\n');
    expect(output).toContain('⊘');
    expect(output).toContain('hello');
  });
});

describe('SubAgentEventHandler — swarm grid height measurement', () => {
  it('measures the rows after the transcript once per render pass', async () => {
    const { handler, host, dockChild } = makeSwarmHandler();
    startSwarmWithChild(handler);
    const component = swarmComponentOf(host);

    component.render(120);
    component.render(120);
    expect(dockChild.render).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    component.render(120);
    expect(dockChild.render).toHaveBeenCalledTimes(2);

    handler.clearAgentSwarmProgress();
  });
});
