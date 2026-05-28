import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DebugEventTracker,
  formatDebugEvent,
  getDebugLevel,
  isDebugEnabled,
  isRpcDebugEnabled,
} from '@/utils/debug';

describe('debug level helpers', () => {
  const original = process.env['KIMI_CODE_DEBUG'];

  beforeEach(() => {
    delete process.env['KIMI_CODE_DEBUG'];
  });

  afterEach(() => {
    if (original === undefined) delete process.env['KIMI_CODE_DEBUG'];
    else process.env['KIMI_CODE_DEBUG'] = original;
  });

  it('treats unset/0/garbage as level 0', () => {
    expect(getDebugLevel()).toBe(0);
    process.env['KIMI_CODE_DEBUG'] = '0';
    expect(getDebugLevel()).toBe(0);
    process.env['KIMI_CODE_DEBUG'] = 'true';
    expect(getDebugLevel()).toBe(0);
  });

  it('maps KIMI_CODE_DEBUG=1 to level 1', () => {
    process.env['KIMI_CODE_DEBUG'] = '1';
    expect(getDebugLevel()).toBe(1);
  });

  it('maps KIMI_CODE_DEBUG=2 to level 2', () => {
    process.env['KIMI_CODE_DEBUG'] = '2';
    expect(getDebugLevel()).toBe(2);
  });

  it('isDebugEnabled is true for any level >= 1', () => {
    expect(isDebugEnabled()).toBe(false);
    process.env['KIMI_CODE_DEBUG'] = '1';
    expect(isDebugEnabled()).toBe(true);
    process.env['KIMI_CODE_DEBUG'] = '2';
    expect(isDebugEnabled()).toBe(true);
  });

  it('isRpcDebugEnabled requires level >= 2', () => {
    expect(isRpcDebugEnabled()).toBe(false);
    process.env['KIMI_CODE_DEBUG'] = '1';
    expect(isRpcDebugEnabled()).toBe(false);
    process.env['KIMI_CODE_DEBUG'] = '2';
    expect(isRpcDebugEnabled()).toBe(true);
  });
});

describe('formatDebugEvent', () => {
  const at = new Date('2026-05-28T08:09:10.123Z');
  const ts = formatLocal(at);

  function head(line: string): string {
    return line.replace(` @ ${ts}`, '');
  }

  it('renders bare event type when there are no extra fields', () => {
    expect(head(formatDebugEvent({ type: 'compaction.cancelled' }, at))).toBe(
      'RPC Event: compaction.cancelled',
    );
  });

  it('turn.started includes origin', () => {
    expect(
      head(formatDebugEvent({ type: 'turn.started', turnId: 7, origin: 'user' }, at)),
    ).toBe('RPC Event: turn.started (turn=7, origin=user)');
  });

  it('turn.ended includes reason', () => {
    expect(
      head(formatDebugEvent({ type: 'turn.ended', turnId: 7, reason: 'completed' }, at)),
    ).toBe('RPC Event: turn.ended (turn=7, reason=completed)');
  });

  it('turn.step.started includes turn and step', () => {
    expect(
      head(formatDebugEvent({ type: 'turn.step.started', turnId: 7, step: 2 }, at)),
    ).toBe('RPC Event: turn.step.started (turn=7, step=2)');
  });

  it('turn.step.completed includes finishReason', () => {
    expect(
      head(
        formatDebugEvent(
          { type: 'turn.step.completed', turnId: 4, step: 1, finishReason: 'stop' },
          at,
        ),
      ),
    ).toBe('RPC Event: turn.step.completed (turn=4, step=1, finish=stop)');
  });

  it('turn.step.interrupted includes reason', () => {
    expect(
      head(
        formatDebugEvent(
          { type: 'turn.step.interrupted', turnId: 4, step: 1, reason: 'aborted' },
          at,
        ),
      ),
    ).toBe('RPC Event: turn.step.interrupted (turn=4, step=1, reason=aborted)');
  });

  it('turn.step.retrying includes attempt and delay', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'turn.step.retrying',
            turnId: 4,
            step: 1,
            failedAttempt: 1,
            nextAttempt: 2,
            maxAttempts: 3,
            delayMs: 1000,
            errorName: 'RateLimit',
            errorMessage: 'too many',
          },
          at,
        ),
      ),
    ).toBe(
      'RPC Event: turn.step.retrying (turn=4, step=1, attempt=2/3, delay=1000ms, error=RateLimit)',
    );
  });

  it('hook.result includes hook event and blocked flag', () => {
    expect(
      head(
        formatDebugEvent(
          { type: 'hook.result', turnId: 1, hookEvent: 'PreToolUse', content: 'ok', blocked: true },
          at,
        ),
      ),
    ).toBe('RPC Event: hook.result (turn=1, hook=PreToolUse, blocked=true)');
  });

  it('tool.call.started includes name, id and args JSON', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'tool.call.started',
            turnId: 3,
            toolCallId: 'c1',
            name: 'bash',
            args: { command: 'ls' },
          },
          at,
        ),
      ),
    ).toBe(
      'RPC Event: tool.call.started (turn=3, tool=bash, id=c1, args={"command":"ls"})',
    );
  });

  it('tool.call.started truncates long args', () => {
    const long = 'x'.repeat(200);
    const line = head(
      formatDebugEvent(
        {
          type: 'tool.call.started',
          turnId: 3,
          toolCallId: 'c1',
          name: 'bash',
          args: { command: long },
        },
        at,
      ),
    );
    expect(line).toMatch(/args=.{1,100}\.\.\.\)$/);
  });

  it('tool.progress includes update kind', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'tool.progress',
            turnId: 1,
            toolCallId: 'c1',
            update: { kind: 'stdout', text: 'hi' },
          },
          at,
        ),
      ),
    ).toBe('RPC Event: tool.progress (turn=1, id=c1, kind=stdout)');
  });

  it('tool.result includes id and isError', () => {
    expect(
      head(
        formatDebugEvent(
          { type: 'tool.result', turnId: 1, toolCallId: 'c1', output: '...', isError: true },
          at,
        ),
      ),
    ).toBe('RPC Event: tool.result (turn=1, id=c1, error=true)');
  });

  it('skill.activated includes skill and trigger', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'skill.activated',
            activationId: 'a1',
            skillName: 'plan',
            trigger: 'user-slash',
          },
          at,
        ),
      ),
    ).toBe('RPC Event: skill.activated (skill=plan, trigger=user-slash)');
  });

  it('agent.status.updated includes model and context usage', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'agent.status.updated',
            model: 'k2',
            contextTokens: 1000,
            maxContextTokens: 200000,
          },
          at,
        ),
      ),
    ).toBe('RPC Event: agent.status.updated (model=k2, ctx=1000/200000)');
  });

  it('session.meta.updated includes title when present', () => {
    expect(
      head(formatDebugEvent({ type: 'session.meta.updated', title: 'hi' }, at)),
    ).toBe('RPC Event: session.meta.updated (title="hi")');
  });

  it('error includes message', () => {
    expect(
      head(formatDebugEvent({ type: 'error', message: 'boom', code: 'X' }, at)),
    ).toBe('RPC Event: error (code=X, message="boom")');
  });

  it('warning includes message', () => {
    expect(
      head(formatDebugEvent({ type: 'warning', message: 'careful', code: 'X' }, at)),
    ).toBe('RPC Event: warning (code=X, message="careful")');
  });

  it('subagent.spawned includes subagent and background flag', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'subagent.spawned',
            subagentId: 'a1',
            subagentName: 'Plan',
            parentToolCallId: 't1',
            runInBackground: true,
          },
          at,
        ),
      ),
    ).toBe('RPC Event: subagent.spawned (subagent=a1, name=Plan, bg=true)');
  });

  it('subagent.failed includes error', () => {
    expect(
      head(
        formatDebugEvent(
          { type: 'subagent.failed', subagentId: 'a1', parentToolCallId: 't1', error: 'oops' },
          at,
        ),
      ),
    ).toBe('RPC Event: subagent.failed (subagent=a1, error="oops")');
  });

  it('compaction.started includes trigger', () => {
    expect(
      head(formatDebugEvent({ type: 'compaction.started', trigger: 'auto' }, at)),
    ).toBe('RPC Event: compaction.started (trigger=auto)');
  });

  it('compaction.completed includes counts and token diff', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'compaction.completed',
            result: {
              summary: 's',
              compactedCount: 10,
              tokensBefore: 1000,
              tokensAfter: 500,
            },
          },
          at,
        ),
      ),
    ).toBe('RPC Event: compaction.completed (compacted=10, tokens=1000->500)');
  });

  it('background.task.started includes task id and status', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'background.task.started',
            info: {
              taskId: 'bash-abc',
              status: 'running',
              command: 'ls',
              description: 'd',
              pid: 1,
              exitCode: null,
              startedAt: 0,
              endedAt: null,
            },
          },
          at,
        ),
      ),
    ).toBe('RPC Event: background.task.started (task=bash-abc, status=running)');
  });

  it('tool.list.updated includes reason and server', () => {
    expect(
      head(
        formatDebugEvent(
          { type: 'tool.list.updated', reason: 'mcp.connected', serverName: 'foo' },
          at,
        ),
      ),
    ).toBe('RPC Event: tool.list.updated (reason=mcp.connected, server=foo)');
  });

  it('mcp.server.status includes server name and status', () => {
    expect(
      head(
        formatDebugEvent(
          {
            type: 'mcp.server.status',
            server: {
              name: 'foo',
              transport: 'stdio',
              status: 'connected',
              toolCount: 3,
            },
          },
          at,
        ),
      ),
    ).toBe('RPC Event: mcp.server.status (server=foo, status=connected)');
  });

  it('uses millisecond precision and zero-pads each component', () => {
    const t = new Date(2026, 0, 1, 3, 4, 5, 7);
    expect(formatDebugEvent({ type: 'turn.started', turnId: 1, origin: 'user' }, t)).toBe(
      'RPC Event: turn.started (turn=1, origin=user) @ 03:04:05.007',
    );
  });

  it('defaults to the current wall clock when no time is supplied', () => {
    const line = formatDebugEvent({ type: 'compaction.cancelled' });
    expect(line).toMatch(/^RPC Event: compaction\.cancelled @ \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

function formatLocal(d: Date): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

describe('DebugEventTracker', () => {
  it('never emits delta events', () => {
    const tracker = new DebugEventTracker();
    expect(tracker.shouldEmit({ type: 'assistant.delta', turnId: 1, delta: 'a' })).toBe(false);
    expect(tracker.shouldEmit({ type: 'thinking.delta', turnId: 1, delta: 'a' })).toBe(false);
    expect(
      tracker.shouldEmit({
        type: 'tool.call.delta',
        turnId: 1,
        toolCallId: 'c1',
        argumentsPart: '{',
      }),
    ).toBe(false);
  });

  it('always emits non-delta events', () => {
    const tracker = new DebugEventTracker();
    const ev = { type: 'turn.started', turnId: 1, origin: 'user' } as const;
    expect(tracker.shouldEmit(ev)).toBe(true);
    expect(tracker.shouldEmit(ev)).toBe(true);
  });
});
