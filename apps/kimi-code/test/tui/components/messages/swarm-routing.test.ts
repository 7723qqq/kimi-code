import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import { SessionEventHandler, type SessionEventHost } from '#/tui/controllers/session-event-handler';
import { SwarmDashboardComponent } from '#/tui/components/messages/swarm-dashboard';
import { workerActivityFromTool } from '#/tui/components/messages/swarm-dashboard-model';
import { darkColors } from '#/tui/theme/colors';

const strip = (t: string): string => t.replaceAll(/\[[0-9;]*m/g, '');

describe('swarm dashboard wiring (translation)', () => {
  it('produces the expected dashboard from a worker lifecycle sequence', () => {
    const dash = new SwarmDashboardComponent('task', darkColors, undefined);
    dash.apply({ t: 'planned', total: 2 });
    dash.apply({ t: 'worker.spawned', id: 's1', role: 'Researcher' });
    dash.apply({ t: 'worker.toolcall', id: 's1', activity: workerActivityFromTool('Read', { path: 'a.ts' }) });
    dash.apply({ t: 'worker.done', id: 's1', tokens: 2100 });
    dash.apply({ t: 'worker.spawned', id: 's2', role: 'Analyst' });
    dash.apply({ t: 'worker.failed', id: 's2', error: 'timeout' });
    dash.apply({ t: 'done', succeeded: 1, failed: 1 });
    const out = strip(dash.render(80).join('\n'));
    expect(out).toContain('Researcher');
    expect(out).toContain('Analyst');
    expect(out).toContain('timeout');
    expect(out).toMatch(/2 workers/);
  });

  it('routes live swarm events through SessionEventHandler into the dashboard', () => {
    const parentToolCallId = 'tc-swarm';
    const dash = new SwarmDashboardComponent('task', darkColors, undefined);
    const mockHost = {
      streamingUI: {
        setTurnId: (): void => {},
        getSwarmDashboard: (id: string): SwarmDashboardComponent | undefined =>
          id === parentToolCallId ? dash : undefined,
        getToolComponent: (): undefined => undefined,
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
        subagentName: 'explore',
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
    expect(out).toMatch(/Workers 1\/1/);
  });
});
