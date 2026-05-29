import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import { SessionEventHandler, type SessionEventHost } from '#/tui/controllers/session-event-handler';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { workerActivityFromTool } from '#/tui/components/messages/swarm-dashboard-model';
import { darkColors } from '#/tui/theme/colors';

const strip = (t: string): string => t.replaceAll(/\[[0-9;]*m/g, '');

function makeSwarm(): ToolCallComponent {
  return new ToolCallComponent(
    { id: 'tc-swarm', name: 'Swarm', args: { task: 'task' } },
    undefined,
    darkColors,
  );
}

describe('swarm dashboard wiring (translation)', () => {
  it('produces the expected dashboard from a worker lifecycle sequence', () => {
    const dash = makeSwarm();
    dash.applySwarm({ t: 'planned', total: 2 });
    dash.applySwarm({ t: 'worker.spawned', id: 's1', role: 'Researcher' });
    dash.applySwarm({ t: 'worker.toolcall', id: 's1', activity: workerActivityFromTool('Read', { path: 'a.ts' }) });
    dash.applySwarm({ t: 'worker.done', id: 's1', tokens: 2100 });
    dash.applySwarm({ t: 'worker.spawned', id: 's2', role: 'Analyst' });
    dash.applySwarm({ t: 'worker.failed', id: 's2', error: 'timeout' });
    dash.applySwarm({ t: 'done', succeeded: 1, failed: 1 });
    const out = strip(dash.render(80).join('\n'));
    expect(out).toContain('Researcher');
    expect(out).toContain('Analyst');
    expect(out).toContain('timeout');
    expect(out).toMatch(/2 workers/);
  });

  it('routes live swarm events through SessionEventHandler into the dashboard', () => {
    const parentToolCallId = 'tc-swarm';
    const dash = makeSwarm();
    const mockHost = {
      streamingUI: {
        setTurnId: (): void => {},
        getToolComponent: (id: string): ToolCallComponent | undefined =>
          id === parentToolCallId ? dash : undefined,
      },
    } as unknown as SessionEventHost;
    const handler = new SessionEventHandler(mockHost);
    const noop = (): void => {};

    handler.handleEvent(
      {
        type: 'tool.progress',
        agentId: 'main',
        sessionId: 's',
        turnId: 1,
        toolCallId: parentToolCallId,
        update: { kind: 'custom', customKind: 'swarm', customData: { phase: 'planned', total: 1 } },
      } as unknown as Event,
      noop,
    );
    handler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 's',
        subagentId: 'w1',
        subagentName: 'swarm:Researcher',
        parentToolCallId,
        description: 'Researcher',
        runInBackground: false,
      } as unknown as Event,
      noop,
    );
    handler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'w1',
        sessionId: 's',
        turnId: 1,
        toolCallId: 'inner-1',
        name: 'Read',
        args: { path: 'x.ts' },
      } as unknown as Event,
      noop,
    );
    handler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 's',
        subagentId: 'w1',
        parentToolCallId,
        error: 'boom',
      } as unknown as Event,
      noop,
    );

    const out = strip(dash.render(80).join('\n'));
    expect(out).toContain('Researcher');
    expect(out).toContain('boom');
    // Active header tail reports worker progress (1 of 1 terminal).
    expect(out).toMatch(/1\/1 workers/);
  });

  it('routes custom revising/dropped progress into retrying/dropped dashboard states', () => {
    const parentToolCallId = 'tc-swarm';
    const dash = makeSwarm();
    const mockHost = {
      streamingUI: {
        setTurnId: (): void => {},
        getToolComponent: (id: string): ToolCallComponent | undefined =>
          id === parentToolCallId ? dash : undefined,
      },
    } as unknown as SessionEventHost;
    const handler = new SessionEventHandler(mockHost);
    const noop = (): void => {};

    const progress = (customData: Record<string, unknown>): void => {
      handler.handleEvent(
        {
          type: 'tool.progress',
          agentId: 'main',
          sessionId: 's',
          turnId: 1,
          toolCallId: parentToolCallId,
          update: { kind: 'custom', customKind: 'swarm', customData },
        } as unknown as Event,
        noop,
      );
    };
    const spawn = (subagentId: string): void => {
      handler.handleEvent(
        {
          type: 'subagent.spawned',
          agentId: 'main',
          sessionId: 's',
          subagentId,
          subagentName: 'swarm:Worker',
          parentToolCallId,
          description: 'Worker',
          runInBackground: false,
        } as unknown as Event,
        noop,
      );
    };

    progress({ phase: 'planned', total: 1 });
    spawn('w1');
    handler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 's',
        subagentId: 'w1',
        parentToolCallId,
        error: 'boom',
      } as unknown as Event,
      noop,
    );
    // Coordinator decides to retry the Worker subtask.
    progress({ phase: 'revising', subtaskId: 'task-1', role: 'Worker', decision: 'retry', attempt: 1 });
    const retrying = strip(dash.render(80).join('\n'));
    expect(retrying).toContain('Worker');
    expect(retrying).toContain('retrying');

    // Re-spawn collapses onto the same row, then the subtask is ultimately dropped.
    spawn('w2');
    progress({ phase: 'dropped', subtaskId: 'task-1', role: 'Worker', reason: 'impossible' });
    const out = strip(dash.render(80).join('\n'));
    expect(out.match(/Worker/g)?.length).toBe(1);
    expect(out).toContain('dropped: impossible');
  });

  it('counts only real workers — planner/synthesizer/retry never become rows', () => {
    const parentToolCallId = 'tc-swarm';
    const dash = makeSwarm();
    const mockHost = {
      streamingUI: {
        setTurnId: (): void => {},
        getToolComponent: (id: string): ToolCallComponent | undefined =>
          id === parentToolCallId ? dash : undefined,
      },
    } as unknown as SessionEventHost;
    const handler = new SessionEventHandler(mockHost);
    const noop = (): void => {};

    const spawn = (subagentId: string, subagentName: string, description: string): void => {
      handler.handleEvent(
        {
          type: 'subagent.spawned',
          agentId: 'main',
          sessionId: 's',
          subagentId,
          subagentName,
          parentToolCallId,
          description,
          runInBackground: false,
        } as unknown as Event,
        noop,
      );
    };
    const complete = (subagentId: string): void => {
      handler.handleEvent(
        {
          type: 'subagent.completed',
          agentId: 'main',
          sessionId: 's',
          subagentId,
          parentToolCallId,
          resultSummary: 'ok',
        } as unknown as Event,
        noop,
      );
    };

    // Coordinator order: planner, two workers, synthesizer — all under the
    // same parent tool-call id. Only the two `swarm:<role>` workers are rows.
    spawn('p1', 'swarm-planner', 'Swarm planner');
    spawn('w1', 'swarm:Researcher', 'Researcher');
    spawn('w2', 'swarm:Analyst', 'Analyst');
    spawn('synth', 'swarm-synthesizer', 'Swarm synthesizer');

    complete('p1');
    complete('w1');
    complete('w2');
    complete('synth');

    // The Swarm tool's custom `done` progress finalizes the dashboard.
    handler.handleEvent(
      {
        type: 'tool.progress',
        agentId: 'main',
        sessionId: 's',
        turnId: 1,
        toolCallId: parentToolCallId,
        update: { kind: 'custom', customKind: 'swarm', customData: { phase: 'done', succeeded: 2, failed: 0 } },
      } as unknown as Event,
      noop,
    );

    const out = strip(dash.render(80).join('\n'));
    expect(out).toContain('Researcher');
    expect(out).toContain('Analyst');
    expect(out).not.toContain('planner');
    expect(out).not.toContain('synthesizer');
    expect(out).toContain('2 workers · 2✓ 0✗');
  });
});
