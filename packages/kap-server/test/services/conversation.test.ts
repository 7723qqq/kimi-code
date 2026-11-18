import { describe, expect, it, spyOn } from 'bun:test';

import { isRealUserInput, type ContextMessage } from '@moonshot-ai/agent-core-v2';

import {
  applyMessage,
  createConversationState,
  openTurn,
} from '../../src/services/conversation/conversationFold';

function fold(messages: readonly ContextMessage[]): ReturnType<typeof createConversationState> {
  const state = createConversationState('main');
  let time = 0;
  for (const message of messages) {
    if (isRealUserInput(message)) state.pendingPrompt = { promptId: message.id };
    applyMessage(state, message, (time += 1_000));
  }
  return state;
}

function user(
  id: string | undefined,
  text: string,
  origin?: ContextMessage['origin'],
): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], id, origin };
}

function assistant(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function itemsOf(state: ReturnType<typeof createConversationState>) {
  return state.turns.flatMap((turn) => turn.items);
}

describe('conversation fold reasoning timing', () => {
  it('takes the duration a context message carries for its reasoning part', () => {
    const state = createConversationState('main');
    applyMessage(state, { role: 'user', content: [{ type: 'text', text: 'think' }], toolCalls: [], id: 'p1', origin: { kind: 'user' } }, 1_000);
    applyMessage(
      state,
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'plan' }, { type: 'text', text: 'answer' }],
        toolCalls: [],
        contentTimings: [{ startedAt: 4_000, durationMs: 2_500 }],
      },
      2_000,
    );

    const items = state.turns.flatMap((turn) => turn.items);
    const reasoning = items.find((item) => item.type === 'reasoning');
    expect(reasoning).toMatchObject({ text: 'plan', duration_ms: 2_500, started_at: new Date(4_000).toISOString() });
    const message = items.find((item) => item.type === 'assistant_message');
    expect(message).not.toHaveProperty('duration_ms', expect.anything());
  });
});

describe('conversation fold tool notes', () => {
  it('keeps the note of a tool result beside its output', () => {
    const note =
      'Read image file. Mime type: image/png. Size: 1234 bytes. Original dimensions: 640x480 pixels.';
    const state = createConversationState('main');
    applyMessage(
      state,
      { role: 'user', content: [{ type: 'text', text: 'look' }], toolCalls: [], id: 'p1', origin: { kind: 'user' } },
      1_000,
    );
    applyMessage(
      state,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        toolCalls: [{ type: 'function', id: 'ReadMediaFile_0', name: 'ReadMediaFile', arguments: '{}' }],
      },
      2_000,
    );
    applyMessage(
      state,
      {
        role: 'tool',
        content: [{ type: 'text', text: '<image path="/tmp/a.png"></image>' }],
        toolCalls: [],
        toolCallId: 'ReadMediaFile_0',
        note,
      },
      3_000,
    );

    const item = state.turns
      .flatMap((turn) => turn.items)
      .find((candidate) => candidate.type === 'tool_call' && candidate.item_id === 'ReadMediaFile_0');
    expect(item).toMatchObject({
      outcome: 'completed',
      output: '<image path="/tmp/a.png"></image>',
      note,
    });
  });
});

describe('conversation fold cron prompts', () => {
  it('shows only the scheduled prompt from a cron-fire envelope', () => {
    const state = createConversationState('main');
    applyMessage(
      state,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<cron-fire jobId="job-1" cron="0 3 * * *" recurring="true" coalescedCount="2" stale="false">\n<prompt>\nnightly report\n</prompt>\n</cron-fire>',
          },
        ],
        toolCalls: [],
        id: 'cron-1',
        origin: {
          kind: 'cron_job',
          jobId: 'job-1',
          cron: '0 3 * * *',
          recurring: true,
          coalescedCount: 2,
          stale: false,
        },
      },
      1_000,
    );

    const item = state.turns
      .flatMap((turn) => turn.items)
      .find((candidate) => candidate.type === 'user_message');
    expect(item).toMatchObject({
      text: 'nightly report',
      origin: {
        kind: 'cron',
        job_id: 'job-1',
        schedule: '0 3 * * *',
        recurring: true,
        coalesced_count: 2,
        stale: false,
      },
    });
  });

  it('unwraps only a complete cron-fire envelope', () => {
    const state = createConversationState('main');
    applyMessage(
      state,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<cron-fire jobId="job-3" cron="0 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\nSummarize:\n<prompt>\ninner\n</prompt>\n</prompt>\n</cron-fire>',
          },
        ],
        toolCalls: [],
        id: 'cron-nested',
        origin: {
          kind: 'cron_job',
          jobId: 'job-3',
          cron: '0 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
      1_000,
    );
    applyMessage(
      state,
      {
        role: 'user',
        content: [{ type: 'text', text: '<cron-fire jobId="job-4" cron="0 * * * *">\n<prompt>\nunclosed' }],
        toolCalls: [],
        id: 'cron-malformed',
        origin: {
          kind: 'cron_job',
          jobId: 'job-4',
          cron: '0 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
      2_000,
    );

    const items = state.turns.flatMap((turn) => turn.items);
    const nested = items.find((candidate) => candidate.type === 'user_message' && candidate.item_id === 'cron-nested');
    expect(nested).toMatchObject({ text: 'Summarize:\n<prompt>\ninner\n</prompt>' });
    const malformed = items.find((candidate) => candidate.type === 'user_message' && candidate.item_id === 'cron-malformed');
    expect(malformed).toMatchObject({ text: '<cron-fire jobId="job-4" cron="0 * * * *">\n<prompt>\nunclosed' });
  });
});

describe('conversation fold user messages', () => {
  it('keeps visible text, attachments, skills and client metadata without server paths', () => {
    const state = fold([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<skill name="review">instructions</skill>',
            meta: { source: 'skill activation', activationId: 'skill-a1' },
          },
          { type: 'text', text: 'look at this' },
          {
            type: 'text',
            text: 'Attached file "a.ts" (text/plain, 12 bytes): /tmp/a.ts — open it with the Read tool',
          },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
        toolCalls: [],
        id: 'p1',
        origin: {
          kind: 'user',
          skillActivations: [
            { activationId: 'skill-a1', skillName: 'review', skillPath: '/skills/review', skillArgs: '123' },
          ],
          clientMetadata: [{ trace: 't1' }],
        },
      },
    ]);

    const item = itemsOf(state).find((candidate) => candidate.type === 'user_message');
    expect(item).toMatchObject({
      item_id: 'p1',
      placement: 'opener',
      text: 'look at this',
      prompt_ids: ['p1'],
      skills: [{ name: 'review', args: '123' }],
      metadata: { trace: 't1' },
      attachments: [
        { kind: 'file', name: 'a.ts', media_type: 'text/plain', size: 12, ordinal: 1 },
        { kind: 'image', ordinal: 2 },
      ],
    });
    expect(JSON.stringify(item)).not.toContain('/tmp/a.ts');
  });

  it('maps engine origins and only client-submitted inputs keep prompt ids', () => {
    const cases: Array<[ContextMessage['origin'], string, readonly string[], string]> = [
      [{ kind: 'user' }, 'user', ['p1'], 'hello'],
      [
        {
          kind: 'skill_activation',
          activationId: 'a1',
          skillName: 'review',
          skillArgs: 'x',
          trigger: 'user-slash',
        },
        'skill',
        ['p1'],
        'hello',
      ],
      [
        {
          kind: 'plugin_command',
          activationId: 'a2',
          pluginId: 'plug',
          commandName: 'run',
          commandArgs: 'y',
          trigger: 'user-slash',
        },
        'plugin_command',
        ['p1'],
        'hello',
      ],
      [{ kind: 'hook_result', event: 'SessionStart' }, 'hook', [], 'hello'],
      [
        { kind: 'cron_job', jobId: 'j1', cron: '0 3 * * *', recurring: true, coalescedCount: 1, stale: false },
        'cron',
        [],
        'hello',
      ],
      [{ kind: 'system_trigger', name: 'goal_continuation' }, 'goal', [], ''],
      [{ kind: 'system_trigger', name: 'subagent' }, 'system', [], 'hello'],
      [{ kind: 'shell_command', phase: 'output' }, 'system', [], 'hello'],
    ];

    for (const [origin, kind, promptIds, text] of cases) {
      const state = fold([user('p1', 'hello', origin)]);
      const item = itemsOf(state).find((candidate) => candidate.type === 'user_message');
      expect(item).toMatchObject({ origin: { kind }, prompt_ids: [...promptIds], text });
    }

    expect(itemsOf(fold([user('p1', 'retry me', { kind: 'retry' })]))).toEqual([]);

    const hidden = fold([user('p1', 'hidden', { kind: 'injection', variant: 'notice' })]);
    expect(itemsOf(hidden)).toEqual([]);
  });
});

describe('conversation fold turn placement', () => {
  it('keeps task notifications in the running turn and opens a turn when none runs', () => {
    const running = fold([
      user('p1', 'work'),
      assistant('busy'),
      user('n1', 'task finished', {
        kind: 'task',
        taskId: 't1',
        status: 'completed',
        notificationId: 'n1',
      }),
    ]);
    const runningTurn = running.turns[0]!;
    expect(runningTurn.status).toBe('running');
    expect(runningTurn.items.filter((item) => item.type === 'notification')).toHaveLength(1);

    const idle = createConversationState('main');
    applyMessage(
      idle,
      user('n2', 'another task finished', {
        kind: 'task',
        taskId: 't2',
        status: 'completed',
        notificationId: 'n2',
      }),
      1_000,
    );
    expect(idle.turns).toHaveLength(1);
    expect(idle.turns[0]).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(idle.turns[0]!.items[0]).toMatchObject({ type: 'notification', item_id: 'n2' });
  });

  it('lands an ownerless message beside a running turn without closing it', () => {
    const state = fold([user('p1', 'work'), assistant('busy')]);
    const openBefore = openTurn(state)?.turn_id;

    applyMessage(state, user(undefined, 'child result', { kind: 'system_trigger', name: 'subagent' }), 5_000);

    expect(state.turns).toHaveLength(2);
    expect(openTurn(state)?.turn_id).toBe(openBefore);
    expect(state.turns[1]).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(state.turns[1]!.items[0]).toMatchObject({ type: 'user_message', text: 'child result' });
  });

  it('folds legacy assistant and tool messages into one turn', () => {
    const state = fold([
      user('p1', 'run it'),
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'plan' }, { type: 'text', text: 'running' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Bash', arguments: '{"command":"ls"}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'a.ts' }], toolCalls: [], toolCallId: 'c1' },
    ]);

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]!.items).toEqual([
      expect.objectContaining({ type: 'user_message', text: 'run it' }),
      expect.objectContaining({ type: 'reasoning', text: 'plan' }),
      expect.objectContaining({ type: 'assistant_message', text: 'running' }),
      expect.objectContaining({
        type: 'tool_call',
        item_id: 'c1',
        input: { command: 'ls' },
        output: 'a.ts',
        outcome: 'completed',
      }),
    ]);
  });
});

describe('conversation fold identity and undo', () => {
  it('keeps turn ids stable when the same context is folded again', () => {
    const build = () => fold([user('p1', 'one'), assistant('first')]);
    expect(build().turns[0]!.turn_id).toBe(build().turns[0]!.turn_id);
  });

  it('anchors undo at the real user input that opens each turn', () => {
    const state = fold([
      user('p1', 'one'),
      assistant('first'),
      user('p2', 'two'),
      assistant('second'),
    ]);

    expect(state.anchors.map((anchor) => anchor.turnId)).toEqual(
      state.turns.map((turn) => turn.turn_id),
    );
    expect(state.anchors.every((anchor) => anchor.itemCount === 0)).toBe(true);
  });
});

describe('conversation fold tool lookup', () => {
  it('updates tool results and duplicate calls without scanning the item array', () => {
    const state = fold([
      user('p1', 'run tools'),
      {
        role: 'assistant', content: [],
        toolCalls: Array.from({ length: 1000 }, (_,i) => ({ type: 'function' as const, id: `c${i}`, name: 'Read', arguments: '{}' })),
      },
    ]);
    const items = state.turns[0]!.items;
    const find = spyOn(items, 'find');
    const findIndex = spyOn(items, 'findIndex');
    try {
      applyMessage(state, { role: 'tool', toolCallId: 'c999', content: [{ type: 'text', text: 'done' }], toolCalls: [] }, 4000);
      applyMessage(state, { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c998', name: 'Read', arguments: '{"path":"a"}' }] }, 5000);
      expect(find).not.toHaveBeenCalled();
      expect(findIndex).not.toHaveBeenCalled();
      expect(items).toHaveLength(1001);
      expect(items[999]).toMatchObject({ item_id: 'c998', input: { path: 'a' } });
      expect(items[1000]).toMatchObject({ item_id: 'c999', output: 'done', outcome: 'completed' });
    } finally {
      find.mockRestore();
      findIndex.mockRestore();
    }
  });

  it('keeps duplicate tool ids scoped to their latest turn', () => {
    const call: ContextMessage = { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c1', name: 'Read', arguments: '{}' }] };
    const state = fold([user('p1', 'first'), call, user('p2', 'second'), call]);
    applyMessage(state, { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'second result' }], toolCalls: [] }, 5000);
    expect(state.turns[0]!.items[1]).not.toHaveProperty('output');
    expect(state.turns[1]!.items[1]).toMatchObject({ output: 'second result', outcome: 'completed' });
  });
});
