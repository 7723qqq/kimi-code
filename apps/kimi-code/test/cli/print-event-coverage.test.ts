import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  toActivityMessage,
  toNotificationMessage,
  toolProgressMessage,
} from '#/cli/run-prompt';

/**
 * Print-mode stream-json event coverage.
 *
 * `STREAM_JSON_ROUTE` classifies EVERY protocol event into how `kimi -p
 * --output-format stream-json` treats it. Because the table is typed as
 * `Record<Event['type'], StreamJsonRoute>`, adding a new event type to the
 * protocol makes this file fail `pnpm typecheck` until the new event is
 * explicitly classified — so print mode can never silently drop a new event.
 *
 * The runtime test then checks that the `notification` / `activity` /
 * `tool_progress` rows actually match the mappers in `run-prompt.ts`, so a row
 * marked "emitted" can't drift away from the code that emits it.
 */
type StreamJsonRoute =
  | 'assistant' // assistant.delta / hook.result -> assistant message content
  | 'thinking' // thinking.delta -> {"role":"assistant","type":"thinking"}
  | 'tool_call' // tool.call.started/delta -> assistant tool_calls
  | 'tool_result' // tool.result -> {"role":"tool"}
  | 'tool_progress' // tool.progress -> {"type":"tool_progress"}
  | 'notification' // background.task.* / cron.fired -> {"type":"notification"}
  | 'activity' // subagent / warning / skill / mcp / compaction / goal / agent-status / tool-list
  | 'error' // error / failed turn.ended -> {"type":"error"}
  | 'turn_control' // turn lifecycle: drives flush/finish, not a data line of its own
  | 'ignored'; // intentionally not surfaced (interactive-only or daemon/session-level)

const STREAM_JSON_ROUTE: Record<Event['type'], StreamJsonRoute> = {
  // Conversation
  'assistant.delta': 'assistant',
  'hook.result': 'assistant',
  'thinking.delta': 'thinking',
  'tool.call.started': 'tool_call',
  'tool.call.delta': 'tool_call',
  'tool.result': 'tool_result',
  'tool.progress': 'tool_progress',
  error: 'error',

  // Notifications
  'background.task.started': 'notification',
  'background.task.terminated': 'notification',
  'cron.fired': 'notification',

  // Activity layer
  warning: 'activity',
  'agent.status.updated': 'activity',
  'goal.updated': 'activity',
  'skill.activated': 'activity',
  'tool.list.updated': 'activity',
  'mcp.server.status': 'activity',
  'subagent.spawned': 'activity',
  'subagent.started': 'activity',
  'subagent.suspended': 'activity',
  'subagent.completed': 'activity',
  'subagent.failed': 'activity',
  'compaction.started': 'activity',
  'compaction.blocked': 'activity',
  'compaction.cancelled': 'activity',
  'compaction.completed': 'activity',

  // Turn lifecycle (control, not a data line)
  'turn.started': 'turn_control',
  'turn.ended': 'turn_control',
  'turn.step.started': 'turn_control',
  'turn.step.interrupted': 'turn_control',
  'turn.step.retrying': 'turn_control',

  // Intentionally not surfaced in print mode
  'turn.step.completed': 'ignored',
  'session.meta.updated': 'ignored',
  'shell.output': 'ignored', // interactive `!` shell only
  'shell.started': 'ignored', // interactive `!` shell only
  'prompt.submitted': 'ignored',
  'event.config.changed': 'ignored',
  'event.session.created': 'ignored',
  'event.session.status_changed': 'ignored',
  'event.workspace.created': 'ignored',
  'event.workspace.updated': 'ignored',
  'event.workspace.deleted': 'ignored',
};

const ev = (value: unknown): Event => value as Event;

const bgInfo = (status: string) => ({
  taskId: 'b1',
  kind: 'process',
  status,
  description: 'build',
  startedAt: 0,
  endedAt: status === 'running' ? null : 1,
});

/** Sample events for the rows handled by the standalone session-level mappers. */
const SAMPLES: Partial<Record<Event['type'], Event>> = {
  'background.task.started': ev({ type: 'background.task.started', info: bgInfo('running') }),
  'background.task.terminated': ev({
    type: 'background.task.terminated',
    info: bgInfo('completed'),
  }),
  'cron.fired': ev({ type: 'cron.fired', prompt: 'tick' }),
  warning: ev({ type: 'warning', message: 'heads up' }),
  'agent.status.updated': ev({ type: 'agent.status.updated', model: 'k2' }),
  'goal.updated': ev({ type: 'goal.updated', snapshot: null }),
  'skill.activated': ev({ type: 'skill.activated', skillName: 'deploy', trigger: 'model-tool' }),
  'tool.list.updated': ev({ type: 'tool.list.updated', reason: 'mcp.connected', serverName: 'fs' }),
  'mcp.server.status': ev({
    type: 'mcp.server.status',
    server: { name: 'fs', status: 'connected', transport: 'stdio', toolCount: 0 },
  }),
  'subagent.spawned': ev({
    type: 'subagent.spawned',
    subagentId: 'a1',
    subagentName: 'researcher',
    runInBackground: false,
  }),
  'subagent.started': ev({ type: 'subagent.started', subagentId: 'a1' }),
  'subagent.suspended': ev({ type: 'subagent.suspended', subagentId: 'a1', reason: 'paused' }),
  'subagent.completed': ev({ type: 'subagent.completed', subagentId: 'a1', resultSummary: 'ok' }),
  'subagent.failed': ev({ type: 'subagent.failed', subagentId: 'a1', error: 'boom' }),
  'compaction.started': ev({ type: 'compaction.started', trigger: 'auto' }),
  'compaction.blocked': ev({ type: 'compaction.blocked' }),
  'compaction.cancelled': ev({ type: 'compaction.cancelled' }),
  'compaction.completed': ev({
    type: 'compaction.completed',
    result: { summary: '', compactedCount: 2, tokensBefore: 10, tokensAfter: 4 },
  }),
  'tool.progress': ev({
    type: 'tool.progress',
    toolCallId: 'tc_1',
    update: { kind: 'stdout', text: 'x' },
  }),
};

describe('print-mode stream-json event coverage', () => {
  it('classifies every protocol event type (compile-time exhaustiveness)', () => {
    // The Record above is the real guarantee (typecheck fails on an unclassified
    // new event); this asserts every value is a known route as a sanity check.
    const routes = new Set<StreamJsonRoute>([
      'assistant',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_progress',
      'notification',
      'activity',
      'error',
      'turn_control',
      'ignored',
    ]);
    for (const route of Object.values(STREAM_JSON_ROUTE)) {
      expect(routes.has(route)).toBe(true);
    }
  });

  it('keeps the notification / activity / tool_progress rows in sync with the mappers', () => {
    const mismatches: string[] = [];
    for (const type of Object.keys(STREAM_JSON_ROUTE) as Event['type'][]) {
      const route = STREAM_JSON_ROUTE[type];
      const sample = SAMPLES[type] ?? ev({ type });
      const isNotification = toNotificationMessage(sample) !== undefined;
      const isActivity = toActivityMessage(sample) !== undefined;

      if (isNotification !== (route === 'notification')) {
        mismatches.push(`${type}: toNotificationMessage=${isNotification}, route=${route}`);
      }
      if (isActivity !== (route === 'activity')) {
        mismatches.push(`${type}: toActivityMessage=${isActivity}, route=${route}`);
      }
      if (route === 'tool_progress') {
        const progress = toolProgressMessage(sample as Extract<Event, { type: 'tool.progress' }>);
        if (progress['type'] !== 'tool_progress') {
          mismatches.push(`${type}: toolProgressMessage did not produce a tool_progress line`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
