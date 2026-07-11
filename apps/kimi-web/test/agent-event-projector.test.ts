import { describe, expect, it } from 'vitest';
import { classifyFrame, createAgentProjector, subagentProgressText } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent, type KimiClientState } from '../src/api/daemon/eventReducer';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import type { AppEvent } from '../src/api/types';

describe('subagentProgressText', () => {
  it('drops turn.step.started as noise', () => {
    expect(subagentProgressText('turn.step.started', {})).toBeNull();
  });

  it('summarizes a read tool call with its path', () => {
    const text = subagentProgressText('tool.use', { name: 'read', args: { path: 'src/foo.ts' } });
    expect(text).toContain('src/foo.ts');
    expect(text).not.toContain('"path"');
  });

  it('summarizes a bash tool call with its command', () => {
    const text = subagentProgressText('tool.call.started', { name: 'bash', args: { command: 'pnpm test' } });
    expect(text).toContain('pnpm test');
    expect(text).not.toContain('"command"');
  });

  it('drops tool.result lines as noise', () => {
    expect(subagentProgressText('tool.result', { name: 'read' })).toBeNull();
    expect(subagentProgressText('tool.result', { name: 'Read_0' })).toBeNull();
  });

  it('returns tool.progress update text', () => {
    expect(subagentProgressText('tool.progress', { update: { text: 'working…' } })).toBe('working…');
  });

  it('caps a long tool.progress text', () => {
    const long = 'x'.repeat(3000);
    const text = subagentProgressText('tool.progress', { update: { text: long } });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(long.length);
    expect(text!.endsWith('…')).toBe(true);
  });

  it('returns null for unknown event types', () => {
    expect(subagentProgressText('turn.delta', {})).toBeNull();
  });
});

describe('subagent streaming text', () => {
  it('forwards a subagent assistant.delta as a text-kind taskProgress', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: 'Hello' }, 's1');
    expect(events).toContainEqual({
      type: 'taskProgress',
      sessionId: 's1',
      taskId: 'sub-1',
      outputChunk: 'Hello',
      stream: 'stdout',
      kind: 'text',
    });
  });

  it('drops an empty subagent assistant.delta', () => {
    const projector = createAgentProjector();
    const events = projector.project('assistant.delta', { agentId: 'sub-1', delta: '' }, 's1');
    expect(events).toEqual([]);
  });
});

describe('cron.fired', () => {
  it('synthesizes a user message so the cron notice renders live', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'cron.fired',
      {
        origin: {
          kind: 'cron_job',
          jobId: 'a3f9c2',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 2,
          stale: false,
        },
        prompt: 'Check the deploy status',
      },
      's1',
    );
    const created = events.find((e) => e.type === 'messageCreated');
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      type: 'messageCreated',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Check the deploy status' }],
        metadata: { origin: { kind: 'cron_job', jobId: 'a3f9c2' } },
      },
    });
  });

  it('ignores cron.fired events missing a prompt or a cron_job origin', () => {
    const projector = createAgentProjector();
    expect(projector.project('cron.fired', { origin: { kind: 'cron_job' } }, 's1')).toEqual([]);
    expect(projector.project('cron.fired', { prompt: 'hi' }, 's1')).toEqual([]);
  });
});

describe('cron.fired prompt id isolation', () => {
  it('omits promptId so the synthesized notice does not clobber the abort cache', () => {
    const projector = createAgentProjector();
    projector.project(
      'prompt.submitted',
      { promptId: 'pr_user', userMessageId: 'u1', content: [{ type: 'text', text: 'hi' }] },
      's1',
    );
    const events = projector.project(
      'cron.fired',
      {
        origin: {
          kind: 'cron_job',
          jobId: 'j',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
        prompt: 'Check the deploy status',
      },
      's1',
    );
    const created = events.find((e) => e.type === 'messageCreated');
    expect(created).toBeDefined();
    expect((created as { message: { promptId?: string } }).message.promptId).toBeUndefined();
  });
});

describe('classifyFrame cron.fired', () => {
  it('routes both raw and event.-prefixed cron.fired to the agent projector', () => {
    const payload = { origin: { kind: 'cron_job' }, prompt: 'x' };
    expect(classifyFrame('cron.fired', payload)).toEqual({ route: 'agent', agentType: 'cron.fired' });
    expect(classifyFrame('event.cron.fired', payload)).toEqual({ route: 'agent', agentType: 'cron.fired' });
  });
});

// Session status has a single source: the daemon's event.session.status_changed
// (mapped by toAppEvent). The raw turn stream must NOT project a second
// sessionStatusChanged per transition — when it did, every turn end fired
// turn-end consumers (completion notification, sound) twice.
describe('session status single-sourcing', () => {
  it('turn.started projects no sessionStatusChanged', () => {
    const projector = createAgentProjector();
    const events = projector.project('turn.started', { turnId: 1 }, 's1');
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
  });

  it('turn.ended finalizes the message and usage but projects no sessionStatusChanged', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    const events = projector.project(
      'turn.ended',
      { turnId: 1, reason: 'completed', durationMs: 123 },
      's1',
    );
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'messageUpdated', status: 'completed', durationMs: 123 }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionUsageUpdated' }));
  });

  it('seedInFlight returns only the seeded message — status comes from the snapshot', () => {
    const projector = createAgentProjector();
    const events = projector.seedInFlight('s1', {
      turnId: 1,
      assistantText: 'partial',
      thinkingText: '',
      runningTools: [],
    });
    expect(events.some((e) => e.type === 'sessionStatusChanged')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'messageCreated',
        message: expect.objectContaining({ role: 'assistant' }),
      }),
    );
  });
});

// Delta offsets are step-relative: the daemon's InFlightTurnTracker resets its
// text accumulation at every turn.step.started (prior steps already live in the
// snapshot transcript), so the projector's local counters must reset in step
// with it.
describe('step-boundary delta alignment', () => {
  function applyAll(state: KimiClientState, events: AppEvent[], sid: string): KimiClientState {
    for (const event of events) state = reduceAppEvent(state, event, { sessionId: sid, seq: 1 });
    return state;
  }

  it('resets the offset baseline at turn.step.started', () => {
    const projector = createAgentProjector();
    projector.project('turn.started', { turnId: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 1 }, 's1');
    // Step 1 streams 50 chars.
    projector.project('assistant.delta', { turnId: 1, delta: 'x'.repeat(50) }, 's1', { offset: 0 });
    projector.project('turn.step.completed', { turnId: 1, step: 1 }, 's1');
    projector.project('turn.step.started', { turnId: 1, step: 2 }, 's1');
    // Step 2's first delta was lost in transit; the first one we see carries
    // offset 6. Without the step-boundary reset the local baseline is still 50
    // (step 1), so this delta — and every later delta of the step — would be
    // silently skipped as a duplicate. With the reset the offset is ahead of
    // local state: a recoverable gap that triggers a snapshot resync.
    const events = projector.project('assistant.delta', { turnId: 1, delta: 'tail' }, 's1', { offset: 6 });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'historyCompacted', reason: 'delta_gap' }),
    );
  });

  it('a snapshot resync mid-turn does not duplicate prior steps into a trailing blob', () => {
    const sid = 's1';
    const projector = createAgentProjector();
    let state = createInitialState();

    // A resync lands mid-turn (step 2 streaming). The client first replaces the
    // message log with the snapshot transcript — every COMPLETED step with full
    // structure (thinking + text + tool_use/tool_result), no prompt ids, exactly
    // as the REST snapshot serves them...
    state.messagesBySession[sid] = [
      {
        id: 'msg_s1_000000',
        sessionId: sid,
        role: 'user',
        content: [{ type: 'text', text: 'do the thing' }],
        createdAt: '2026-07-11T00:00:00.000Z',
      },
      {
        id: 'msg_s1_000001',
        sessionId: sid,
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'step one think' },
          { type: 'text', text: 'step one text' },
          { type: 'toolUse', toolCallId: 'Grep_0', toolName: 'Grep', input: { pattern: 'x' } },
        ],
        createdAt: '2026-07-11T00:00:01.000Z',
      },
      {
        id: 'msg_s1_000002',
        sessionId: sid,
        role: 'tool',
        content: [{ type: 'toolResult', toolCallId: 'Grep_0', output: 'found', isError: false }],
        createdAt: '2026-07-11T00:00:02.000Z',
      },
    ];

    // ...then seeds the in-flight turn, which (server-side) carries only the
    // CURRENT step's accumulated stream.
    const seedEvents = projector.seedInFlight(sid, {
      turnId: 1,
      assistantText: '',
      thinkingText: 'step two think so far',
      runningTools: [],
    });
    state = applyAll(state, seedEvents, sid);

    // The seeded message holds only step 2's thinking — prior steps' text must
    // not reappear inside it (that duplication was the giant trailing blob).
    const seeded = seedEvents.find((e) => e.type === 'messageCreated');
    expect(seeded).toBeDefined();
    const seededText = JSON.stringify((seeded as { message: unknown }).message);
    expect(seededText).not.toContain('step one text');
    expect(seededText).not.toContain('step one think');

    // The rendered turn keeps step 1's structured text + tool card and gains
    // step 2's thinking — no giant text block trailing after them.
    const turns = messagesToTurns(state.messagesBySession[sid] ?? [], [], undefined, true);
    const assistantTurns = turns.filter((t) => t.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    const turn = assistantTurns[0]!;
    expect(turn.tools?.map((t) => t.name)).toEqual(['Grep']);
    const textBlocks = (turn.blocks ?? []).filter((b) => b.kind === 'text');
    expect(textBlocks).toHaveLength(1);
    expect((textBlocks[0] as { kind: 'text'; text: string }).text).toBe('step one text');
  });
});
